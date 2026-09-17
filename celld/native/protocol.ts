export const limits = { createBody: 4096, eventBody: 700074, blob: 524288, channel: 1048576, events: 10000, page: 500 };
export const messages = {
  auth: "missing or wrong bearer: use the client-derived auth value, not the URL key",
  create: 'body must be JSON {"id","auth_hash"}; generate the key locally',
  id: 'id must be 16 bytes as 22 chars of unpadded base64url: HKDF(K, "mayfly id")',
  hash: "auth_hash must be 32 bytes as unpadded base64url: sha256 of the base64url auth string",
  blob: 'body must be JSON {"nonce":"<base64url 12 bytes>","ct":"<base64url>"}',
  big: "request or sealed event too large (ciphertext limit: 524288 bytes)",
  full: "channel is full (limits: 10000 events, 1048576 bytes total)",
  quota: "channel creation rate limit reached; try again later",
  route: "no such endpoint; use GET|POST /c/<id>/events, DELETE /c/<id>; instructions at GET /c/<id>",
};
export class HTTPError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value) + "\n", { status, headers: { "Content-Type": "application/json" } });
export const plain = (value: string, status = 200) => new Response(value, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
export function failure(error: unknown): Response {
  if (error instanceof HTTPError) return json({ error: error.message, ...(error.code ? { code: error.code, posted: false } : {}) }, error.status);
  // Never log request-derived error strings, URLs, bearer tokens, or bodies.
  console.error("internal request failure");
  return json({ error: "internal error" }, 500);
}
export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unb64(value: string): Uint8Array | undefined {
  // Match Go's RawURLEncoding.DecodeString(strings.TrimRight(s, "=")):
  // allow CR/LF and noncanonical trailing bits, but no +, /, or interior =.
  const raw = value.replace(/=+$/, "").replace(/[\r\n]/g, "");
  if (!/^[\w-]*$/.test(raw) || raw.length % 4 === 1) return;
  try { return Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)); } catch { return; }
}
export function canonicalID(id: string): boolean {
  const bytes = unb64(id);
  return bytes?.length === 16 && b64(bytes) === id;
}
export async function readBody(request: Request, limit: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new HTTPError(413, `request body too large (limit: ${limit} bytes)`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    throw new HTTPError(400, "cannot read request body");
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  // Go's JSON decoder replaces malformed UTF-8, and does not strip a BOM.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}
export function stringFields(body: string, names: string[], error: string): Record<string, string> {
  const result = Object.fromEntries(names.map(name => [name, ""]));
  try {
    const parsed = JSON.parse(body);
    if (parsed === null) return result;
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    // Preserve duplicate-field order and type errors just like Go struct decoding.
    // JSON.parse alone would hide invalid values overwritten by a later field.
    const tokens = body.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)!;
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "{" || token === "[") { if (++depth > 10000) throw new Error(); }
      else if (token === "}" || token === "]") depth--;
      else if (depth === 1 && token.startsWith('"') && tokens[i + 1] === ":") {
        const key = JSON.parse(token).replace(/ſ/g, "s").toLowerCase();
        if (!names.includes(key)) continue;
        const value = tokens[i + 2];
        if (value === "null") continue;
        if (!value.startsWith('"')) throw new Error();
        result[key] = JSON.parse(value);
      }
    }
    return result;
  } catch { throw new HTTPError(400, error); }
}
export function query(url: URL): URLSearchParams {
  // Go drops malformed pairs (including unescaped semicolons), not the query.
  return new URLSearchParams(url.search.slice(1).split("&").filter(pair => !pair.includes(";") && !/%(?![a-f\d]{2})/i.test(pair)).join("&"));
}
export function cursor(value: string | null, name: "since" | "last"): bigint {
  if (!value) {
    if (name === "since") return -1n;
    throw new HTTPError(400, "missing last=N (the id of the newest event you have read)");
  }
  try {
    if (!/^[+-]?\d+$/.test(value)) throw new Error();
    const n = BigInt(value);
    if (n < -1n || n > 9223372036854775807n) throw new Error();
    return n;
  } catch { throw new HTTPError(400, `${name} must be an integer >= -1`); }
}
export function waitSeconds(value: string | null): number {
  if (!value) return 0;
  try {
    if (!/^[+-]?\d+$/.test(value)) throw new Error();
    const n = BigInt(value);
    if (n < 0n || n > 9223372036854775807n) throw new Error();
    return Number(n > 86400n ? 86400n : n);
  } catch { throw new HTTPError(400, "wait must be a non-negative integer (seconds)"); }
}
export async function bearerHash(request: Request): Promise<Uint8Array | undefined> {
  const header = request.headers.get("Authorization") || "";
  // Go strings.TrimSpace includes NEL and excludes JavaScript's BOM whitespace.
  const bearer = header.startsWith("Bearer ") ? header.slice(7).replace(/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "") : "";
  if (!bearer) return;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)));
}
export function sourceIP(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return ""; // Fetch exposes no authenticated socket peer.
  const ip = (request.headers.get("X-Forwarded-For") || "").split(",").at(-1)!.trim();
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(ip)) return ip.split(".").every(n => +n <= 255) ? ip : "";
  if (!/^[a-f\d:.]+$/i.test(ip) || !ip.includes(":")) return "";
  try {
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f\d]+):([a-f\d]+)$/.exec(canonical);
    if (mapped) return mapped.slice(1).flatMap(n => [parseInt(n, 16) >> 8, parseInt(n, 16) & 255]).join(".");
    return canonical;
  } catch { return ""; }
}
