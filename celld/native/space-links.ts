import { b64, canonicalID, HTTPError, json, unb64 } from './protocol';
import { bodyJSON, label } from './wiki-core';

// Capabilities are sealed by clients. These records never enter messages,
// reports, the wiki content index, or model input.
type Link = { id: string; kind: string; title: string; nonce: string; ct: string; created_at: string };
const exists = (sql: SqlStorage) => sql.exec("SELECT 1 FROM sqlite_master WHERE name='linked_spaces' AND type='table'").toArray().length > 0;
export function clearSpaceLinks(sql: SqlStorage): void {
  if (exists(sql)) sql.exec('DELETE FROM linked_spaces');
}
export async function spaceLinks(request: Request, path: string, kind: 'chat' | 'wiki', sql: SqlStorage, authorize: () => void | Promise<void>): Promise<Response> {
  const match = /^\/links(?:\/([^/]+))?$/.exec(path);
  if (!match) throw new HTTPError(404, 'No such link route');
  const id = match[1];
  if (id && !canonicalID(id)) throw new HTTPError(400, 'Invalid linked resource ID');
  if (!id && (request.method === 'GET' || request.method === 'HEAD')) {
    await authorize();
    return json({ links: exists(sql) ? sql.exec<Link>('SELECT * FROM linked_spaces ORDER BY created_at,id').toArray() : [] });
  }
  if (id && request.method === 'DELETE') {
    await authorize();
    if (exists(sql)) sql.exec('DELETE FROM linked_spaces WHERE id=?', id);
    return new Response(null, { status: 204 });
  }
  if (!id || request.method !== 'PUT') throw new HTTPError(404, 'No such link route');
  const input = await bodyJSON(request, 4096);
  const title = label(input.title, 'title');
  if (input.kind !== (kind === 'chat' ? 'wiki' : 'chat')) throw new HTTPError(400, 'Link must connect a chat and a wiki');
  for (const [field, min, max] of [['nonce', 12, 12], ['ct', 32, 1024]] as const) {
    const value = input[field], bytes = typeof value === 'string' ? unb64(value) : undefined;
    if (!bytes || bytes.length < min || bytes.length > max || b64(bytes) !== value) throw new HTTPError(400, `Invalid sealed link ${field}`);
  }
  // The body read can overlap deletion, expiry, or a new chat generation.
  await authorize();
  sql.exec('CREATE TABLE IF NOT EXISTS linked_spaces(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,nonce TEXT NOT NULL,ct TEXT NOT NULL,created_at TEXT NOT NULL)');
  const old = sql.exec<Link>('SELECT * FROM linked_spaces WHERE id=?', id).toArray()[0];
  if (old) return json(old); // Retrying a reciprocal write must be idempotent.
  if (sql.exec<{ n: number }>('SELECT COUNT(*) n FROM linked_spaces').one().n >= 100) throw new HTTPError(429, 'Limit of 100 companion links reached; remove an old shortcut first');
  const link = { id, kind: input.kind, title, nonce: input.nonce as string, ct: input.ct as string, created_at: new Date().toISOString() };
  sql.exec('INSERT INTO linked_spaces VALUES (?,?,?,?,?,?)', link.id, link.kind, link.title, link.nonce, link.ct, link.created_at);
  return json(link, 201);
}
