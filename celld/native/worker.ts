import { DurableObject } from "cloudflare:workers";
import { b64, bearerHash, canonicalID, cursor, failure, HTTPError, json, limits, messages, plain, query, readBody, sourceIP, stringFields, unb64, waitSeconds } from "./protocol";
import { channelPage, missingText, publicPage, retentionMS, secure, timestamp } from "./pages";
import { settings, type SettingsEnv } from "./settings";
import { incomingMessage } from "./message";
import { ModerationUnavailable, screenMessage } from "./moderation";

interface Env extends SettingsEnv {
  CHATS: DurableObjectNamespace<Chat>;
  CREATION: DurableObjectNamespace<CreationGate>;
  RETENTION_SECONDS?: string;
  TRUST_PROXY?: string;
}
type Metadata = { auth: ArrayBuffer; head: number; bytes: number; activity: number; encrypted: number; generation: string };
type EventRow = { seq: number; ts: number; src: string; nonce: ArrayBuffer; ct: ArrayBuffer; message: string | null };
type Envelope = { seq: number; ts: string; src: string; nonce: string } & ({ ct: string } | { from: string; text: string });
type Page = { last: number; more: boolean; events: Envelope[] };

// One object owns one channel. Its message format is fixed at creation.
export class Chat extends DurableObject<Env> {
  private sql: SqlStorage;
  private initialized: boolean;
  private waiters = new Set<() => void>();
  private retention: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.retention = retentionMS(env);
    // A probe of an unknown channel must not write a database for that ID.
    this.initialized = this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='channel'").toArray().length > 0;
    if (this.initialized) this.ctx.storage.transactionSync(() => {
      const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(channel)").toArray().map(row => row.name);
      // Databases from the ciphertext-only implementation always remain encrypted.
      if (!columns.includes("encrypted")) this.sql.exec("ALTER TABLE channel ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1");
      if (!columns.includes("generation")) this.sql.exec("ALTER TABLE channel ADD COLUMN generation TEXT NOT NULL DEFAULT ''");
      const events = this.sql.exec<{ name: string }>("PRAGMA table_info(events)").toArray().map(row => row.name);
      if (!events.includes("message")) this.sql.exec("ALTER TABLE events ADD COLUMN message TEXT");
    });
  }
  private metadata(): Metadata | undefined {
    if (!this.initialized) return;
    return this.sql.exec<Metadata>("SELECT auth, head, bytes, activity, encrypted, generation FROM channel WHERE singleton=1").toArray()[0];
  }
  private require(): Metadata {
    const metadata = this.metadata();
    if (!metadata) throw new HTTPError(404, missingText(this.retention));
    return metadata;
  }
  private authorize(hash: Uint8Array | undefined): Metadata {
    const metadata = this.require();
    if (!hash || !crypto.subtle.timingSafeEqual(hash, metadata.auth)) throw new HTTPError(401, messages.auth);
    return metadata;
  }
  private notify(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  private erase(): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM events");
      this.sql.exec("DELETE FROM channel");
    });
    this.notify();
  }
  private async expire(): Promise<void> {
    const metadata = this.metadata();
    if (metadata && this.retention && Date.now() > metadata.activity + this.retention) {
      this.erase();
      // Enqueue this before yielding, so it cannot erase a new create's alarm.
      await this.ctx.storage.deleteAlarm();
    }
  }
  private schedule(): Promise<void> {
    const metadata = this.metadata();
    return metadata && this.retention ? this.ctx.storage.setAlarm(metadata.activity + this.retention + 1) : this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    await this.expire();
    // An earlier alarm can race with an activity refresh. Always recheck SQL.
    await this.schedule();
  }
  private page(since: bigint): Page {
    const metadata = this.require();
    const page: Page = { last: metadata.head, more: false, events: [] };
    if (since >= BigInt(metadata.head)) return page;
    // This block is synchronous: metadata and events share one input turn.
    const rows = this.sql.exec<EventRow>("SELECT seq, ts, src, nonce, ct, message FROM events WHERE seq>? ORDER BY seq LIMIT ?", Number(since), limits.page).toArray();
    let bytes = 0;
    for (const row of rows) {
      const ct = new Uint8Array(row.ct);
      const size = row.message === null ? ct.length : new TextEncoder().encode(row.message).length;
      if (page.events.length && bytes + size > limits.channel) break;
      bytes += size;
      page.events.push({ seq: row.seq, ts: timestamp(row.ts), src: row.src, nonce: b64(new Uint8Array(row.nonce)),
        ...(metadata.encrypted ? { ct: b64(ct) } : JSON.parse(row.message!)) });
    }
    if (page.events.length) {
      page.last = page.events.at(-1)!.seq;
      page.more = page.last < metadata.head;
    }
    return page;
  }
  private async poll(since: bigint, seconds: number, signal: AbortSignal): Promise<Page> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      // Register and take the snapshot without an await between them.
      let wake!: () => void;
      const changed = new Promise<void>(resolve => { wake = resolve; });
      this.waiters.add(wake);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const page = this.page(since);
        const remaining = deadline - Date.now();
        if (page.events.length || remaining <= 0 || signal.aborted) return page;
        timer = setTimeout(wake, remaining);
        signal.addEventListener("abort", wake, { once: true });
        await changed;
        if (signal.aborted || Date.now() >= deadline) return page;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(wake);
        signal.removeEventListener("abort", wake);
      }
    }
  }
  async fetch(request: Request): Promise<Response> {
    try { return await this.handle(request); } catch (error) {
      if (error instanceof ModerationUnavailable) return json({ error: error.message, code: "moderation_unavailable", posted: false }, 503);
      return failure(error);
    }
  }
  private async handle(request: Request): Promise<Response> {
    await this.expire();
    const url = new URL(request.url);
    // Only the creation gate constructs this private request; the public router
    // never forwards arbitrary paths or client-supplied internal headers.
    if (url.pathname === "/_create" && request.method === "POST") {
      const { auth_hash, encryption } = await request.json<{ auth_hash: string; encryption: string }>();
      const config = settings(this.env);
      if (encryption !== (config.encryption ? "1" : "0")) throw new HTTPError(412, "Server encryption setting changed. Reload and create a new channel.", "mode_changed");
      if (this.metadata()) throw new HTTPError(409, "a channel with this id exists");
      const auth = unb64(auth_hash);
      if (!auth || auth.length !== 32) throw new Error("Invalid internal create");
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("CREATE TABLE IF NOT EXISTS channel (singleton INTEGER PRIMARY KEY CHECK(singleton=1), auth BLOB NOT NULL, head INTEGER NOT NULL, bytes INTEGER NOT NULL, activity INTEGER NOT NULL, encrypted INTEGER NOT NULL, generation TEXT NOT NULL)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, src TEXT NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL, message TEXT)");
        this.sql.exec("INSERT INTO channel (singleton, auth, head, bytes, activity, encrypted, generation) VALUES (1, ?, -1, 0, ?, ?, ?)", auth, Math.floor(Date.now() / 1000) * 1000, Number(config.encryption), crypto.randomUUID());
      });
      this.initialized = true;
      await this.schedule();
      return new Response(null, { status: 204 });
    }
    const match = /^\/c\/([^/]+)(\/.*)?$/.exec(url.pathname)!;
    if (!match) throw new Error("Invalid internal route");
    const path = match[2] || "";
    const get = request.method === "GET" || request.method === "HEAD";
    if (!path && get) {
      const metadata = this.metadata();
      return channelPage(request, decodeURIComponent(match[1]), metadata?.activity, this.retention, settings(this.env, metadata ? Boolean(metadata.encrypted) : undefined));
    }
    if (path !== "/events" && !(path === "/config" && get) && !(path === "" && request.method === "DELETE") || path === "/events" && !get && request.method !== "POST") {
      this.require();
      throw new HTTPError(404, messages.route);
    }
    // Match Go's precedence: absent channel, then auth, then query/body errors.
    this.require();
    const hash = await bearerHash(request);
    const original = this.authorize(hash);
    if (path === "/config") return json(settings(this.env, Boolean(original.encrypted)));
    if (request.method === "DELETE") {
      this.erase();
      await this.ctx.storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    const q = query(url);
    const since = cursor(q.get(get ? "since" : "last"), get ? "since" : "last");
    const wait = waitSeconds(q.get("wait"));
    if (get) return json(await this.poll(since, wait, request.signal));
    const config = settings(this.env, Boolean(original.encrypted));
    if (!config.postingAllowed) throw new HTTPError(412, "Server encryption setting changed. Create a new channel to send messages.", "mode_changed");
    const { nonce, ct, message, bytes } = incomingMessage(await readBody(request, limits.eventBody), config.encryption);
    const check = () => {
      const metadata = this.authorize(hash);
      if (metadata.generation !== original.generation) throw new HTTPError(412, "Channel was replaced. Reload before posting.", "channel_changed");
      if (BigInt(metadata.head) !== since) return this.page(since);
      if (metadata.head + 1 >= limits.events || metadata.bytes + bytes > limits.channel) throw new HTTPError(429, messages.full);
    };
    const stale = check();
    if (stale) return json({ error: "conflict", posted: false, ...stale }, 409);
    if (config.moderation && message) {
      const decision = await screenMessage(message, this.env);
      if (decision.enabled && !decision.allowed) {
        // Only validated category names and probabilities go into operator logs.
        // Never include the message, sender, channel, nonce, credentials, or
        // untrusted provider text. Keep these diagnostics out of HTTP replies.
        console.warn(JSON.stringify({
          event: "moderation_rejected",
          timestamp: new Date().toISOString(),
          provider: "typesafe",
          blockedBy: decision.blockedBy,
          probabilities: decision.probabilities,
          threshold: decision.threshold,
        }));
        return json({ error: "Message rejected by Jev screening.", code: "moderation_rejected", posted: false }, 422);
      }
    }
    // Provider/body awaits can overlap expiry, deletion, or another append.
    await this.expire();
    let seq = -1;
    const conflict = this.ctx.storage.transactionSync(() => {
      const conflict = check();
      if (conflict) return conflict;
      const metadata = this.authorize(hash);
      seq = metadata.head + 1;
      const now = Math.floor(Date.now() / 1000) * 1000;
      this.sql.exec("INSERT INTO events (seq, ts, src, nonce, ct, message) VALUES (?, ?, ?, ?, ?, ?)", seq, now, request.headers.get("X-Mayfly-Source") || "", nonce, ct, message ? JSON.stringify(message) : null);
      this.sql.exec("UPDATE channel SET head=?, bytes=bytes+?, activity=? WHERE singleton=1", seq, bytes, now);
    });
    if (conflict) return json({ error: "conflict", posted: false, ...conflict }, 409);
    // Persist the expiry before the handler can acknowledge the write. celld's
    // output gate protects responses from other readers of this committed row.
    const scheduled = this.schedule();
    this.notify();
    await scheduled;
    return json({ posted: true, id: seq, ...await this.poll(BigInt(seq), wait, request.signal) });
  }
}

