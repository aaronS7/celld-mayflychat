import { instructions, staticFiles, templates } from "./assets.generated";
import { b64, HTTPError, plain } from "./protocol";
import { privacyText, type Settings } from "./settings";

export const csp = "default-src 'none'; connect-src 'self'; img-src http: https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function quality(raw: string): number {
  // strconv.ParseFloat also accepts hexadecimal floats and numeric separators.
  const decimal = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/i;
  if (decimal.test(raw)) return Number(raw.replaceAll("_", ""));
  const hex = /^([+-]?)0x_?([a-f\d](?:_?[a-f\d])*(?:\.(?:[a-f\d](?:_?[a-f\d])*)?)?|\.[a-f\d](?:_?[a-f\d])*)p([+-]?\d(?:_?\d)*)$/i.exec(raw);
  if (!hex) return NaN;
  const [whole, fraction = ""] = hex[2].replaceAll("_", "").split(".");
  return (hex[1] === "-" ? -1 : 1) * (parseInt(whole || "0", 16) + (fraction ? parseInt(fraction, 16) / 16 ** fraction.length : 0)) * 2 ** Number(hex[3].replaceAll("_", ""));
}
export function secure(response: Response, head = false): Response {
  const headers = new Headers(response.headers);
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", csp);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Content-Type-Options", "nosniff");
  if (head && response.body) void response.body.cancel().catch(() => {});
  return new Response(head ? null : response.body, { status: response.status, headers });
}
export function acceptsHTML(value: string): boolean {
  if (new TextEncoder().encode(value).length + 1 > 8192) return false;
  const parts = value.split(",");
  if (parts.length > 64) return false;
  let html = 0, plainQ = 0, specificity = -1;
  for (const part of parts) {
    // MIME token/quoted-string grammar, including duplicate-parameter rejection.
    const match = /^\s*([^;\s]+)\s*([\s\S]*)$/.exec(part);
    if (!match || !/^[\w!#$%&'*+.^`|~\/-]+$/.test(match[1])) continue;
    const params = new Map<string, string>();
    let rest = match[2], valid = true;
    while (rest) {
      if (/^;\s*$/.test(rest)) break;
      const m = /^;\s*([\w!#$%&'*+.^`|~-]+)\s*=\s*("(?:[^"\\\r\n]|\\[^\r\n])*"|[\w!#$%&'*+.^`|~-]+)\s*/.exec(rest);
      if (!m) { valid = false; break; }
      const key = m[1].toLowerCase();
      const val = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(.)/g, "$1") : m[2];
      if (params.has(key) && params.get(key) !== val) { valid = false; break; }
      params.set(key, val);
      rest = rest.slice(m[0].length);
    }
    if (!valid) continue;
    const raw = params.get("q");
    const q = raw === undefined ? 1 : quality(raw);
    if (!(q >= 0 && q <= 1)) continue;
    const type = match[1].toLowerCase();
    if (type === "text/html") { html = Math.max(html, q); continue; }
    const spec = type === "text/plain" ? 2 : type === "text/*" ? 1 : type === "*/*" ? 0 : -1;
    if (spec > specificity) { plainQ = q; specificity = spec; }
    else if (spec >= 0 && spec === specificity) plainQ = Math.max(plainQ, q);
  }
  return html > 0 && html >= plainQ;
}
export function retentionMS(env: { RETENTION_SECONDS?: string }): number {
  const raw = env.RETENTION_SECONDS === undefined ? "86400" : env.RETENTION_SECONDS;
  const invalid = () => new HTTPError(503, "RETENTION_SECONDS must be decimal seconds from 0 to 315360000 with at most 3 fractional digits", "configuration_error");
  if (typeof raw !== "string" || raw.trim() !== raw || !/^\d+(?:\.\d{1,3})?$/.test(raw)) throw invalid();
  const [whole, fraction = ""] = raw.split(".");
  // Parse fractional milliseconds separately: flooring seconds * 1000 can
  // shorten values such as 1.001, and must never turn a positive value into 0.
  const milliseconds = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 315360000000) throw invalid();
  return milliseconds;
}
export function retentionText(ms: number): string {
  if (!ms) return "Channels are not automatically deleted.";
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = ms % 60000 / 1000;
  const duration = h ? `${h}h${m || s ? `${m}m` : ""}${s ? `${s}s` : ""}` : m ? `${m}m${s ? `${s}s` : ""}` : ms < 1000 ? `${ms}ms` : `${s}s`;
  return `Channels are deleted after ${duration} of inactivity.`;
}
export const missingText = (ms: number) => "No such channel. " + retentionText(ms);
export const timestamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const escapeHTML = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]!);
const scriptJSON = (s: unknown) => JSON.stringify(s).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
export function render(name: keyof typeof templates, values: Record<string, string | number> = {}, status = 200, config?: Settings): Response {
  const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
  const fields: Record<string, string> = Object.fromEntries(Object.entries(values).map(([key, val]) => [key, escapeHTML(String(val))]));
  Object.assign(fields, { CSPNonce: nonce, "Channel.ID": scriptJSON(values.ID || ""), ExpiresAtJSON: scriptJSON(values.ExpiresAt || ""), ExpiresHidden: values.ExpiresAt ? "" : " hidden" });
  if (config) Object.assign(fields, { SettingsJSON: scriptJSON(config), PrivacyText: escapeHTML(privacyText(config)) });
  const body = templates[name].map(part => typeof part === "string" ? part : fields[part.field] ?? "").join("");
  const media = name === 'view' || name === 'wiki' ? '; media-src http: https: blob:' : '';
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `${csp}${media}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'` } });
}
export function channelPage(request: Request, id: string, activity: number | undefined, retention: number, config: Settings, wikiEnabled = false, summaryEnabled = false): Response {
  let response: Response;
  if (acceptsHTML(request.headers.get("Accept") || "")) {
    response = activity === undefined ? render("gone", { RetentionText: retentionText(retention) }, 404)
      : render("view", { ID: id, RetentionMS: retention, ExpiresAt: retention ? timestamp(activity + retention) : "", WikiHidden: wikiEnabled ? '' : ' hidden', SummaryEnabled: summaryEnabled ? '1' : '0' }, 200, config);
  } else if (activity === undefined) response = plain(missingText(retention) + "\n", 404);
  else {
    const nato = "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Xray Yankee Zulu".split(" ");
    const random = crypto.getRandomValues(new Uint32Array(2));
    const name = nato[random[0] % nato.length] + String(random[1] % 100).padStart(2, "0");
    const args = [new URL(request.url).origin, id, name, retentionText(retention)];
    response = plain(privacyText(config) + "\n\n" + instructions.replace(/%\[(\d)\]s/g, (_, n) => args[Number(n) - 1]) + (wikiEnabled ? `\nLinked wikis: download and inspect ${args[0]}/static/spaces.mjs, then run\nnode spaces.mjs links 'FULL_CHAT_URL'\nnode spaces.mjs wiki 'FULL_CHAT_URL' 'Wiki title'\nLinking shares access with everyone holding either complete URL.\n` : ''));
  }
  response.headers.set("Vary", "Accept");
  return response;
}
export function publicPage(request: Request, path: string, config: Settings, wikiEnabled = false): Response | undefined {
  if (path === "/") return render("index", { WikiHidden: wikiEnabled ? '' : ' hidden' }, 200, config);
  if (path === "/emoji.txt") {
    const response = plain(staticFiles["static/emoji.txt"]);
    response.headers.set("Cache-Control", "public, max-age=86400");
    return response;
  }
  if (path.startsWith("/static/") && Object.hasOwn(staticFiles, path.slice(1))) return plain(staticFiles[path.slice(1)]);
  if (path === "/llms.txt" || /^\/docs\/[^/]+$/.test(path)) {
    const file = path === "/llms.txt" ? "docs/llms.txt" : path.slice(1);
    const source = staticFiles[file];
    const markdown = file.endsWith(".md");
    const response = source === undefined ? plain("no such page; the index is /llms.txt\n", 404)
      : markdown && acceptsHTML(request.headers.get("Accept") || "") ? render("doc", { Title: file.slice(5, -3), Source: source }) : plain(source);
    if (markdown) response.headers.set("Vary", "Accept");
    if (source !== undefined) response.headers.set("Cache-Control", "public, max-age=3600");
    return response;
  }
}
