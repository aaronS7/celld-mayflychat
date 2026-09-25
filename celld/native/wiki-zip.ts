// ZIP32, stored entries, UTF-8 names and signed data descriptors (PKWARE APPNOTE).
// Backpressure keeps only the current chunk plus the central directory in memory.
import { HTTPError } from './protocol';

export const exportLimits = { bytes: 1_073_741_824, entries: 50_000, namesBytes: 8_388_608, readyMS: 300_000, downloadMS: 1_800_000 };
export type ZipEntry = { name: string; size: number; data: () => AsyncIterable<Uint8Array> };
export const utf8 = (value: string) => new TextEncoder().encode(value);
export async function* zipText(value: string) { yield utf8(value); }
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function header(length: number, fields: [number, number, number][]) {
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  for (const [offset, size, value] of fields) size === 2 ? view.setUint16(offset, value, true) : view.setUint32(offset, value, true);
  return bytes;
}
export function zipSize(entries: Pick<ZipEntry, 'name' | 'size'>[]): number {
  if (entries.length > exportLimits.entries) throw new HTTPError(413, 'Export exceeds 50,000 files', 'export_limit');
  const names = new Set<string>(); let total = 22, nameBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !entry.name || entry.name.startsWith('/') || /[\\\x00-\x1f]/.test(entry.name) || entry.name.split('/').some(p => !p || p === '.' || p === '..') || names.has(entry.name.toLowerCase())) throw new Error('Invalid ZIP entry');
    names.add(entry.name.toLowerCase());
    const size = utf8(entry.name).length; nameBytes += size;
    if (size > 65535 || nameBytes > exportLimits.namesBytes) throw new HTTPError(413, 'Export filename budget exceeded', 'export_limit');
    total += 30 + size + entry.size + 16 + 46 + size;
    if (total > exportLimits.bytes) throw new HTTPError(413, 'Export exceeds 1 GiB, including Markdown, metadata, attachments and ZIP overhead', 'export_limit');
  }
  return total;
}
export async function* zipChunks(entries: ZipEntry[], check: () => void, progress: (bytes: number) => void = () => {}) {
  const expected = zipSize(entries), central: Uint8Array[] = [];
  let offset = 0;
  const emit = (bytes: Uint8Array) => { offset += bytes.length; progress(offset); return bytes; };
  for (const entry of entries) {
    check(); const start = offset, name = utf8(entry.name);
    // A stable DOS date (1980-01-01). Source timestamps live in the metadata.
    yield emit(header(30, [[0,4,0x04034b50],[4,2,20],[6,2,0x808],[12,2,33],[26,2,name.length]]));
    yield emit(name);
    let size = 0, crc = 0;
    for await (const chunk of entry.data()) {
      check(); size += chunk.length;
      if (size > entry.size) throw new Error('Export entry grew');
      crc = crc32(chunk, crc); yield emit(chunk);
    }
    check(); if (size !== entry.size) throw new Error('Export entry is incomplete');
    yield emit(header(16, [[0,4,0x08074b50],[4,4,crc],[8,4,size],[12,4,size]]));
    central.push(header(46, [[0,4,0x02014b50],[4,2,20],[6,2,20],[8,2,0x808],[14,2,33],[16,4,crc],[20,4,size],[24,4,size],[28,2,name.length],[42,4,start]]), name);
  }
  const directory = offset;
  for (const chunk of central) { check(); yield emit(chunk); }
  check(); const length = offset - directory;
  yield emit(header(22, [[0,4,0x06054b50],[8,2,entries.length],[10,2,entries.length],[12,4,length],[16,4,directory]]));
  if (offset !== expected) throw new Error('Export length mismatch');
}

export function exportName(name: string): string {
  let safe = name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+/, '_');
  if (!safe) safe = 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = '_' + safe;
  return safe;
}
export const exportPageName = (path: string) => 'pages/' + path.split('/').map(exportName).join('/') + '.md';
export function relativeFile(from: string, to: string) {
  const a = from.split('/'); a.pop(); const b = to.split('/');
  while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
  return [...a.map(() => '..'), ...b.map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()))].join('/');
}

