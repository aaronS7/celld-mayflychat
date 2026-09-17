// Apply only runtime-specific documentation changes. Keep the Go reference and
// its embedded docs untouched; fail the build if an upstream paragraph changes.
import { readFile } from "node:fs/promises";
export async function nativeDocumentation(upstream) {
  const docs = { ...upstream };
  for (const name of ["hosting", "operations", "configuration"]) docs[`docs/${name}.md`] = await readFile(new URL(`./docs/${name}.md`, import.meta.url), "utf8");
  function replace(file, pattern, text) {
    if (!pattern.test(docs[file])) throw new Error(`Upstream documentation changed: ${file}`);
    docs[file] = docs[file].replace(pattern, text);
  }
  replace("docs/protocol.md", /By default, `src` is the connection peer;[^\n]+/, "On the native celld deployment, `src` is the final forwarded entry if it is a valid IP and the operator enables trusted-proxy mode. Otherwise it is an empty string: the Fetch API exposes no authenticated socket peer. See [Operations](operations.md).");
  replace("docs/protocol.md", /During shutdown, held reads[^\n]+/, "On the native celld deployment, process shutdown, object movement, and overload are handled by celld. A pending request may fail at the transport layer or receive a runtime error; the Go server's special `503 restarting` JSON and immediate successful completion of an already-committed `post --wait` are not reproduced. The server never labels an uncertain append `posted:false`. Treat uncertain post outcomes as described below.");
  replace("docs/security-model.md", /The database holds channel IDs[^\n]+/, "Each chat's Durable Object stores a bearer hash, last-activity timestamp, head, ciphertext byte count, and per event: sequence, timestamp, source IP (when available), nonce, and ciphertext. The public channel ID determines the object address. Plaintext is padded to a multiple of 256 bytes before sealing, so sizes leak in buckets. Counts, timing, padded sizes, available IPs, and traffic patterns remain visible to the operator.");
  replace("docs/security-model.md", /\*\*Posting IPs are shown[^\n]+/, "**Available posting IPs are shown to every channel reader.** Native celld uses the final `X-Forwarded-For` entry if it is a valid IP, `TRUST_PROXY=1`, and network isolation makes that header trustworthy. Otherwise `src` is empty; no direct-peer fallback is available to the Worker. These values never come from inner message fields. IPs are diagnostic metadata, not participant identity.");
  replace("docs/security-model.md", /Creation is rate-limited[^\n]+/, "Creation is rate-limited by IP in a separate Durable Object with at most 4,096 persisted buckets. No creator identity is stored with a chat. Application errors log only a fixed generic string, without bodies, keys, bearers, URLs, or request-derived error text. celld and ingress logs follow their own policy. See [Operations](operations.md) for quota and deletion boundaries.");
  replace("docs/security.md", /\*\*Visible metadata, including IP addresses\.\*\*[^\n]+/, "**Visible metadata, including available IP addresses.** Mayfly stores ciphertext, timestamps, padded sizes, and source IPs when a trusted proxy supplies them. Every channel participant can see this metadata. Without trusted-proxy configuration, source IPs are empty on the native celld deployment; the Worker cannot attest to the direct peer address.");
  for (const name of ["security", "security-model"]) docs[`docs/${name}.md`] = await readFile(new URL(`./docs/${name}.md`, import.meta.url), "utf8");
  replace("docs/llms.txt", /End-to-end encrypted chat[^\n]+/, "Short-lived chat between agents and humans. This native celld deployment defaults to plaintext, with optional end-to-end encryption or TypeSafe Jev screening. The full URL, including #key, remains the access credential. GET /config reports the current mode; channel pages display their privacy policy.");
  docs["docs/llms.txt"] += "\n- /docs/configuration.md: Environment variables, defaults, privacy implications, and configuration precedence.\n";
  replace("docs/about.md", /Messages are end-to-end encrypted[^\n]+/, "This celld deployment defaults to messages readable by the server. Operators can enable end-to-end encryption, or enable TypeSafe Jev screening of plaintext before delivery. Encryption always disables Jev. Each channel page shows the selected privacy policy. Channels expire after the configured idle period (24 hours by default). See [Security and privacy](security.md).");
  replace("docs/protocol.md", /One channel is an ordered log[^\n]+/, "One channel is an ordered message log. The native celld deployment supports plaintext (default) and the original encrypted format. Each channel keeps its format for its lifetime. Client-facing messages combine from/text with server metadata as `{id,ts,src,from,text}`. Commands remain browser presentation conventions.");
  replace("docs/protocol.md", /## Keys and envelopes/, `## Mode negotiation (native celld)

GET /config returns JSON {protocol:2, encryption:boolean, moderation:boolean,
postingAllowed:true}. GET /c/ID/config requires the derived bearer and returns
the channel's encryption mode, effective moderation policy, and postingAllowed.
Responses are not cached. A missing legacy endpoint (404) permits only an
encrypted fallback; other failures or malformed settings must stop the client.

POST /new includes an additional string field encryption: "0" for plaintext or
"1" for encrypted. It must match the deployment. Omission means the legacy
encrypted protocol, so old clients cannot silently create plaintext chats.
Mismatch returns 412 with code:mode_changed and posted:false.

In plaintext mode, POST bodies are exactly {nonce,from,text}, with a random
12-byte base64url nonce, a nonempty trimmed control-free sender name, and
nonblank UTF-8 message text without lone surrogates. No ct or extra fields are
accepted. Read events contain seq,ts,src,nonce,from,text. The nonce identifies
a send attempt; it is not an encryption or authentication tag. The same CAS,
pagination, bearer, retention, and long-poll rules apply in both modes.

When plaintext screening is enabled, the actual name and text are sent to
TypeSafe before append. Either attack probability >=0.70 yields 422 with
code:moderation_rejected and posted:false. Provider failures yield 503 with
code:moderation_unavailable and posted:false. Neither changes history or expiry.
These are definite rejections; interrupted requests without such a complete
response remain ambiguous. Encryption unconditionally disables screening.

Changing ENCRYPTION_ENABLED never converts old messages. A previous-mode chat
remains readable/deletable but rejects posts with 412 code:mode_changed and
posted:false. Create a new chat for the selected mode.

Plaintext limits count UTF-8 bytes of normalized JSON {from,text}: 512 KiB/event,
1 MiB/channel, 10,000 events, 500 events/page, and a 700,074-byte request body.
Encryption-specific details below apply only when encryption is enabled.

## Keys and envelopes`);
  replace("docs/protocol.md", /No algorithm or version negotiation\./, "The encrypted construction is unchanged; mode negotiation is described above.");
  replace("docs/protocol.md", /JSON `\{"id":"\.\.\.","auth_hash":"\.\.\."\}` only\./, 'JSON `{"id":"...","auth_hash":"...","encryption":"0 or 1"}`.');
  replace("docs/protocol.md", /An event has `seq`, RFC3339 `ts`, observed posting-IP `src`, `nonce`, and `ct`\./, "An encrypted event has `seq`, RFC3339 `ts`, observed posting-IP `src`, `nonce`, and `ct`; a plaintext event has `from` and `text` in place of `ct`.");
  replace("docs/protocol.md", /The server validates envelope structure and size, not decrypted content\./, "In encrypted mode the server validates envelope structure and size, not decrypted content. In plaintext mode it validates the actual message and applies the configured Jev policy before storing it.");
  replace("docs/clients.md", /One invocation makes at most one HTTP request:[^\n]+/, "Each invocation first reads authenticated /c/ID/config to select the channel's format, then makes at most one read or post request. Failed settings negotiation stops before posting. There is no saved cursor, automatic paging, or automatic post retry.");
  replace("docs/clients.md", /It is the server reply with `events` replaced by decrypted `messages`:/, "It is the server reply with `events` replaced by readable `messages` (decrypted locally in encrypted mode):");
  replace("docs/clients.md", /The server stores ciphertext; other agents receive the original text after decryption\./, "The server stores plaintext or ciphertext according to the chat mode; Jev, if enabled, screens every message before acceptance. Agents receive readable message text.");
  replace("docs/clients.md", /## Reading and recovery/, "## Reading and recovery\n\nA complete 422 `moderation_rejected` or 503 `moderation_unavailable` reply with `posted:false` is a definite refusal, reported on stderr with exit 1. A 412 `mode_changed` means create a new chat. Never bypass screening by changing the payload format.\n");
  replace("docs/clients.md", /Nothing in the body is interpreted by the client or the server,/, "Commands are not executed by the client or the server (Jev may inspect their text),");
  replace("docs/create.md", /the request carries only the derived channel ID and a hash of the derived bearer\./, "the creation request carries the derived channel ID, a hash of the derived bearer, and the negotiated encryption mode.");
  replace("docs/create.md", /- \*\*One HTTP request per run:\*\*[^\n]+/, '- **Two HTTP requests per run:** GET /config, then POST /new with JSON `{"id":"...","auth_hash":"...","encryption":"0 or 1"}`. A malformed origin fails before any request. Only 303 means creation succeeded; the redirect is not followed. Settings errors stop creation; only a legacy 404 falls back to encrypted mode.');
  return docs;
}
