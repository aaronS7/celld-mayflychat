import { DurableObject } from 'cloudflare:workers';
import { b64, bearerHash, canonicalID, failure, HTTPError, json, plain, sourceIP, unb64, readBody } from './protocol';
import { acceptsHTML, render } from './pages';
import { attachmentType, bodyJSON, byteLength, commentAnchor, id, label, matchQuery, pageInput, pageSize, positive, revision,
  searchInput, sections, text, wikiLimits, wikiSettings, type CommentAnchor, type PageInput, type SearchInput, type WikiSettingsEnv } from './wiki-core';
import { rankPassages, relevanceVersion, type SearchHit } from './wiki-search';
import { clearSpaceLinks, spaceLinks } from './space-links';
import { SummaryLimiter, summaryClip, summaryLimits, summaryRequest, summarySettings, streamSummary, type SummaryEnv } from './summaries';
import { WikiExporter } from './wiki-export';

export interface WikiEnv extends WikiSettingsEnv, SummaryEnv {
  WIKIS: DurableObjectNamespace<Wiki>;
  WIKI_CREATION: DurableObjectNamespace<WikiCreationGate>;
  WIKI_FILES?: R2Bucket;
  TRUST_PROXY?: string;
}
type Meta = { id: string; title: string; auth: ArrayBuffer; version: number; bytes: number; attachment_bytes: number; deleted: number };
type PageRow = { id: string; path: string; title: string; markdown: string; parent_id: string | null; aliases: string; tags: string;
  author: string; revision: number; deleted: number; created_at: string; updated_at: string };
type PageLink = Pick<PageRow, 'id' | 'path' | 'title' | 'parent_id'>;
type CommentRow = { id: string; page_id: string; parent_id: string | null; body: string; author: string; anchor: string;
  revision: number; resolved: number; created_at: string; updated_at: string; seq: number };
type Attachment = { id: string; key: string; name: string; type: string; size: number; status: string; created: number };
type SearchResult = { version: number; mode: 'keyword' | 'relevance'; fallback?: string; results: SearchHit[] };
const now = () => new Date().toISOString();
const notFound = () => new HTTPError(404, 'Wiki or resource not found');
const conflict = (current: number) => json({ error: 'Revision changed; read the current version before retrying.', code: 'revision_conflict', current_revision: current }, 412);
function pageValue(row: PageRow) {
  return { ...row, deleted: Boolean(row.deleted), aliases: JSON.parse(row.aliases) as string[], tags: JSON.parse(row.tags) as string[] };
}
function pageResponse(value: ReturnType<typeof pageValue>, status = 200) {
  const headings = [...new Map(sections(value.markdown).filter(s => s.level).map(s => [s.section, { section: s.section, heading: s.heading, level: s.level }])).values()];
  const response = json({ ...value, sections: headings }, status);
  response.headers.set('ETag', `"${value.revision}"`);
  return response;
}

