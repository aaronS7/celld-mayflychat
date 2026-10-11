import { AwsClient } from 'aws4fetch';
import { HTTPError } from './protocol';

export interface ArchiveEnv {
  ARCHIVE_STORAGE?: string; ARCHIVES?: R2Bucket;
  ARCHIVE_S3_ENDPOINT?: string; ARCHIVE_S3_BUCKET?: string; ARCHIVE_S3_REGION?: string;
  ARCHIVE_S3_ACCESS_KEY_ID?: string; ARCHIVE_S3_SECRET_ACCESS_KEY?: string; ARCHIVE_S3_SESSION_TOKEN?: string;
}
export const utf8 = new TextEncoder();
export const encodeJSON = (v: unknown) => utf8.encode(JSON.stringify(v));
export async function sha256(data: Uint8Array | ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2,'0')).join('');
}
export interface ArchiveStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, sha256: string): Promise<void>;
}
export function archiveStore(env: ArchiveEnv): ArchiveStore {
  // Celld maps this binding to r2/<bucket_name>/ in its existing fleet bucket.
  const storage = env.ARCHIVE_STORAGE ?? 'r2';
  if (storage === 'r2' && env.ARCHIVES) {
    const bucket = env.ARCHIVES;
    return {
      async get(key) { const object = await bucket.get(key); return object ? new Uint8Array(await object.arrayBuffer()) : null; },
      async put(key, data) { await bucket.put(key, data, { onlyIf: { etagDoesNotMatch: '*' } }); },
    };
  }
  if (storage !== 's3' || !env.ARCHIVE_S3_ENDPOINT || !env.ARCHIVE_S3_BUCKET || !env.ARCHIVE_S3_REGION || !env.ARCHIVE_S3_ACCESS_KEY_ID || !env.ARCHIVE_S3_SECRET_ACCESS_KEY) throw new HTTPError(503, 'Archive storage is not configured');
  const endpoint = new URL(env.ARCHIVE_S3_ENDPOINT);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.ARCHIVE_S3_BUCKET)) throw new HTTPError(503, 'Invalid archive bucket endpoint');
  const client = new AwsClient({accessKeyId: env.ARCHIVE_S3_ACCESS_KEY_ID, secretAccessKey: env.ARCHIVE_S3_SECRET_ACCESS_KEY, sessionToken: env.ARCHIVE_S3_SESSION_TOKEN, region: env.ARCHIVE_S3_REGION, service: 's3', retries: 0});
  // Clear the timer when done: celld keeps an event (including an alarm) open until its timers settle.
  const bounded = async <T>(run: (signal: AbortSignal) => Promise<T>) => { const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30000); try { return await run(abort.signal); } finally { clearTimeout(timer); } };
  const address = (key: string) => endpoint.origin + '/' + env.ARCHIVE_S3_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  return {
    get: key => bounded(async signal => {
      const response = await client.fetch(address(key), { redirect: 'error', signal });
      if (response.status === 404) return null;
      if (!response.ok) { await response.body?.cancel(); throw new Error('Archive read failed'); }
      return new Uint8Array(await response.arrayBuffer());
    }),
    put: (key, data, hash) => bounded(async signal => {
      const response = await client.fetch(address(key), { method: 'PUT', body: data, headers: {'If-None-Match':'*', 'x-amz-content-sha256':hash}, redirect:'error', signal });
      await response.body?.cancel();
      if (!response.ok && response.status !== 412) throw new Error('Archive write failed');
    }),
  };
}
// A write acknowledgement alone is insufficient to authorize erasure. Verify
// bytes read back from the bucket, including when a retry finds an existing key.
export async function putVerified(store: ArchiveStore, key: string, bytes: Uint8Array) {
  const hash = await sha256(bytes);
  await store.put(key, bytes, hash);
  await readVerified(store, {key, size:bytes.length, sha256:hash});
  return {key, size: bytes.length, sha256:hash};
}
export async function readVerified(store: ArchiveStore, object: {key: string; size?: number; sha256: string}) {
  const bytes = await store.get(object.key);
  if (!bytes || object.size !== undefined && bytes.length !== object.size || await sha256(bytes) !== object.sha256) throw new Error('Archive integrity check failed');
  return bytes;
}
