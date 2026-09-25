// This adapter is bundled with browser/spaces.js by generate.mjs.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export { MayflySpaces };
const usage = `node spaces.mjs create-chat ORIGIN [--wiki TITLE]
node spaces.mjs create-wiki ORIGIN TITLE [--chat]
node spaces.mjs wiki FULL_CHAT_URL [TITLE]
node spaces.mjs chat FULL_WIKI_URL
node spaces.mjs links FULL_URL
node spaces.mjs link FULL_CHAT_URL FULL_WIKI_URL
node spaces.mjs remove FULL_URL COMPANION_ID
node spaces.mjs resume RECOVERY_JSON_FILE

JSON output contains access URLs: keep it private. Linking shares access with
everyone holding either URL, including other participants in the linked wiki.
Removing a shortcut does not revoke access. Chat expiry leaves the wiki intact.
On failure, save the JSON output and resume to retry the same resources.`;
async function main([command,...args]) {
  if (command === '--help' || command === '-h') { process.stdout.write(usage+'\n'); return; }
  const [first,second,third] = args;
  let pending;
  if (command === 'create-chat' && (args.length === 1 || (args.length === 3 && second === '--wiki'))) pending = await MayflySpaces.plan(first,{chat:true,wiki:!!third,title:third});
  else if (command === 'create-wiki' && (args.length === 2 || (args.length === 3 && third === '--chat'))) pending = await MayflySpaces.plan(first,{wiki:true,chat:third === '--chat',title:second});
  else if (command === 'wiki' && [1,2].includes(args.length)) pending = await MayflySpaces.plan(new URL(first).origin,{chat:first,wiki:true,title:second});
  else if (command === 'chat' && args.length === 1) pending = await MayflySpaces.plan(new URL(first).origin,{wiki:first,chat:true});
  else if (command === 'resume' && args.length === 1) { const saved = JSON.parse(await readFile(first,'utf8')); pending = saved.recovery || saved; }
  let output;
  if (pending) output = await MayflySpaces.complete(pending);
  else if (command === 'links' && args.length === 1) output = {links:await MayflySpaces.links(first)};
  else if (command === 'link' && args.length === 2) {
    try { output = await MayflySpaces.link(first,second); }
    catch (e) { e.recovery = {chat_url:first,wiki_url:second,create_chat:false,create_wiki:false}; throw e; }
  }
  else if (command === 'remove' && args.length === 2) output = await MayflySpaces.remove(first,second);
  else throw new Error(usage);
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(process.argv.slice(2)); }
  catch (e) {
    process.stdout.write(JSON.stringify({error:e.message,...(e.recovery ? {recovery:e.recovery} : {})},null,2)+'\n');
    process.exitCode = 1;
  }
}
