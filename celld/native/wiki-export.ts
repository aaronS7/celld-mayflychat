import { b64, HTTPError, json, readBody } from './protocol';
import { exportLimits, exportMarkdown, exportName, exportPageName, exportReferences, relativeFile, utf8, zipChunks, zipSize, zipText, type ZipEntry } from './wiki-zip';

type Meta = { id: string; title: string; version: number };
type Page = { id: string; path: string; title: string; parent_id: string | null; revision: number; markdown: string; aliases: string; tags: string; author: string; created_at: string; updated_at: string };
type File = { id: string; key: string; name: string; type: string; size: number; created: number };
type Slot = { id: string; state: 'preparing' | 'ready' | 'downloading' | 'complete' | 'failed' | 'canceled'; version: number; pages: number; attachments: number; bytes: number; sent: number; expires: number; filename: string; ticket: string; entries: ZipEntry[]; error?: string; code?: string;
  scope: 'wiki' | 'page'; page?: { id: string; title: string; path: string; revision: number; file: string }; unresolved_pages?: string[] };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const serialized = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const textReader = (read: () => string) => () => zipText(read());
const readme = `# Mayfly wiki export

Open index.md to browse the saved pages. pages/ contains Markdown with relative
links to other exported pages and files. attachments/ contains every completed
upload, including uploads no current page references, with the original bytes.
Filenames are made portable; attachments.jsonl records their original names.
metadata/ records page IDs, paths, titles, parent IDs, tags, aliases and revisions.
discussion/ contains comments and replies as JSON Lines, including their anchors.
manifest.json identifies the wiki version and the archive format.

This is a migration export of current saved content. Deleted pages, old revisions,
unsaved drafts, search indexes, linked chats and access credentials are excluded.
External URLs remain links; their contents are not fetched. Unresolved page/file
references stay unchanged. Comments are separate from the page Markdown.

Extract the ZIP before importing Markdown/files into another wiki. Importers vary:
you may need to recreate hierarchy, upload assets, fix links or migrate discussion
using the metadata. This archive is not a native Notion or Confluence backup.
`;
const pageReadme = `# Mayfly page export for a repository or pull request

../README.md is the saved page. ../attachments/ contains only files referenced
by that Markdown, with relative links and unchanged uploaded bytes. Keep those
paths together when moving the page. Names are made portable; attachments.jsonl
maps archive paths to original filenames. Metadata and current discussion are
kept separately in this _mayfly/ folder. Discussion is not historical, even when
exporting an older saved page revision.

To use this in a GitHub pull request:
1. Extract into a new folder on your repository branch, such as docs/my-page/.
2. Review README.md and attachments/. Replace any page:ID links to other wiki
   pages with links to your repository files; references.json lists these IDs.
3. Commit the Markdown and its attachments together, then open your PR normally.
   Include this metadata folder only if you want its source/discussion records.

This creates files for your branch; it does not create or publish a pull request.
For a PR description or comment, upload the files in GitHub's editor and use the
links it supplies. Pasting this README alone does not upload local attachments.

Other pages, their uploads, unsaved drafts and linked chats are excluded.
External files remain URLs and are not fetched. References in code examples are
kept as examples. The archive adds no wiki bearer or key-bearing source URL.
`;