export class Wiki extends DurableObject<WikiEnv> {
  private sql: SqlStorage;
  private initialized: boolean;
  private cache = new Map<string, SearchHit[]>();
  private searches = new Map<string, Promise<SearchHit[] | null>>();
  private uploads = 0;
  private summaries = new SummaryLimiter();
  private exporter: WikiExporter;
  constructor(ctx: DurableObjectState, env: WikiEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.exporter = new WikiExporter(this.sql, () => this.meta(), () => this.env.WIKI_FILES);
    this.initialized = !!this.sql.exec("SELECT 1 FROM sqlite_master WHERE name='wiki'").toArray().length;
  }
  private meta(): Meta {
    const row = this.initialized ? this.sql.exec<Meta>('SELECT * FROM wiki WHERE singleton=1').toArray()[0] : undefined;
    if (!row || row.deleted) throw notFound();
    return row;
  }
  private authorize(hash: Uint8Array | undefined): Meta {
    const row = this.meta();
    if (!hash || !crypto.subtle.timingSafeEqual(hash, row.auth)) throw new HTTPError(401, 'Missing or wrong wiki bearer');
    return row;
  }
  private page(pageID: string, deleted = false): PageRow {
    const row = this.sql.exec<PageRow>('SELECT * FROM pages WHERE id=?', pageID).toArray()[0];
    if (!row || (row.deleted && !deleted)) throw notFound();
    return row;
  }
  private navigation(page: PageRow) {
    const summary = ({ id, path, title, parent_id }: PageLink): PageLink => ({ id, path, title, parent_id });
    const ancestor = (pageID: string) => {
      const row = this.sql.exec<PageLink>('SELECT id,path,title,parent_id FROM pages WHERE id=? AND deleted=0', pageID).toArray()[0];
      if (!row) throw notFound();
      return row;
    };
    // Bounded depth-first navigation uses the existing parent/path index. It
    // never downloads all page bodies or scans a 10,000-page manifest.
    const edge = (parent: string | null, direction: 'ASC' | 'DESC'): PageLink | undefined => this.sql.exec<PageLink>(
      `SELECT id,path,title,parent_id FROM pages WHERE deleted=0 AND parent_id IS ? ORDER BY path ${direction} LIMIT 1`, parent).toArray()[0];
    const sibling = (row: PageLink, direction: 'ASC' | 'DESC'): PageLink | undefined => this.sql.exec<PageLink>(
      `SELECT id,path,title,parent_id FROM pages WHERE deleted=0 AND parent_id IS ? AND path${direction === 'ASC' ? '>' : '<'}? ORDER BY path ${direction} LIMIT 1`, row.parent_id, row.path).toArray()[0];
    const ancestors: PageLink[] = [];
    let parent = page.parent_id;
    while (parent && ancestors.length < 32) { const row = ancestor(parent); ancestors.unshift(row); parent = row.parent_id; }
    let previous = sibling(page, 'DESC');
    if (previous) for (let depth = 0; depth < 32; depth++) { const child = edge(previous.id, 'DESC'); if (!child) break; previous = child; }
    else previous = ancestors.at(-1);
    let next = edge(page.id, 'ASC');
    if (!next) for (const row of [summary(page), ...ancestors.slice().reverse()]) { next = sibling(row, 'ASC'); if (next) break; }
    return { page_id: page.id, ancestors, previous: previous ?? null, next: next ?? null };
  }
  private change(kind: string, pageID: string | null, rev: number | null): number {
    this.cache.clear();
    const seq = this.sql.exec<{ version: number }>('UPDATE wiki SET version=version+1 WHERE singleton=1 RETURNING version').one().version;
    this.sql.exec('INSERT INTO changes VALUES (?,?,?,?,?)', seq, kind, pageID, rev, now());
    return seq;
  }
  private charge(bytes: number) {
    if (this.meta().bytes + bytes > wikiLimits.historyBytes) throw new HTTPError(429, 'Wiki content and revision budget reached (1 GiB)');
    this.sql.exec('UPDATE wiki SET bytes=bytes+? WHERE singleton=1', bytes);
  }
  private parent(pageID: string, parent: string | null) {
    let current = parent, depth = 0;
    for (; current; depth++) {
      if (current === pageID || depth >= 32) throw new HTTPError(400, 'Page hierarchy must be acyclic and at most 32 levels deep');
      current = this.page(current).parent_id;
    }
    const below = this.sql.exec<{ depth: number | null }>(`WITH RECURSIVE descendants(id,depth) AS (
      SELECT id,0 FROM pages WHERE id=? UNION ALL SELECT p.id,d.depth+1 FROM pages p JOIN descendants d ON p.parent_id=d.id WHERE p.deleted=0
    ) SELECT max(depth) depth FROM descendants`, pageID).one().depth ?? 0;
    if (depth + below > 32) throw new HTTPError(400, 'Moving this subtree would exceed 32 parent levels');
  }
  private save(pageID: string, value: PageInput, old?: PageRow, deleted = false): PageRow {
    this.parent(pageID, value.parent_id);
    const duplicate = this.sql.exec<{ id: string }>('SELECT id FROM pages WHERE path=? AND id<>?', value.path, pageID).toArray()[0];
    if (duplicate) throw new HTTPError(409, 'A page already owns this path, including its history');
    const row: PageRow = { ...value, aliases: JSON.stringify(value.aliases), tags: JSON.stringify(value.tags), id: pageID,
      revision: (old?.revision ?? 0) + 1, deleted: Number(deleted), created_at: old?.created_at ?? now(), updated_at: now() };
    const snapshot = JSON.stringify(pageValue(row));
    this.charge(byteLength(snapshot));
    this.sql.exec('INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', row.id, row.path, row.title, row.markdown, row.parent_id,
      row.aliases, row.tags, row.author, row.revision, row.deleted, row.created_at, row.updated_at);
    this.sql.exec('INSERT INTO revisions VALUES (?,?,?)', pageID, row.revision, snapshot);
    this.sql.exec('DELETE FROM wiki_search WHERE rowid IN (SELECT rowid FROM chunks WHERE page_id=?)', pageID);
    this.sql.exec('DELETE FROM chunks WHERE page_id=?', pageID);
    if (!deleted) for (const section of sections(row.markdown)) {
      const chunk = this.sql.exec<{ rowid: number }>('INSERT INTO chunks(page_id,section,heading,start_line,end_line,body) VALUES (?,?,?,?,?,?) RETURNING rowid',
        pageID, section.section, section.heading, section.start_line, section.end_line, section.body).one().rowid;
      this.sql.exec('INSERT INTO wiki_search(rowid,title,path,aliases,heading,body) VALUES (?,?,?,?,?,?)', chunk, row.title, row.path,
        [...value.aliases, ...value.tags].join(' '), section.heading, section.body);
    }
    this.change(deleted ? 'page_deleted' : old ? 'page_updated' : 'page_created', pageID, row.revision);
    return row;
  }
  private initialize(input: Record<string, unknown>): Response {
    const wikiID = String(input.id), auth = typeof input.auth_hash === 'string' && unb64(input.auth_hash);
    if (!canonicalID(wikiID) || !auth || auth.length !== 32) throw new HTTPError(400, 'Invalid wiki capability');
    const title = label(input.title, 'title');
    if (this.initialized) {
      const row = this.sql.exec<Meta>('SELECT * FROM wiki').one();
      if (row.deleted) throw new HTTPError(410, 'This wiki was deleted. Generate a new capability.');
      if (!crypto.subtle.timingSafeEqual(auth, row.auth)) throw new HTTPError(409, 'Wiki already exists');
      return json({ id: row.id, title: row.title, url: `/w/${row.id}` });
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('CREATE TABLE wiki(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, title TEXT NOT NULL, auth BLOB NOT NULL, version INTEGER NOT NULL, bytes INTEGER NOT NULL, attachment_bytes INTEGER NOT NULL, deleted INTEGER NOT NULL)');
      this.sql.exec('CREATE TABLE pages(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,title TEXT NOT NULL,markdown TEXT NOT NULL,parent_id TEXT,aliases TEXT NOT NULL,tags TEXT NOT NULL,author TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)');
      this.sql.exec('CREATE INDEX page_tree ON pages(deleted,parent_id,path)');
      this.sql.exec('CREATE TABLE revisions(page_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(page_id,revision))');
      this.sql.exec('CREATE TABLE chunks(rowid INTEGER PRIMARY KEY,page_id TEXT NOT NULL,section TEXT NOT NULL,heading TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,body TEXT NOT NULL)');
      this.sql.exec('CREATE INDEX page_chunks ON chunks(page_id)');
      this.sql.exec("CREATE VIRTUAL TABLE wiki_search USING fts5(title,path,aliases,heading,body,tokenize='unicode61')");
      this.sql.exec('CREATE TABLE changes(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,page_id TEXT,revision INTEGER,at TEXT NOT NULL)');
      this.sql.exec('CREATE TABLE comments(id TEXT PRIMARY KEY,page_id TEXT NOT NULL,parent_id TEXT,body TEXT NOT NULL,author TEXT NOT NULL,anchor TEXT NOT NULL,revision INTEGER NOT NULL,resolved INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,seq INTEGER NOT NULL)');
      this.sql.exec('CREATE INDEX page_comments ON comments(page_id,seq)');
      this.sql.exec('CREATE TABLE attachments(id TEXT PRIMARY KEY,key TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL)');
      this.sql.exec('INSERT INTO wiki VALUES (1,?,?,?,0,0,0,0)', wikiID, title, auth);
    });
    this.initialized = true;
    return json({ id: wikiID, title, url: `/w/${wikiID}` }, 201);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (!wikiSettings(this.env).enabled) throw notFound();
      return await this.handle(request);
    } catch (error) {
      const response = failure(error);
      // Only export download errors may be displayed in the same-origin download
      // frame. They are inert JSON; other pages retain frame-ancestors 'none'.
      if (/\/export\/[a-f0-9-]{36}\/download$/.test(new URL(request.url).pathname)) response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      return response;
    }
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/_create' && request.method === 'POST') return this.initialize(await bodyJSON(request, 4096));
    const download = /^\/w\/([A-Za-z0-9_-]{22})\/export\/([a-f0-9-]{36})\/download$/.exec(url.pathname);
    if (download && request.method === 'POST') {
      if (download[1] !== this.meta().id) throw notFound();
      // The single-use, five-minute export ticket grants only this download.
      return this.exporter.download(request, download[2]);
    }
    const hash = await bearerHash(request);
    const meta = this.authorize(hash);
    const root = `/w/${meta.id}`;
    if (!url.pathname.startsWith(root)) throw notFound();
    const path = url.pathname.slice(root.length).replace(/\/$/, '');
    const get = request.method === 'GET' || request.method === 'HEAD';
    if (path === '/export' && request.method === 'POST') return this.exporter.prepare(request);
    const pageExport = /^\/pages\/([^/]+)\/export$/.exec(path);
    if (pageExport && request.method === 'POST') {
      if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length > 1) throw new HTTPError(400, 'Invalid export revision');
      const rev = url.searchParams.get('revision');
      return this.exporter.prepare(request, { pageID: id(pageExport[1]), ...(rev !== null ? { revision: positive(rev, 'revision') } : {}) });
    }
    const exportMatch = /^\/export\/([a-f0-9-]{36})$/.exec(path);
    if (exportMatch && get) return this.exporter.status(exportMatch[1]);
    if (exportMatch && request.method === 'DELETE') return this.exporter.cancel(exportMatch[1]);
    if (path === '/links' || path.startsWith('/links/')) return spaceLinks(request, path, 'wiki', this.sql, () => { this.authorize(hash); });
    if (!path && get) return json({ id: meta.id, title: meta.title, version: meta.version, content_bytes: meta.bytes,
      attachment_bytes: meta.attachment_bytes, limits: wikiLimits, search: wikiSettings(this.env), summary: summarySettings(this.env),
      pages: this.sql.exec<{ count: number }>('SELECT COUNT(*) count FROM pages WHERE deleted=0').one().count });
    const summaryMatch = /^\/pages\/([^/]+)\/summary$/.exec(path);
    if ((path === '/summary' || summaryMatch) && request.method === 'POST') {
      if (!summarySettings(this.env).enabled) throw new HTTPError(404, 'AI summaries are disabled');
      await summaryRequest(request); const snapshot = this.authorize(hash);
      const check = () => { this.authorize(hash); };
      if (summaryMatch) {
        const pageID = id(summaryMatch[1]);
        if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length > 1) throw new HTTPError(400, 'Invalid summary revision');
        const rev = url.searchParams.get('revision'); let page = this.page(pageID, !!rev);
        if (rev !== null) {
          const row = this.sql.exec<{snapshot:string}>('SELECT snapshot FROM revisions WHERE page_id=? AND revision=?', pageID, positive(rev, 'revision')).toArray()[0];
          if (!row) throw notFound(); page = JSON.parse(row.snapshot);
        }
        return streamSummary(request, this.env, { scope: 'page', title: page.title, version: snapshot.version, total: 1,
          sources: [{ title: page.title, revision: page.revision, text: page.markdown, originalBytes: byteLength(page.markdown), url: root + '?' + new URLSearchParams({ page: page.id, revision: String(page.revision) }) }] }, this.summaries, check);
      }
      if (url.search) throw new HTTPError(400, 'Wiki summaries do not accept query parameters.');
      const total = this.sql.exec<{n:number}>('SELECT COUNT(*) n FROM pages WHERE deleted=0').one().n;
      // Select bounded IDs before reading bodies: sorting thousands of full page
      // records would make an overview needlessly expensive.
      const selected = this.sql.exec<{id:string}>('SELECT id FROM pages WHERE deleted=0 ORDER BY (parent_id IS NOT NULL),path LIMIT ?', summaryLimits.wikiPages).toArray();
      const rows = selected.map(({id}) => this.sql.exec<{id:string;title:string;revision:number;markdown:string;originalBytes:number}>('SELECT id,title,revision,substr(markdown,1,?) AS markdown,length(CAST(markdown AS BLOB)) AS originalBytes FROM pages WHERE id=?', summaryLimits.pageExcerpt, id).one());
      return streamSummary(request, this.env, { scope: 'wiki', title: snapshot.title, version: snapshot.version, total,
        sources: rows.map(page => ({ title: page.title, revision: page.revision, text: summaryClip(page.markdown, summaryLimits.pageExcerpt), originalBytes: page.originalBytes, url: root + '?' + new URLSearchParams({ page: page.id, revision: String(page.revision) }) })) }, this.summaries, check);
    }
    if (!path && request.method === 'DELETE') {
      this.ctx.storage.transactionSync(() => {
        for (const table of ['wiki_search', 'chunks', 'pages', 'revisions', 'comments', 'changes']) this.sql.exec(`DELETE FROM ${table}`);
        clearSpaceLinks(this.sql);
        this.sql.exec("UPDATE attachments SET status='delete'");
        this.sql.exec('UPDATE wiki SET deleted=1,bytes=0,version=version+1 WHERE singleton=1');
        this.cache.clear();
      });
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return new Response(null, { status: 204 });
    }
    if (path === '/pages' && get) {
      const limit = pageSize(url.searchParams.get('limit')), after = url.searchParams.get('after') ?? '';
      const parent = url.searchParams.get('parent');
      if (parent) id(parent);
      const rows = this.sql.exec<Pick<PageRow, 'id' | 'title' | 'path' | 'revision' | 'parent_id' | 'updated_at'> & { has_children: number }>(
        `SELECT p.id,p.title,p.path,p.revision,p.parent_id,p.updated_at,
        EXISTS(SELECT 1 FROM pages child WHERE child.deleted=0 AND child.parent_id=p.id) AS has_children
        FROM pages p WHERE p.deleted=0 AND p.path>? ${parent === null ? '' : 'AND p.parent_id IS ?'} ORDER BY p.path LIMIT ?`,
        after, ...(parent === null ? [] : [parent || null]), limit + 1).toArray();
      return json({ version: meta.version, pages: rows.slice(0, limit).map(row => ({ ...row, has_children: !!row.has_children })), next: rows.length > limit ? rows[limit - 1].path : null });
    }
    if (path === '/pages' && request.method === 'POST') {
      const input = await bodyJSON(request), value = pageInput(input), pageID = input.id === undefined ? crypto.randomUUID() : id(input.id);
      this.authorize(hash);
      const existing = this.sql.exec<PageRow>('SELECT * FROM pages WHERE id=?', pageID).toArray()[0];
      if (existing) {
        const before = pageValue(existing);
        if (!existing.deleted && Object.entries(value).every(([key, v]) => JSON.stringify(v) === JSON.stringify(before[key as keyof typeof before]))) return pageResponse(before);
        throw new HTTPError(409, 'Page ID already exists');
      }
      if (this.sql.exec<{ count: number }>('SELECT COUNT(*) count FROM pages').one().count >= wikiLimits.pages) throw new HTTPError(429, 'Wiki page budget reached (including deleted pages)');
      return pageResponse(pageValue(this.ctx.storage.transactionSync(() => this.save(pageID, value))), 201);
    }
    const pageMatch = /^\/pages\/([^/]+)(?:\/(history|comments|navigation)(?:\/([0-9]+))?)?$/.exec(path);
    if (pageMatch) {
      const pageID = id(pageMatch[1]);
      let page = this.page(pageID, true);
      if (pageMatch[2] === 'navigation' && !pageMatch[3] && get) {
        if (page.deleted) throw notFound();
        return json(this.navigation(page));
      }
      if (pageMatch[2] === 'history' && get) {
        if (pageMatch[3]) {
          const row = this.sql.exec<{ snapshot: string }>('SELECT snapshot FROM revisions WHERE page_id=? AND revision=?', pageID, positive(pageMatch[3], 'revision')).toArray()[0];
          if (!row) throw notFound();
          return pageResponse(JSON.parse(row.snapshot));
        }
        const limit = pageSize(url.searchParams.get('limit')), after = positive(url.searchParams.get('before'), 'before', page.revision + 1);
        const rows = this.sql.exec<{ snapshot: string }>('SELECT snapshot FROM revisions WHERE page_id=? AND revision<? ORDER BY revision DESC LIMIT ?', pageID, after, limit + 1).toArray()
          .map(row => { const { markdown, aliases, tags, ...summary } = JSON.parse(row.snapshot); return summary; });
        return json({ revisions: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].revision : null });
      }
      if (pageMatch[2] === 'comments' && !pageMatch[3]) {
        if (page.deleted) throw notFound();
        if (get) {
          const limit = pageSize(url.searchParams.get('limit')), after = url.searchParams.get('after') ? positive(url.searchParams.get('after'), 'after') : 0;
          const rows = this.sql.exec<CommentRow>('SELECT * FROM comments WHERE page_id=? AND seq>? ORDER BY seq LIMIT ?', pageID, after, limit + 1).toArray();
          return json({ comments: rows.slice(0, limit).map(row => this.commentValue(row, page)), next: rows.length > limit ? rows[limit - 1].seq : null });
        }
        if (request.method === 'POST') {
          const value = await bodyJSON(request, 16384); this.authorize(hash); page = this.page(pageID);
          if (this.sql.exec<{ count: number }>('SELECT COUNT(*) count FROM comments WHERE page_id=?', pageID).one().count >= wikiLimits.commentsPerPage) throw new HTTPError(429, 'Comment budget reached for this page');
          const parentID = value.parent_id == null ? null : id(value.parent_id);
          const parent = parentID ? this.sql.exec<CommentRow>('SELECT * FROM comments WHERE id=? AND page_id=?', parentID, pageID).toArray()[0] : null;
          if (parentID && !parent) throw notFound();
          if (parent?.parent_id) throw new HTTPError(400, 'Reply to the root thread');
          const anchor = parent ? JSON.parse(parent.anchor) : commentAnchor(value.anchor, page.revision, page.markdown);
          const row: CommentRow = { id: crypto.randomUUID(), page_id: pageID, parent_id: parentID, body: text(value.body, 'body', 8000),
            author: label(value.author ?? 'anonymous', 'author', 80), anchor: JSON.stringify(anchor), revision: 1, resolved: 0, created_at: now(), updated_at: now(), seq: 0 };
          this.ctx.storage.transactionSync(() => {
            this.charge(byteLength(row.body) + byteLength(row.anchor));
            row.seq = this.change('comment_created', pageID, page.revision);
            this.sql.exec('INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?,?)', row.id, pageID, parentID, row.body, row.author, row.anchor, 1, 0, row.created_at, row.updated_at, row.seq);
          });
          return json(this.commentValue(row, page), 201);
        }
      }
      if (!pageMatch[2]) {
        if (get) {
          if (page.deleted) throw notFound();
          const response = request.headers.get('Accept')?.includes('text/markdown')
            ? new Response(page.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', ETag: `"${page.revision}"` } }) : pageResponse(pageValue(page));
          return response;
        }
        if (request.method === 'PUT' || request.method === 'DELETE') {
          const expected = revision(request);
          if (expected !== page.revision) return conflict(page.revision);
          let input: Record<string, unknown>;
          if (request.method === 'DELETE') input = pageValue(page);
          else if (request.headers.get('Content-Type')?.split(';')[0] === 'text/markdown') {
            // Raw Markdown updates retain the page metadata.
            input = { ...pageValue(page), markdown: await readBody(request, wikiLimits.pageBytes) };
          } else input = await bodyJSON(request);
          this.authorize(hash); page = this.page(pageID, true);
          if (expected !== page.revision) return conflict(page.revision);
          const deleted = request.method === 'DELETE';
          if (deleted && this.sql.exec('SELECT 1 FROM pages WHERE parent_id=? AND deleted=0 LIMIT 1', pageID).toArray().length) throw new HTTPError(409, 'Move or delete child pages first');
          const value = pageInput(input);
          return pageResponse(pageValue(this.ctx.storage.transactionSync(() => this.save(pageID, value, page, deleted))));
        }
      }
    }
    const commentMatch = /^\/comments\/([^/]+)$/.exec(path);
    if (commentMatch && request.method === 'PATCH') {
      const commentID = id(commentMatch[1]), expected = revision(request), input = await bodyJSON(request, 16384);
      this.authorize(hash);
      const row = this.sql.exec<CommentRow>('SELECT * FROM comments WHERE id=?', commentID).toArray()[0];
      if (!row) throw notFound();
      const page = this.page(row.page_id);
      if (expected !== row.revision) return conflict(row.revision);
      const body = input.body === undefined ? row.body : text(input.body, 'body', 8000);
      if (input.resolved !== undefined && typeof input.resolved !== 'boolean') throw new HTTPError(400, 'resolved must be boolean');
      const updated = { ...row, body, resolved: input.resolved === undefined ? row.resolved : Number(input.resolved), revision: row.revision + 1, updated_at: now() };
      this.ctx.storage.transactionSync(() => {
        this.charge(byteLength(body) - byteLength(row.body));
        this.sql.exec('UPDATE comments SET body=?,resolved=?,revision=?,updated_at=? WHERE id=?', body, updated.resolved, updated.revision, updated.updated_at, commentID);
        this.change('comment_updated', row.page_id, page.revision);
      });
      return json(this.commentValue(updated, page));
    }
    if (path === '/changes' && get) {
      const raw = url.searchParams.get('since');
      const since = raw && raw !== '0' ? positive(raw, 'since') : 0;
      const limit = pageSize(url.searchParams.get('limit'));
      const rows = this.sql.exec<{ seq: number; kind: string; page_id: string | null; revision: number | null; at: string }>('SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?', since, limit + 1).toArray();
      return json({ version: meta.version, changes: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].seq : null });
    }
    if (path === '/search' && (get || request.method === 'POST')) {
      const input = searchInput(get ? Object.fromEntries(url.searchParams) : await bodyJSON(request, 8192));
      this.authorize(hash);
      return json(await this.search(input, hash));
    }
    if (path === '/attachments' && request.method === 'POST') {
      if (this.uploads >= wikiLimits.uploadsConcurrent) throw new HTTPError(429, 'Wiki uploads are busy; retry later');
      this.uploads++;
      try { return await this.upload(request, hash); } finally { this.uploads--; }
    }
    const attachmentMatch = /^\/attachments\/([^/]+)$/.exec(path);
    if (attachmentMatch && get) {
      const attachment = this.sql.exec<Attachment>("SELECT * FROM attachments WHERE id=? AND status='ready'", id(attachmentMatch[1])).toArray()[0];
      if (!attachment) throw notFound();
      if (!this.env.WIKI_FILES) throw new HTTPError(503, 'Wiki attachment storage is not configured');
      const headers = { 'Content-Type': attachment.type, 'Content-Length': String(attachment.size),
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(attachment.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()), 'Cache-Control': 'no-store' };
      if (request.method === 'HEAD') return new Response(null, { headers });
      const file = await this.env.WIKI_FILES.get(attachment.key);
      this.authorize(hash);
      if (!file) throw notFound();
      return new Response(file.body, { headers });
    }
    throw notFound();
  }
  private commentValue(row: CommentRow, page: PageRow) {
    const anchor = JSON.parse(row.anchor) as CommentAnchor;
    const matches = anchor.type === 'section' ? new Set(sections(page.markdown).filter(s => s.level && s.heading === anchor.heading).map(s => s.section)) : null;
    return { ...row, anchor, resolved: Boolean(row.resolved), detached: !!matches && matches.size !== 1 };
  }
  private candidates(input: SearchInput): SearchHit[] {
    const match = matchQuery(input);
    if (!match) return [];
    const rows = this.sql.exec<{ page_id: string; revision: number; title: string; path: string; section: string; heading: string; start_line: number; end_line: number; body: string }>(
      `SELECT c.page_id,p.revision,p.title,p.path,c.section,c.heading,c.start_line,c.end_line,c.body FROM wiki_search
       JOIN chunks c ON c.rowid=wiki_search.rowid JOIN pages p ON p.id=c.page_id
       WHERE wiki_search MATCH ? AND p.deleted=0 AND substr(p.path,1,length(?))=?
       AND (?='' OR EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?))
       ORDER BY (lower(p.title)=lower(?)) DESC,bm25(wiki_search,8,5,3,4,1),p.path,c.rowid LIMIT 60`,
      match, input.path, input.path, input.tag, input.tag, input.query).toArray();
    const counts = new Map<string, number>(), out: SearchHit[] = [], wikiID = this.meta().id;
    for (const { body, ...row } of rows) {
      const count = counts.get(row.page_id) ?? 0;
      if (count >= 2) continue;
      counts.set(row.page_id, count + 1);
      out.push({ ...row, excerpt: body.slice(0, 4000), url: `/w/${wikiID}?page=${row.page_id}&revision=${row.revision}&section=${row.section}` });
      if (out.length === wikiLimits.candidates) break;
    }
    return out;
  }
  private async search(input: SearchInput, hash: Uint8Array | undefined): Promise<SearchResult> {
    const version = this.meta().version, hits = this.candidates(input);
    const baseline = (fallback?: string): SearchResult => ({ version, mode: 'keyword', ...(fallback ? { fallback } : {}), results: hits.slice(0, input.limit) });
    if (input.mode === 'keyword' || !hits.length) return baseline();
    if (!wikiSettings(this.env).relevance) return baseline('disabled');
    const key = JSON.stringify([version, this.env.TYPESAFE_MODEL || 'jev-latest', relevanceVersion, input.query, input.related_terms, input.context, input.path, input.tag]);
    const cached = this.cache.get(key);
    if (cached) return { version, mode: 'relevance', results: cached.slice(0, input.limit) };
    let pending = this.searches.get(key);
    if (!pending) {
      if (this.searches.size >= wikiLimits.searchConcurrent) return baseline('busy');
      pending = rankPassages(input, hits, this.env);
      this.searches.set(key, pending);
    }
    let ranked: SearchHit[] | null;
    try { ranked = await pending; } finally { if (this.searches.get(key) === pending) this.searches.delete(key); }
    const current = this.authorize(hash);
    if (current.version !== version) return { version: current.version, mode: 'keyword', fallback: 'changed', results: this.candidates(input).slice(0, input.limit) };
    if (!ranked) return baseline('unavailable');
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, ranked);
    return { version, mode: 'relevance', results: ranked.slice(0, input.limit) };
  }
  private async upload(request: Request, hash: Uint8Array | undefined): Promise<Response> {
    const bucket = this.env.WIKI_FILES;
    if (!bucket) throw new HTTPError(503, 'Wiki attachment storage is not configured');
    if (!request.body) throw new HTTPError(400, 'Empty attachment');
    const reader = request.body.getReader(), parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > wikiLimits.attachmentBytes) throw new HTTPError(413, 'Attachment exceeds 5 MiB');
        parts.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    if (!size) throw new HTTPError(400, 'Empty attachment');
    const type=attachmentType(request.headers.get('Content-Type') ?? '',bytes);
    const meta = this.authorize(hash), attachmentID = crypto.randomUUID(), key = `${meta.id}/${attachmentID}`;
    const name = label(request.headers.get('X-Filename') ?? 'attachment', 'filename', 200);
    this.ctx.storage.transactionSync(() => {
      if (meta.attachment_bytes + size > wikiLimits.attachmentsBytes) throw new HTTPError(429, 'Wiki attachment budget reached (1 GiB)');
      this.sql.exec('INSERT INTO attachments VALUES (?,?,?,?,?,?,?)', attachmentID, key, name, type, size, 'pending', Date.now());
      this.sql.exec('UPDATE wiki SET attachment_bytes=attachment_bytes+? WHERE singleton=1', size);
    });
    // The durable pending record allows an alarm to remove interrupted uploads.
    await this.scheduleCleanup(Date.now() + 600000);
    try {
      await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
      this.authorize(hash);
      if (!this.sql.exec("SELECT 1 FROM attachments WHERE id=? AND status='pending'", attachmentID).toArray().length) throw new Error('Upload expired');
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE attachments SET status='ready' WHERE id=?", attachmentID);
        this.change('attachment_created', null, null);
      });
      return json({ id: attachmentID, name, type, size, markdown: `${type.startsWith('image/')?'!':''}[${name.replace(/[\[\]\\]/g, '')}](attachment:${attachmentID})` }, 201);
    } catch {
      // If cleanup raced a slow object-store write, requeue its key without
      // charging the reservation a second time.
      this.sql.exec("INSERT INTO attachments VALUES (?,?,?,?,0,'delete',?) ON CONFLICT(id) DO UPDATE SET status='delete'", attachmentID, key, name, type, Date.now());
      await this.scheduleCleanup(Date.now() + 1000);
      throw new HTTPError(503, 'Attachment upload did not complete');
    }
  }
  private async scheduleCleanup(at: number) {
    // A later upload must not postpone cleanup already requested by another.
    const existing = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(Math.min(existing ?? at, at));
  }
  async alarm(): Promise<void> {
    if (!this.initialized) return;
    const rows = this.sql.exec<Attachment>("SELECT * FROM attachments WHERE status='delete' OR (status='pending' AND created<?) LIMIT 20", Date.now() - 600000).toArray();
    try {
      for (const row of rows) {
        if (!this.env.WIKI_FILES) throw new Error('Storage unavailable');
        await this.env.WIKI_FILES.delete(row.key);
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM attachments WHERE id=?', row.id);
          this.sql.exec('UPDATE wiki SET attachment_bytes=max(0,attachment_bytes-?) WHERE singleton=1', row.size);
        });
      }
    } finally {
      const remaining = this.sql.exec("SELECT 1 FROM attachments WHERE status<>'ready' LIMIT 1").toArray().length;
      if (remaining) await this.ctx.storage.setAlarm(Date.now() + 30000);
    }
  }
}

