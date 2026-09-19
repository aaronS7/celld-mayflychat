// Build the reference from the same native docs the application serves.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { nativeDocumentation } from '../../celld/documentation.mjs';

const repo = 'https://github.com/aaronS7/celld-mayflychat/blob/main/';
const base = process.env.BASE_PATH || '/celld-mayflychat/';
if (!base.startsWith('/') || !base.endsWith('/')) throw new Error('BASE_PATH must start and end with /');
const upstream = {};
for (const name of await readdir(new URL('../../srv/docs/', import.meta.url))) {
  if (name !== 'README.md') upstream[`docs/${name}`] = await readFile(new URL(`../../srv/docs/${name}`, import.meta.url), 'utf8');
}
const native = await nativeDocumentation(upstream);
const pages = new Map();
for (const [file, text] of Object.entries(native)) {
  if (!file.endsWith('.md')) continue;
  const name = posix.basename(file, '.md');
  const overridden = ['hosting', 'operations', 'configuration', 'security', 'security-model', 'tagging', 'wiki', 'summaries', 'scheduled-reports'].includes(name);
  pages.set(name, { text, source: `${overridden ? 'celld' : 'srv'}/${file}` });
}
for (const [name, source] of [['jev', 'celld/JEV.md'], ['tagging-verification', 'celld/TAGGING-VERIFICATION.md'], ['wiki-verification', 'celld/WIKI-VERIFICATION.md'], ['mercury-deployment', 'celld/swamp/README.md']]) {
  pages.set(name, { text: await readFile(new URL(`../../${source}`, import.meta.url), 'utf8'), source });
}
const destination = new URL('../pages/reference/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const [name, { text, source }] of pages) {
  const rewritten = text.replace(/\]\(([^\s)]+)\)/g, (match, target) => {
    if (target === repo + 'celld/swamp/README.md') return '](/reference/mercury-deployment)';
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
  const provenance = source.startsWith('srv/')
    ? `Adapted for native celld from the [upstream reference](${repo}${source}) by [nativeDocumentation](${repo}celld/documentation.mjs).`
    : `Generated from the application documentation. [View source](${repo}${source}).`;
  await writeFile(new URL(`${name}.md`, destination), `---\neditLink: false\n---\n\n${rewritten}\n\n---\n\n<span class="source-note">${provenance}</span>\n`);
}
const index = `# Mayfly documentation\n\n> Linked chats and persistent wikis for agents and humans, with optional Jev search and Mercury summaries.\n\nThis is the static documentation site. API routes, /config, /llms.txt and /static/ client downloads described in the references belong to your Mayfly application server, not this site. Use that server's origin for requests and keep full capability URLs private.\n\n## Start here\n\n- [Agent onboarding](${base}guide/agents.html): Download clients, handle cursors, discover companions and consume summaries.\n- [Persistent wikis](${base}guide/wiki.html): Human and agent workflows, search and discussion.\n- [AI summaries](${base}guide/summaries.html): Header controls, explicit source coverage and privacy.\n\n## Reference\n\n`;
await writeFile(new URL('../public/llms.txt', import.meta.url), index + [...pages.keys()].map(name => `- [${name}](${base}reference/${name}.html)`).join('\n') + '\n');
console.log(`Synced ${pages.size} reference pages from Mayfly's native documentation.`);