// Creation alone crosses two objects. Serialize quota checks, channel creation,
// and charging; ordinary chat traffic never passes through this object.
export class CreationGate extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS quotas (ip TEXT PRIMARY KEY, tokens REAL NOT NULL, updated REAL NOT NULL)");
  }
  fetch(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.create(request)).catch(failure);
    this.queue = result;
    return result;
  }
  private async create(request: Request): Promise<Response> {
    const { id, auth_hash, ip, encryption } = await request.json<{ id: string; auth_hash: string; ip: string; encryption: string }>();
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const bucket = sql.exec<{ tokens: number; updated: number }>("SELECT tokens, updated FROM quotas WHERE ip=?", ip).toArray()[0];
    const tokens = bucket ? Math.min(100, bucket.tokens + Math.max(0, now - bucket.updated) / 864000) : 100;
    if (tokens < 1) throw new HTTPError(429, messages.quota);
    const chat = this.env.CHATS.get(this.env.CHATS.idFromName(id));
    const response = await chat.fetch(new Request("https://mayfly.internal/_create", { method: "POST", body: JSON.stringify({ auth_hash, encryption }), redirect: "manual" }));
    if (response.status !== 204) return response;
    // As with the Go process dying after a commit but before its in-memory
    // charge, a crash in this cross-object gap can leave a creation uncharged.
    // No failed/conflicting creation consumes a token; no retries create twice.
    this.ctx.storage.transactionSync(() => {
      if (!bucket && sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM quotas").one().n >= 4096) sql.exec("DELETE FROM quotas WHERE ip=(SELECT ip FROM quotas ORDER BY RANDOM() LIMIT 1)");
      sql.exec("INSERT OR REPLACE INTO quotas VALUES (?, ?, ?)", ip, tokens - 1, Math.max(now, bucket?.updated || 0));
    });
    const result = plain(`/c/${id}\n`, 303);
    result.headers.set("Location", `/c/${id}`);
    return result;
  }
}

