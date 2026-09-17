// Build the reference from the same native docs the application serves.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { nativeDocumentation } from '../../celld/documentation.mjs';

const repo = 'https://github.com/aaronS7/celld-mayflychat/blob/main/';
const upstream = {};
for (const name of await readdir(new URL('../../srv/docs/', import.meta.url))) {
  if (name !== 'README.md') upstream[`docs/${name}`] = await readFile(new URL(`../../srv/docs/${name}`, import.meta.url), 'utf8');
}
const native = await nativeDocumentation(upstream);
const pages = new Map();
for (const [file, text] of Object.entries(native)) {
  if (!file.endsWith('.md')) continue;
  const name = posix.basename(file, '.md');
  const overridden = ['hosting', 'operations', 'configuration', 'security', 'security-model', 'tagging'].includes(name);
  pages.set(name, { text, source: `${overridden ? 'celld' : 'srv'}/${file}` });
}
for (const [name, source] of [['jev', 'celld/JEV.md'], ['tagging-verification', 'celld/TAGGING-VERIFICATION.md']]) {
  pages.set(name, { text: await readFile(new URL(`../../${source}`, import.meta.url), 'utf8'), source });
}
const destination = new URL('../pages/reference/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const [name, { text, source }] of pages) {
  const rewritten = text.replace(/\]\(([^\s)]+)\)/g, (match, target) => {
    if (/^(?:[a-z]+:|#)/i.test(target)) return match;
    const [path, hash] = target.split('#');
    const anchor = hash ? `#${hash}` : '';
    const basename = posix.basename(path, '.md');
    if (path.endsWith('.md') && pages.has(basename)) return `](/reference/${basename}${anchor})`;
    if (path.includes('static/')) return `](${repo}celld/static/${posix.basename(path)}${anchor})`;
    if (path === '/llms.txt') return '](/guide/agents)';
    if (path.startsWith('/')) return match;
    return `](${repo}${posix.normalize(posix.join(posix.dirname(source), path))}${anchor})`;
  });
  await writeFile(new URL(`${name}.md`, destination), `---\neditLink: false\n---\n\n${rewritten}\n\n---\n\n<span class="source-note">Generated from the application documentation. [View source](${repo}${source}).</span>\n`);
}
console.log(`Synced ${pages.size} reference pages from Mayfly's native documentation.`);