// Mayfly's page:/attachment: targets have a deliberately small grammar. Preserve
// code examples, raw HTML and ordinary text; rewrite Markdown destinations only.
function rewriteWikiLinks(source: string, destination: (kind: 'page' | 'attachment', id: string) => string | undefined): string {
  let fence = '', inline = '', html = '', result = '', brackets = 0, skipTo = 0;
  const lists: number[] = [];
  for (const row of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = row[0];
    if (row.index + line.length <= skipTo) continue;
    if (html === 'block') { result += line; if (!line.trim()) html = ''; continue; }
    // A destination can cross lines; block classification must not re-read its
    // already consumed prefix as an indented code block or an HTML opener.
    let content = skipTo > row.index ? '' : line.replace(/^(?: {0,3}> ?)+/, '');
    if (!inline && !fence && !html && content.trim()) {
      const indent = /^ */.exec(content)![0].length;
      while (lists.length && indent < lists.at(-1)!) lists.pop();
      const base = lists.at(-1) ?? 0;
      content = content.slice(base);
      const bullet = /^ {0,3}(?:[-+*]|\d+[.)]) +/.exec(content);
      if (bullet) { lists.push(base + bullet[0].length); content = content.slice(bullet[0].length); }
    } else if (lists.length) content = content.slice(Math.min(/^ */.exec(content)![0].length, lists.at(-1)!));
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(content);
    if (fence) { if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(content)) fence = ''; result += line; continue; }
    if (mark && !inline) { fence = mark[1]; result += line; continue; }
    const autolinkLine = /^ {0,3}<(?:page|attachment):[a-f0-9-]{36}>/.test(content);
    if (!inline && (/^(?: {4}|\t)/.test(content) || /^ {0,3}</.test(content) && !autolinkLine)) {
      if (/^ {0,3}<!--/.test(content)) html = '-->';
      else { const open = /^ {0,3}<(script|style|pre|textarea)\b/i.exec(content); if (open) html = '</' + open[1].toLowerCase() + '>';
        else if (/^ {0,3}<\/?(?:address|article|aside|blockquote|details|dialog|div|dl|fieldset|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)\b/i.test(content)) html = 'block'; }
      if (html && html !== 'block' && content.toLowerCase().includes(html)) html = '';
      result += line; continue;
    }
    if (html) { if (content.toLowerCase().includes(html)) html = ''; result += line; continue; }
    let i = Math.max(0, skipTo - row.index);
    while (i < line.length) {
      if (line[i] === '\\' && !inline) { result += line.slice(i, i + 2); i += 2; continue; }
      if (line[i] === '`') {
        const run = /^`+/.exec(line.slice(i))![0];
        if (inline === run) inline = '';
        else if (!inline) {
          const rest = source.slice(row.index + i + run.length).split(/\n[ \t]*\n/, 1)[0];
          if ([...rest.matchAll(/`+/g)].some(match => match[0] === run)) inline = run;
        }
        result += run; i += run.length; continue;
      }
      if (!inline) {
        const auto = line[i] === '<' && /^<(page|attachment):([a-f0-9-]{36})>/.exec(line.slice(i));
        if (auto) {
          const target = destination(auto[1] as 'page' | 'attachment', auto[2]);
          result += target ? '[' + auto[1] + ':' + auto[2] + '](' + target + ')' : auto[0]; i += auto[0].length; continue;
        }
        if (line[i] === '[') brackets++;
        const match = line[i] === ']' && /^(\]\(\s*<?|\]:\s*<?)(page|attachment):([a-f0-9-]{36})(?=>?(?:\s|\)|$))/.exec(source.slice(row.index + i));
        if (match && brackets) {
          brackets--;
          const target = destination(match[2] as 'page' | 'attachment', match[3]);
          result += target ? match[1] + target : match[0]; i += match[0].length; skipTo = row.index + i; continue;
        }
        if (line[i] === ']') brackets = Math.max(0, brackets - 1);
      }
      result += line[i++];
    }
  }
  return result;
}
export function exportReferences(source: string): { pages: string[]; attachments: string[] } {
  const pages = new Set<string>(), attachments = new Set<string>();
  rewriteWikiLinks(source, (kind, id) => { (kind === 'page' ? pages : attachments).add(id); return undefined; });
  return { pages: [...pages], attachments: [...attachments] };
}
export function exportMarkdown(source: string, from: string, pages: Map<string, string>, files: Map<string, string>): string {
  return rewriteWikiLinks(source, (kind, id) => {
    const target = (kind === 'page' ? pages : files).get(id);
    return target ? relativeFile(from, target) : undefined;
  });
}