export class WikiExporter {
  private slot?: Slot;
  constructor(private sql: SqlStorage, private meta: () => Meta, private bucket: () => R2Bucket | undefined) {}
  private check(slot: Slot) {
    if (this.slot !== slot || slot.state === 'canceled') throw new HTTPError(409, 'Export canceled. Prepare a new export.', 'export_canceled');
    if (Date.now() > slot.expires) throw new HTTPError(410, 'Export expired. Prepare a new export.', 'export_expired');
    if (this.meta().version !== slot.version) throw new HTTPError(409, 'The wiki changed during export. Wait for edits and uploads to finish, then try again.', 'export_changed');
  }
  private failed(slot: Slot, error: unknown) {
    if (slot.state === 'canceled' || slot.state === 'failed') return;
    slot.state = 'failed'; slot.ticket = ''; slot.entries = [];
    slot.error = error instanceof HTTPError ? error.message : 'Export failed or was interrupted. Prepare a new export and try again.';
    slot.code = error instanceof HTTPError ? error.code : 'export_failed';
  }
  private public(slot: Slot) {
    return { id: slot.id, state: slot.state, version: slot.version, scope: slot.scope, pages: slot.pages, attachments: slot.attachments,
      ...(slot.page ? { page: slot.page, unresolved_pages: slot.unresolved_pages } : {}),
      bytes: slot.bytes, sent: slot.sent, expires_at: new Date(slot.expires).toISOString(), filename: slot.filename,
      ...(slot.state === 'ready' ? { ticket: slot.ticket } : {}), ...(slot.error ? { error: slot.error, code: slot.code } : {}) };
  }
  private get(id: string) {
    const slot = this.slot;
    if (!slot || slot.id !== id) throw new HTTPError(404, 'Export unavailable. Prepare a new export.', 'export_missing');
    if (['ready', 'downloading', 'preparing'].includes(slot.state)) {
      try { this.check(slot); } catch (error) { this.failed(slot, error); }
    }
    return slot;
  }
  status(id: string) { return json(this.public(this.get(id))); }
  cancel(id: string) {
    const slot = this.get(id);
    if (slot.state !== 'complete') { slot.state = 'canceled'; slot.ticket = ''; slot.entries = []; }
    return json(this.public(slot));
  }
  async prepare(request: Request, target?: { pageID: string; revision?: number }) {
    const body = (await readBody(request, 16)).trim();
    if (body && body !== '{}') {
      throw new HTTPError(400, 'Export preparation takes an empty body');
    }
    if (this.slot && ['preparing', 'ready', 'downloading'].includes(this.get(this.slot.id).state)) throw new HTTPError(429, 'An export is already being prepared or downloaded. Try again after it finishes or expires.', 'export_busy');
    const { id, title, version } = this.meta(), meta = { id, title, version }, exported = new Date().toISOString();
    let selected: Page | undefined;
    if (target) {
      if (target.revision !== undefined) {
        const row = this.sql.exec<{ snapshot: string }>('SELECT snapshot FROM revisions WHERE page_id=? AND revision=?', target.pageID, target.revision).toArray()[0];
        if (row) { const snapshot = JSON.parse(row.snapshot); selected = { ...snapshot, aliases: JSON.stringify(snapshot.aliases), tags: JSON.stringify(snapshot.tags) }; }
      } else selected = this.sql.exec<Page>('SELECT * FROM pages WHERE id=? AND deleted=0', target.pageID).toArray()[0];
      if (!selected) throw new HTTPError(404, 'Page or saved revision not found');
    }
    const references = selected ? exportReferences(selected.markdown) : undefined;
    const scope = selected ? 'page' : 'wiki';
    const slot: Slot = { id: crypto.randomUUID(), state: 'preparing', scope, version: meta.version, pages: 0, attachments: 0, bytes: 0, sent: 0,
      ...(selected ? { page: { id: selected.id, title: selected.title, path: selected.path, revision: selected.revision, file: 'README.md' }, unresolved_pages: references!.pages.filter(id => id !== selected!.id) } : {}),
      expires: Date.now() + exportLimits.downloadMS, filename: selected ? 'mayfly-page-' + exportName(selected.path.split('/').at(-1)!).slice(0, 100) + '-r' + selected.revision + '.zip' : 'mayfly-wiki-' + meta.id + '-' + exported.slice(0, 10) + '.zip', ticket: '', entries: [] };
    this.slot = slot;
    const check = () => this.check(slot);
    let total = 22, names = 0;
    const add = (entry: ZipEntry) => {
      names += utf8(entry.name).length; total += entry.size + 92 + 2 * utf8(entry.name).length;
      if (total > exportLimits.bytes || slot.entries.length >= exportLimits.entries || names > exportLimits.namesBytes) throw new HTTPError(413, 'Export exceeds 1 GiB or the 50,000-file metadata budget', 'export_limit');
      slot.entries.push(entry);
    };
    const addText = (name: string, value: string, read?: () => string) => add({ name, size: utf8(value).length, data: read ? textReader(read) : textReader(() => value) });
    try {
      const pages = selected ? [selected] : this.sql.exec<Pick<Page, 'id' | 'path' | 'title'>>('SELECT id,path,title FROM pages WHERE deleted=0 ORDER BY path').toArray();
      const count = references ? references.attachments.length : this.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM attachments WHERE status='ready'").one().n;
      if (count + pages.length * 2 + 4 > exportLimits.entries) throw new HTTPError(413, 'Export exceeds 50,000 files', 'export_limit');
      const files = references ? references.attachments.map(id => {
        const file = this.sql.exec<File>("SELECT id,key,name,type,size,created FROM attachments WHERE id=? AND status='ready'", id).toArray()[0];
        if (!file) throw new HTTPError(409, 'A referenced attachment is unavailable in this wiki. Fix the page reference before exporting.', 'export_attachment_missing');
        return file;
      }) : this.sql.exec<File>("SELECT id,key,name,type,size,created FROM attachments WHERE status='ready' ORDER BY id").toArray();
      if (files.length && !this.bucket()) throw new HTTPError(503, 'Wiki attachment storage is not configured');
      const pageNames = new Map(pages.map(p => [p.id, selected ? 'README.md' : exportPageName(p.path)]));
      const fileNames = new Map(files.map(f => [f.id, 'attachments/' + f.id + '/' + exportName(f.name)]));
      slot.pages = pages.length; slot.attachments = files.length;
      // Reject obviously oversized wikis before scanning/reformatting page text.
      const sourceBytes = selected ? utf8(selected.markdown).length : this.sql.exec<{ n: number }>('SELECT COALESCE(SUM(length(CAST(markdown AS BLOB))),0) n FROM pages WHERE deleted=0').one().n;
      if (sourceBytes + files.reduce((sum, file) => sum + file.size, 0) > exportLimits.bytes) throw new HTTPError(413, 'Export exceeds 1 GiB', 'export_limit');
      const sidecar = selected ? '_mayfly/' : '';
      addText(sidecar + 'manifest.json', serialized({ format: selected ? 'mayfly-page' : 'mayfly-wiki', format_version: 1, wiki: meta, exported_at: exported, pages: pages.length, attachments: files.length,
        ...(selected ? { page: slot.page } : {}),
        contents: selected ? { page: 'README.md', metadata: '_mayfly/page.json', discussion: '_mayfly/discussion.jsonl', attachments: '_mayfly/attachments.jsonl', references: '_mayfly/references.json' } : { pages: 'pages/', metadata: 'metadata/', discussion: 'discussion/', attachments: 'attachments.jsonl', index: 'index.md' },
        excluded: [...(selected ? ['other pages', 'unreferenced uploads', 'other revisions'] : ['deleted pages', 'revision history']), 'unsaved drafts', 'external file contents', 'linked chats', 'access credentials'] }));
      addText(sidecar + 'README.md', selected ? pageReadme : readme);
      if (selected) addText('_mayfly/references.json', serialized({ unresolved_pages: slot.unresolved_pages }));
      else addText('index.md', '# ' + meta.title.replace(/[\r\n]/g, ' ').replace(/[\\[\]<>`*_]/g, '\\$&') + '\n\n' + pages.map(p => '- [' + p.title.replace(/[\r\n]/g, ' ').replace(/[\\[\]<>`*_]/g, '\\$&') + '](' + relativeFile('index.md', pageNames.get(p.id)!) + ')').join('\n') + '\n');
      const attachments = async function* () {
        for (const file of files) {
          const { key: _key, ...metadata } = file;
          yield utf8(JSON.stringify({ ...metadata, file: fileNames.get(file.id) }) + '\n');
        }
      };
      let attachmentMetadataSize = 0; for await (const chunk of attachments()) attachmentMetadataSize += chunk.length;
      add({ name: sidecar + 'attachments.jsonl', size: attachmentMetadataSize, data: attachments });
      for (const [index, p] of pages.entries()) {
        check();
        if (request.signal.aborted) throw new HTTPError(409, 'Export preparation interrupted. Try again.', 'export_canceled');
        const markdown = () => { check(); return exportMarkdown(selected?.markdown ?? this.sql.exec<{ markdown: string }>('SELECT markdown FROM pages WHERE id=? AND deleted=0', p.id).one().markdown, pageNames.get(p.id)!, pageNames, fileNames); };
        const metadata = () => { check(); const { markdown: _markdown, aliases, tags, ...row } = selected ?? this.sql.exec<Page>('SELECT id,path,title,parent_id,revision,aliases,tags,author,created_at,updated_at FROM pages WHERE id=? AND deleted=0', p.id).one(); return serialized({ ...row, aliases: JSON.parse(aliases), tags: JSON.parse(tags), file: pageNames.get(p.id) }); };
        // Store readers and lengths, never all page bodies or attachment bytes.
        addText(pageNames.get(p.id)!, markdown(), markdown);
        addText(selected ? '_mayfly/page.json' : 'metadata/' + p.id + '.json', metadata(), metadata);
        const sql = this.sql;
        const comments = async function* () {
          let after = 0;
          for (;;) {
            check(); const rows = sql.exec<{ seq: number; anchor: string; resolved: number } & Record<string, SqlStorageValue>>('SELECT * FROM comments WHERE page_id=? AND seq>? ORDER BY seq LIMIT 100', p.id, after).toArray();
            if (!rows.length) break;
            for (const row of rows) { yield utf8(JSON.stringify({ ...row, anchor: JSON.parse(row.anchor), resolved: !!row.resolved }) + '\n'); after = row.seq; }
            await pause();
          }
        };
        let size = 0; for await (const chunk of comments()) { size += chunk.length; if (total + size > exportLimits.bytes) throw new HTTPError(413, 'Export exceeds 1 GiB', 'export_limit'); }
        if (size) add({ name: selected ? '_mayfly/discussion.jsonl' : 'discussion/' + p.id + '.jsonl', size, data: comments });
        if (index % 8 === 0) await pause();
      }
      const bucket = this.bucket();
      for (const file of files) add({ name: fileNames.get(file.id)!, size: file.size, data: async function* () {
        check(); const object = await bucket!.get(file.key);
        if (!object) throw new HTTPError(503, 'An uploaded file is missing. Export stopped.', 'export_attachment_missing');
        const reader = object.body.getReader();
        try {
          check(); if (object.size !== file.size) throw new HTTPError(503, 'An uploaded file is incomplete. Export stopped.', 'export_attachment_missing');
          for (;;) { const { value, done } = await reader.read(); if (done) break; check(); yield value; }
        }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } });
      check(); slot.bytes = zipSize(slot.entries); slot.state = 'ready'; slot.expires = Date.now() + exportLimits.readyMS;
      slot.ticket = b64(crypto.getRandomValues(new Uint8Array(32)));
      return json(this.public(slot), 201);
    } catch (error) { this.failed(slot, error); throw error; }
  }
  async download(request: Request, id: string) {
    const slot = this.get(id), contentType = request.headers.get('Content-Type')?.split(';')[0];
    if (contentType !== 'application/x-www-form-urlencoded') throw new HTTPError(400, 'Expected an export ticket form');
    const form = new URLSearchParams(await readBody(request, 128)), ticket = form.get('ticket') ?? '';
    if (form.size !== 1 || slot.state !== 'ready' || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || !crypto.subtle.timingSafeEqual(utf8(slot.ticket), utf8(ticket))) throw new HTTPError(401, 'Export ticket is invalid, expired or already used');
    this.check(slot); slot.ticket = ''; slot.state = 'downloading'; slot.expires = Date.now() + exportLimits.downloadMS;
    const entries = slot.entries;
    const iterator = zipChunks(entries, () => this.check(slot), bytes => { slot.sent = bytes; });
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const { value, done } = await iterator.next();
          if (done) { slot.state = 'complete'; slot.entries = []; controller.close(); }
          else controller.enqueue(value);
        } catch (error) { this.failed(slot, error); controller.error(new Error('Wiki export interrupted')); await iterator.return(undefined).catch(() => {}); }
      },
      cancel: async () => { this.failed(slot, new Error('Download canceled')); await iterator.return(undefined).catch(() => {}); },
    }, { highWaterMark: 0 });
    // Enforce length inside workerd even if the celld transport uses chunking.
    const fixed = new FixedLengthStream(slot.bytes);
    void body.pipeTo(fixed.writable).catch(error => this.failed(slot, error));
    return new Response(fixed.readable, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(slot.bytes), 'X-Mayfly-Export-Bytes': String(slot.bytes),
      'Content-Disposition': 'attachment; filename="' + slot.filename + '"', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } });
  }
}