export class WikiCreationGate extends DurableObject<WikiEnv> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: WikiEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS quotas(ip TEXT PRIMARY KEY,tokens REAL NOT NULL,updated REAL NOT NULL)');
  }
  fetch(request: Request): Promise<Response> {
    const result = this.queue.then(async () => {
      if (!wikiSettings(this.env).enabled) throw notFound();
      const input = await bodyJSON(request, 4096), ip = String(input.ip ?? ''), at = Date.now(), sql = this.ctx.storage.sql;
      const previous = sql.exec<{ tokens: number; updated: number }>('SELECT * FROM quotas WHERE ip=?', ip).toArray()[0];
      const tokens = previous ? Math.min(100, previous.tokens + Math.max(0, at - previous.updated) / 864000) : 100;
      if (tokens < 1) throw new HTTPError(429, 'Wiki creation rate limit reached');
      const stub = this.env.WIKIS.get(this.env.WIKIS.idFromName(String(input.id)));
      const response = await stub.fetch(new Request('https://wiki.internal/_create', { method: 'POST', body: JSON.stringify(input) }));
      if (response.status === 201) this.ctx.storage.transactionSync(() => {
        if (!previous && sql.exec<{ n: number }>('SELECT COUNT(*) n FROM quotas').one().n >= 4096) sql.exec('DELETE FROM quotas WHERE ip=(SELECT ip FROM quotas ORDER BY updated LIMIT 1)');
        sql.exec('INSERT OR REPLACE INTO quotas VALUES (?,?,?)', ip, tokens - 1, Math.max(at, previous?.updated ?? 0));
      });
      return response;
    }).catch(failure);
    this.queue = result;
    return result;
  }
}

