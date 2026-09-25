import { HTTPError, readBody } from './protocol';

export interface WikiSettingsEnv {
  WIKI_ENABLED?: string;
  JEV_WIKI_SEARCH_ENABLED?: string;
  WIKI_BOOK_LAYOUT_ENABLED?: string;
  ENCRYPTION_ENABLED?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_MODEL?: string;
}
export const wikiLimits = { pages: 10000, pageBytes: 262144, historyBytes: 1073741824,
  attachmentBytes: 5242880, attachmentsBytes: 1073741824, commentsPerPage: 1000,
  pageSize: 100, candidates: 20, searchMS: 1000, searchConcurrent: 4, uploadsConcurrent: 2 };
// Only recognized media types can be previewed. SVG stays an attachment over
// HTTP and is rendered only in an image context by the browser.
export function attachmentType(declared: string, bytes: Uint8Array): string {
  const type=declared.split(';')[0].trim().toLowerCase();
  if (type === 'image/svg+xml') {
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw new HTTPError(400, 'SVG must be UTF-8 text'); }
    if (!/^\uFEFF?\s*(?:<\?xml\s+[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?=[\s/>])/i.test(source) || /<!DOCTYPE|<!ENTITY/i.test(source))
      throw new HTTPError(400, 'Media signature does not match its content type');
    return type;
  }
  const prefix=String.fromCharCode(...bytes.slice(0,12));
  const signatures: Record<string, boolean> = {
    'image/png': prefix.startsWith('\x89PNG\r\n\x1a\n'),
    'image/jpeg': prefix.startsWith('\xff\xd8\xff'),
    'image/gif': /^GIF8[79]a/.test(prefix),
    'image/webp': prefix.startsWith('RIFF') && prefix.slice(8)==='WEBP',
    'video/mp4': bytes.length>=12 && prefix.slice(4,8)==='ftyp',
    'video/webm': prefix.startsWith('\x1a\x45\xdf\xa3'),
    'video/ogg': prefix.startsWith('OggS'),
  };
  if (!Object.hasOwn(signatures,type)) return 'application/octet-stream';
  if (!signatures[type]) throw new HTTPError(400, 'Media signature does not match its content type');
  return type;
}
export function wikiSettings(env: WikiSettingsEnv) {
  const flag = env.WIKI_ENABLED ?? '0';
  if (flag !== '0' && flag !== '1') throw new HTTPError(503, 'WIKI_ENABLED must be 0 or 1', 'configuration_error');
  const enabled = flag === '1' && env.ENCRYPTION_ENABLED !== '1';
  const relevance = env.JEV_WIKI_SEARCH_ENABLED ?? '0';
  if (enabled && relevance !== '0' && relevance !== '1') throw new HTTPError(503, 'JEV_WIKI_SEARCH_ENABLED must be 0 or 1', 'configuration_error');
  const book = env.WIKI_BOOK_LAYOUT_ENABLED ?? '0';
  if (enabled && book !== '0' && book !== '1') throw new HTTPError(503, 'WIKI_BOOK_LAYOUT_ENABLED must be 0 or 1', 'configuration_error');
  return { enabled, relevance: enabled && relevance === '1', layout: enabled && book === '1' ? 'book' : 'classic' };
}
export const byteLength = (s: string) => new TextEncoder().encode(s).length;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPError(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}
export async function bodyJSON(request: Request, limit = wikiLimits.pageBytes * 2): Promise<Record<string, unknown>> {
  const raw = await readBody(request, limit);
  try { return object(JSON.parse(raw)); } catch (e) {
    if (e instanceof HTTPError) throw e;
    throw new HTTPError(400, 'Invalid JSON');
  }
}
export function text(value: unknown, name: string, max: number, blank = false): string {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value) || value.includes('\0') || byteLength(value) > max || (!blank && !value.trim())) {
    throw new HTTPError(400, `${name} must be ${blank ? '' : 'nonblank '}UTF-8 text, at most ${max} bytes`);
  }
  return value;
}
export function label(value: unknown, name: string, max = 160): string {
  const result = text(value, name, max).trim();
  if (/[\u0000-\u001f\u007f]/u.test(result)) throw new HTTPError(400, `${name} cannot contain control characters`);
  return result;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new HTTPError(400, 'Invalid resource ID');
  return value;
}
export function positive(value: unknown, name: string, fallback?: number): number {
  if (value === null || value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
  }
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new HTTPError(400, `${name} must be a positive integer`);
  return Number(value);
}
export function pageSize(value: string | null): number { return Math.min(wikiLimits.pageSize, positive(value, 'limit', wikiLimits.pageSize)); }
export function revision(request: Request): number {
  const value = request.headers.get('If-Match');
  if (value === null) throw new HTTPError(428, 'If-Match with the current quoted revision is required', 'revision_required');
  if (!/^"[1-9][0-9]*"$/.test(value)) throw new HTTPError(400, 'If-Match must be a quoted revision number');
  return positive(value.slice(1, -1), 'revision');
}
export function strings(value: unknown, name: string, count = 16): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > count) throw new HTTPError(400, `${name} must be an array of at most ${count} strings`);
  return [...new Set(value.map(v => label(v, name, 80)))];
}
export type PageInput = { title: string; path: string; markdown: string; parent_id: string | null; aliases: string[]; tags: string[]; author: string };
export function pageInput(value: Record<string, unknown>): PageInput {
  const path = text(value.path, 'path', 240).replace(/^\//, '');
  if (!/^[a-z0-9]+(?:[a-z0-9/-]*[a-z0-9])?$/.test(path) || path.includes('//')) throw new HTTPError(400, 'path must contain lowercase letters, digits, hyphens and slash-separated segments');
  const markdown = text(value.markdown, 'markdown', wikiLimits.pageBytes, true);
  // A heading is repeated in each passage's index and optional model input.
  if (sections(markdown).some(s => byteLength(s.heading) > 500)) throw new HTTPError(400, 'Section headings cannot exceed 500 UTF-8 bytes');
  return { title: label(value.title, 'title'), path, markdown,
    parent_id: value.parent_id == null || value.parent_id === '' ? null : id(value.parent_id),
    aliases: strings(value.aliases, 'aliases'), tags: strings(value.tags, 'tags'), author: label(value.author ?? 'anonymous', 'author', 80) };
}
export type Section = { section: string; heading: string; level: number; start_line: number; end_line: number; body: string };
// Section identifiers are scoped to a revision. Fences never create headings.
// Split long sections into bounded passages without dropping any source text.
export function sections(markdown: string): Section[] {
  const lines = markdown.split('\n'), out: Section[] = [];
  let heading = 'Introduction', level = 0, start = 1, end = 1, section = 's0', buffer: string[] = [], size = 0, fence = '';
  const flush = () => {
    if (buffer.length) out.push({ section, heading, level, start_line: start, end_line: end, body: buffer.join('\n') });
    buffer = []; size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const h = !fence && /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { flush(); heading = h[2]; level = h[1].length; section = `s${i + 1}`; }
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length && /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)) fence = '';
    }
    // Extremely long lines are split too; line references can overlap.
    let offset = 0;
    do {
      let next = Math.min(offset + 3000, line.length);
      // Keep a supplementary Unicode character together at the boundary.
      if (next < line.length && /[\uD800-\uDBFF]/.test(line[next - 1])) next--;
      const part = line.slice(offset, next);
      if ((offset > 0 || size + part.length > 4000) && buffer.length) flush();
      if (!buffer.length) start = i + 1;
      buffer.push(part); size += part.length + 1; end = i + 1; offset = next;
    } while (offset < line.length);
  }
  flush();
  return out;
}
export type SearchInput = { query: string; related_terms: string[]; context: string; mode: 'keyword' | 'relevance'; limit: number; path: string; tag: string };
export function searchInput(value: Record<string, unknown>): SearchInput {
  const mode = value.mode ?? 'keyword';
  if (mode !== 'keyword' && mode !== 'relevance') throw new HTTPError(400, 'mode must be keyword or relevance');
  return { query: text(value.query, 'query', 500).trim(), related_terms: strings(value.related_terms, 'related_terms', 8),
    context: text(value.context ?? '', 'context', 2000, true), mode,
    limit: Math.min(wikiLimits.candidates, positive(value.limit, 'limit', 10)),
    path: text(value.path ?? '', 'path', 240, true), tag: text(value.tag ?? '', 'tag', 80, true) };
}
export function matchQuery(input: SearchInput): string {
  const words = [...new Set([input.query, ...input.related_terms].join(' ').match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 32);
  // Users supply text, never FTS syntax. SQL parameters alone don't escape MATCH.
  return words.map(word => '"' + word + '"').join(' OR ');
}
export type CommentAnchor = { type: 'page' | 'section'; revision: number; heading?: string };
export function commentAnchor(value: unknown, currentRevision: number, markdown: string): CommentAnchor {
  const anchor = value === undefined ? { type: 'page', revision: currentRevision } : object(value);
  if (anchor.type !== 'page' && anchor.type !== 'section') throw new HTTPError(400, 'Comment anchor must be page or section');
  if (positive(anchor.revision, 'anchor.revision') !== currentRevision) throw new HTTPError(412, 'Page changed; refresh the comment anchor', 'revision_conflict');
  if (anchor.type === 'page') return { type: 'page', revision: currentRevision };
  const heading = label(anchor.heading, 'heading', 500);
  const matches = new Set(sections(markdown).filter(s => s.level && s.heading === heading).map(s => s.section));
  if (matches.size !== 1) throw new HTTPError(400, 'Section heading must identify exactly one section');
  return { type: 'section', revision: currentRevision, heading };
}