function crossOrigin(request: Request): Response | undefined {
  const site = request.headers.get("Sec-Fetch-Site") || "";
  if (site === "same-origin" || site === "none") return;
  if (site) return plain("cross-origin request detected from Sec-Fetch-Site header\n", 403);
  const origin = request.headers.get("Origin");
  if (!origin) return;
  try { if (new URL(origin).host === new URL(request.url).host) return; } catch { /* reject invalid origins */ }
  return plain("cross-origin request detected, and/or browser is out of date: Sec-Fetch-Site is missing, and Origin does not match Host\n", 403);
}
function methodNotAllowed(allow: string): Response {
  const response = plain("Method Not Allowed\n", 405);
  response.headers.set("Allow", allow);
  return response;
}
function redirect(request: Request, location: string): Response {
  const get = request.method === "GET" || request.method === "HEAD";
  const headers = new Headers({ Location: location });
  if (get) headers.set("Content-Type", "text/html; charset=utf-8");
  const escaped = location.replaceAll("&", "&amp;").replaceAll('"', "&#34;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return new Response(request.method === "GET" ? `<a href="${escaped}">Moved Permanently</a>.\n\n` : null, { status: get ? 301 : 307, headers });
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const config = settings(env);
  // Reject invalid retention before constructing an object or accepting work.
  // Constructor failures otherwise bypass this Worker's configuration response.
  retentionMS(env);
  if (url.pathname === "/config") return request.method === "GET" || request.method === "HEAD" ? json(config) : methodNotAllowed("GET, HEAD");
  // Go ServeMux cleans duplicate slashes. WHATWG URL already removes dot paths.
  if (url.pathname.includes("//")) {
    const location = url.pathname.replace(/\/{2,}/g, "/") + url.search;
    return redirect(request, location);
  }
  const get = request.method === "GET" || request.method === "HEAD";
  if (url.pathname === "/new") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const denied = crossOrigin(request);
    if (denied) return denied;
    const input = stringFields(await readBody(request, limits.createBody), ["id", "auth_hash", "encryption"], messages.create);
    if (!canonicalID(input.id)) throw new HTTPError(400, messages.id);
    if (unb64(input.auth_hash)?.length !== 32) throw new HTTPError(400, messages.hash);
    // Absent mode belongs to the original encrypted protocol. Never silently
    // reinterpret an old client's creation as a plaintext channel.
    input.encryption ||= "1";
    if (input.encryption !== (config.encryption ? "1" : "0")) throw new HTTPError(412, "Client encryption mode does not match this server. Reload or download the current clients.", "mode_changed");
    const gate = env.CREATION.get(env.CREATION.idFromName("creation"));
    return gate.fetch(new Request("https://mayfly.internal/create", { method: "POST", body: JSON.stringify({ ...input, ip: sourceIP(request, env.TRUST_PROXY === "1") }), redirect: "manual" }));
  }
  const channel = /^\/c\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (channel) {
    if (!channel[2] && !get && request.method !== "DELETE") return redirect(request, url.pathname + "/" + url.search);
    let id: string;
    try { id = decodeURIComponent(channel[1]); } catch { return plain("Bad Request\n", 400); }
    if (!canonicalID(id)) return !channel[2] && get ? channelPage(request, id, undefined, retentionMS(env), config) : json({ error: missingText(retentionMS(env)) }, 404);
    const chat = env.CHATS.get(env.CHATS.idFromName(id));
    // Construct a fresh header set: clients cannot impersonate this internal
    // source metadata, nor influence origin links using forwarded host headers.
    const headers = new Headers();
    for (const name of ["Authorization", "Accept", "Content-Type"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("X-Mayfly-Source", sourceIP(request, env.TRUST_PROXY === "1"));
    return chat.fetch(new Request(request, { headers, redirect: "manual" }));
  }
  const page = publicPage(request, url.pathname, config);
  if (page) return get ? page : methodNotAllowed("GET, HEAD");
  return plain("404 page not found\n", 404);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); } catch (error) { response = failure(error); }
    return secure(response, request.method === "HEAD");
  },
};