function wikiShell(wikiID: string, env: WikiEnv) {
  const response = render('wiki', { WikiID: wikiID, WikiLayout: wikiSettings(env).layout, SummaryEnabled: summarySettings(env).enabled ? '1' : '0' });
  response.headers.set('Content-Security-Policy', response.headers.get('Content-Security-Policy')!.replace('img-src http: https: data:', 'img-src http: https: data: blob:'));
  if (wikiID) response.headers.set('Content-Security-Policy', response.headers.get('Content-Security-Policy')!.replace("form-action 'none'", "form-action 'self'; frame-src 'self'"));
  return response;
}
export async function wikiRoute(request: Request, env: WikiEnv): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/wiki' && !path.startsWith('/wiki/') && !path.startsWith('/w/')) return;
  if (!wikiSettings(env).enabled) throw notFound();
  const get = request.method === 'GET' || request.method === 'HEAD';
  if (path === '/wiki' && get) return wikiShell('', env);
  if (path === '/wiki/new' && request.method === 'POST') {
    const site = request.headers.get('Sec-Fetch-Site'), origin = request.headers.get('Origin');
    if (site && site !== 'same-origin' && site !== 'none' || origin && origin !== url.origin) throw new HTTPError(403, 'Cross-origin creation is not allowed');
    const input = await bodyJSON(request, 4096);
    if (typeof input.id !== 'string' || !canonicalID(input.id) || typeof input.auth_hash !== 'string' || unb64(input.auth_hash)?.length !== 32 || b64(unb64(input.auth_hash)!) !== input.auth_hash) throw new HTTPError(400, 'Invalid wiki capability');
    const value = { id: input.id, auth_hash: input.auth_hash, title: label(input.title, 'title'), ip: sourceIP(request, env.TRUST_PROXY === '1') };
    return env.WIKI_CREATION.get(env.WIKI_CREATION.idFromName('wiki-creation')).fetch(new Request('https://wiki.internal/new', { method: 'POST', body: JSON.stringify(value) }));
  }
  const match = /^\/w\/([^/]+)(\/.*)?$/.exec(path);
  if (!match || !canonicalID(match[1])) throw notFound();
  if ((!match[2] || match[2] === '/') && get) {
    if (acceptsHTML(request.headers.get('Accept') || '')) return wikiShell(match[1], env);
    if (!request.headers.has('Authorization')) return plain(`Mayfly Wiki\n\nThe complete URL fragment is the access capability. This shell contains no wiki content.\nDownload ${url.origin}/static/wiki.mjs and inspect it, then run:\nnode wiki.mjs read 'FULL_WIKI_URL'\n\nDownload and inspect ${url.origin}/static/spaces.mjs to find or create linked chats:\nnode spaces.mjs links 'FULL_WIKI_URL'\nnode spaces.mjs chat 'FULL_WIKI_URL'\nLinking shares access with everyone holding either complete URL.\n\nAPI and key derivation: ${url.origin}/docs/wiki.md\nPlaintext wiki; anyone holding the full URL can read, edit and delete it.\n`);
  }
  const headers = new Headers();
  for (const name of ['Authorization', 'Accept', 'Content-Type', 'If-Match', 'X-Filename']) {
    const value = request.headers.get(name); if (value !== null) headers.set(name, value);
  }
  return env.WIKIS.get(env.WIKIS.idFromName(match[1])).fetch(new Request(request, { headers, redirect: 'manual' }));
}
