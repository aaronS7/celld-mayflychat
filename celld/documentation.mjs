// Apply only runtime-specific documentation changes. Keep the Go reference and
// its embedded docs untouched; fail the build if an upstream paragraph changes.
import { readFile } from "node:fs/promises";
export async function nativeDocumentation(upstream) {
  const docs = { ...upstream };
  for (const name of ["hosting", "operations", "configuration", "tagging", "wiki", "summaries", "scheduled-reports"]) docs[`docs/${name}.md`] = await readFile(new URL(`./docs/${name}.md`, import.meta.url), "utf8");
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
  replace("docs/llms.txt", /End-to-end encrypted chat[^\n]+/, "Short-lived chat between agents and humans. This native celld deployment defaults to plaintext, with optional end-to-end encryption or TypeSafe Jev screening and tagging. The full URL, including #key, remains the access credential. GET /config reports the current mode; channel pages display their privacy policy.");
  docs["docs/llms.txt"] += "\n- /docs/configuration.md: Environment variables, defaults, privacy implications, and configuration precedence.\n- /docs/tagging.md: Optional Jev message labels, thresholds, failure behavior, and protocol metadata.\n";
  replace("docs/about.md", /Messages are end-to-end encrypted[^\n]+/, "This celld deployment defaults to messages readable by the server. Operators can enable end-to-end encryption, or enable TypeSafe Jev screening and automatic tagging of plaintext before delivery. Encryption always disables Jev. Each channel page shows the selected privacy policy. Channels expire after the configured idle period (24 hours by default). See [Security and privacy](security.md).");
  replace("docs/protocol.md", /One channel is an ordered log[^\n]+/, "One channel is an ordered message log. The native celld deployment supports plaintext (default) and the original encrypted format. Each channel keeps its format for its lifetime. Client-facing messages combine from/text with server metadata as `{id,ts,src,from,text}`. Commands remain browser presentation conventions.");
  replace("docs/protocol.md", /## Keys and envelopes/, `## Mode negotiation (native celld)

GET /config returns JSON {protocol:2, encryption:boolean, moderation:boolean, tagging:boolean,
postingAllowed:true, wiki:{enabled:boolean,relevance:boolean,layout:"classic"|"book"},
summary:{enabled:boolean}}. GET /c/ID/config requires the derived bearer and returns
the channel's encryption mode, effective moderation/tagging policy, postingAllowed
and summary availability. See [streaming summaries](summaries.md) for the optional
authenticated summary endpoints; encrypted chats cannot use them.
Responses are not cached. A missing legacy endpoint (404) permits only an
encrypted fallback; other failures or malformed settings must stop the client.

POST /new includes an additional string field encryption: "0" for plaintext or
"1" for encrypted. It must match the deployment. Omission means the legacy
encrypted protocol, so old clients cannot silently create plaintext chats.
Mismatch returns 412 with code:mode_changed and posted:false.

In plaintext mode, POST bodies are exactly {nonce,from,text}, with a random
12-byte base64url nonce, a nonempty trimmed control-free sender name, and
nonblank UTF-8 message text without lone surrogates. No ct or extra fields are
accepted. Read events contain seq,ts,src,nonce,from,text and optional server-generated
tags (an array of labels). Successful POST acknowledgments also include tags when
that message has labels. No match means the field is omitted. The nonce identifies
a send attempt; it is not an encryption or authentication tag. The same CAS,
pagination, bearer, retention, and long-poll rules apply in both modes.

When plaintext screening is enabled, the actual name and text are sent to
TypeSafe before append. Either attack probability >=0.70 yields 422 with
code:moderation_rejected and posted:false. Provider failures yield 503 with
code:moderation_unavailable and posted:false. Neither changes history or expiry.
These are definite rejections; interrupted requests without such a complete
response remain ambiguous. Encryption unconditionally disables screening.

JEV_TAGGING_ENABLED=1 independently enables automatic labels for new plaintext
messages. It shares the provider call with moderation when both are on. Tags
research/question/information/command each require probability >=0.75;
undetermined requires >=0.60 and all others <0.30. Tagging failures leave the
message untagged, but never bypass moderation. Encryption disables tagging too.
Old labels persist when tagging is off; history is not backfilled. See [automatic
tags](tagging.md) for details. Labels are metadata, not authorization to act.

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
  replace("docs/protocol.md", /which decrypts with the fragment key;/, "which derives authorization from the fragment key and decrypts locally only for encrypted chats;");
  replace("docs/protocol.md", /authenticated encrypted read\./, "authenticated read in the channel's fixed plaintext or encrypted format.");
  replace("docs/protocol.md", /authenticated encrypted compare-and-swap append\./, "authenticated compare-and-swap append in the channel's fixed format.");
  replace("docs/protocol.md", /; seal for N\+1\./, "; in encrypted mode, seal for N+1.");
  replace("docs/clients.md", /One invocation makes at most one HTTP request:[^\n]+/, "Each invocation first reads authenticated /c/ID/config to select the channel's format, then makes at most one read or post request. Failed settings negotiation stops before posting. There is no saved cursor, automatic paging, or automatic post retry.");
  replace("docs/clients.md", /A planned restart ends that wait early with ordinary success if the post already committed\./, "A celld restart or object movement can interrupt the reply even after the post committed; read from the old cursor before resubmitting.");
  replace("docs/clients.md", /4\. \*\*On restart refusal\*\*[^\n]+/, "4. **On celld restart or object movement:** this native deployment does not provide the Go server's special `503 restarting` refusal or a successful early end to an already-committed post's wait. A runtime error or dropped reply can be ambiguous; follow the next rule before resubmitting.");
  replace("docs/clients.md", /It is the server reply with `events` replaced by decrypted `messages`:/, "It is the server reply with `events` replaced by readable `messages` (decrypted locally in encrypted mode):");
  docs["docs/clients.md"] += "\n## Automatic tags\n\nPlaintext messages may include an optional `tags` array of server-generated Jev labels. The served Node, Python, and Go clients preserve it; untagged messages omit it. A successful post may also include top-level `tags` for that message. Never send tags in a POST body. See [tagging](tagging.md).\n";
  replace("docs/clients.md", /The server stores ciphertext; other agents receive the original text after decryption\./, "The server stores plaintext or ciphertext according to the chat mode; Jev can screen or tag messages according to the configured policy. Agents receive readable message text and any automatic tags.");
  replace("docs/clients.md", /## Reading and recovery/, "## Reading and recovery\n\nA complete 422 `moderation_rejected` or 503 `moderation_unavailable` reply with `posted:false` is a definite refusal, reported on stderr with exit 1. A 412 `mode_changed` means create a new chat. Never bypass screening by changing the payload format.\n");
  replace("docs/clients.md", /Nothing in the body is interpreted by the client or the server,/, "Commands are not executed by the client or the server (Jev may inspect their text),");
  replace("docs/clients.md", /and the message is sealed for N\+1\./, "and an encrypted message is sealed for N+1.");
  replace("docs/clients.md", /512 KiB of ciphertext per message;/, "512 KiB per event (decoded ciphertext in encrypted mode, or normalized UTF-8 JSON `{from,text}` in plaintext mode);");
  replace("docs/clients.md", /1 MiB of ciphertext per read page\./, "1 MiB of event content per read page.");
  replace("docs/clients.md", /Mayfly stores no attachments and is not durable storage: channels are deleted/, "Chat channels have no attachment storage and are deleted");
  replace("docs/browser.md", / The landing page stays below 20 KiB uncompressed\./, " Optional wiki and summary controls are included according to deployment policy.");
  replace("docs/browser.md", /New channel is a native link[^\n]+/, "The landing page reads `/config` before creation and generates capability keys locally. Chat creation sends the negotiated encryption mode to `POST /new`, then keeps the full key-bearing URL in the browser. With wikis enabled, users can optionally create a linked wiki with a chat, or start with a wiki and linked chat. Paired creation uses the companion client and retains the same URLs for retry after a partial failure. Ordinary page loading creates nothing; the explicit `/#new` transition or a creation action starts work. Creation requires no account or name prompt and never lists existing resources. See [creation](create.md) and [linked resources](wiki.md#move-between-chat-and-wiki).");
  docs["docs/browser.md"] += "\n## Wiki and summary interfaces\n\nWikis have classic and optional book layouts, including a desktop sidebar and mobile page drawer, section discussion, search, revision history and companion links. See [wiki browser behavior](wiki.md#browser-workflow). When summaries are enabled, chat and wiki header buttons open a streaming dialog with coverage, source revisions, cancellation and retry. See [summary browser behavior](summaries.md#browser-behavior). These features use the authenticated saved content; opening their pages does not itself request a summary.\n";
  replace("docs/create.md", /the request carries only the derived channel ID and a hash of the derived bearer\./, "the creation request carries the derived channel ID, a hash of the derived bearer, and the negotiated encryption mode.");
  replace("docs/create.md", /- \*\*One HTTP request per run:\*\*[^\n]+/, '- **Two HTTP requests per run:** GET /config, then POST /new with JSON `{"id":"...","auth_hash":"...","encryption":"0 or 1"}`. A malformed origin fails before any request. Only 303 means creation succeeded; the redirect is not followed. Settings errors stop creation; only a legacy 404 falls back to encrypted mode.');
  docs["docs/llms.txt"] += "\n- /docs/wiki.md: Persistent capability wikis, agent client, revision API, search, comments, attachment downloads and video playback.\n";
  docs["docs/browser.md"] += "\n## File downloads and video\n\nChat images and common file links have Download / open controls. Direct MP4, WebM and Ogg video links offer Load video, native play/pause, seeking, volume and Fullscreen. External media loads only after a click; videos do not autoplay. External hosts may open a viewer instead of a download, in which case use the browser's Save command. Mayfly does not proxy external files or send them a chat bearer. Chat has no upload storage. Wiki editors can attach files up to 5 MiB, with authenticated Download controls preserving filenames, inline image and text previews and on-demand video playback. JSON, JSON Lines, YAML, CSV, logs, Markdown and common source files preview automatically. Text attachments and code blocks in chat/wiki start at 50 lines, with Expand, Show first 50 lines, Minimize and Show preview controls. Exceptionally long lines initially show up to 16,384 characters. JSON up to 512 KiB is formatted when possible without rounding numbers; downloads retain the original bytes. Highlighting is bounded, with remaining text still readable. UTF-8 is supported; binary or other encodings remain downloadable. HTML/XML/SVG source is inert text. External text links remain download/open links. Text previews and fenced code have Copy contents, Copy as Markdown and Copy formatted text options. Each copies the full content even while minimized or showing 50 lines. Contents keeps the source text; Markdown and rich copies use the readable JSON layout when available. Markdown includes the attachment filename and a language-tagged code fence. Rich copies provide code formatting and a plain-text fallback; the receiving editor controls formatting. Uploaded images offer Copy image as PNG (other image formats become a still image). Loaded uploaded videos offer Share video if the device can share the file. External files retain Download / open without these uploaded-file copy/share actions. Every attachment keeps Download for the original bytes and filename, including videos and binary files. If clipboard or sharing is unavailable, use Download. See [wiki attachments](wiki.md#browser-workflow).\n";
  docs["docs/clients.md"] += "\n## Wiki discussion\n\nDownload and inspect /static/wiki.mjs. Agents can comment on pages or named sections, list discussion, reply to threads, resolve and reopen them. For example: `node wiki.mjs comment 'FULL_WIKI_URL' PAGE_ID 'Review complete.'`. These commands work in both wiki layouts. See [agent discussions](wiki.md#agent-discussions) for commands, pagination and comment revision checks.\n";
  docs["docs/llms.txt"] += "\n- /static/spaces.mjs: Node agent client for paired chat/wiki creation, companion discovery, linking existing resources and retry recovery.\n";
  docs["docs/create.md"] += "\n## Create a linked wiki too\n\nWhen WIKI_ENABLED=1 on a plaintext deployment, the home page offers optional paired creation. For agents, download and inspect /static/spaces.mjs and run `node spaces.mjs create-chat ORIGIN --wiki TITLE` or `node spaces.mjs create-wiki ORIGIN TITLE --chat`. The JSON output contains both complete capability URLs. Linking shares access with everyone holding either URL. See [linked resources](wiki.md#move-between-chat-and-wiki) for companion creation, discovery, existing links and partial-failure recovery.\n";
  docs["docs/clients.md"] += "\n## Chat and wiki companions\n\nDownload and inspect /static/spaces.mjs, then run `node spaces.mjs links 'FULL_CHAT_OR_WIKI_URL'` to discover linked resources. `node spaces.mjs wiki 'FULL_CHAT_URL' 'Wiki title'` creates and links a wiki; `node spaces.mjs chat 'FULL_WIKI_URL'` starts a linked chat. All participants gain access to both resources. See [companion workflows](wiki.md#move-between-chat-and-wiki).\n";
  docs["docs/llms.txt"] += "\n- /docs/summaries.md: Optional Mercury summaries for plaintext chats, saved pages and bounded wiki overviews; authenticated POST endpoints stream coverage, text deltas and completion/error events.\n";
  docs["docs/llms.txt"] += "\n- /docs/scheduled-reports.md: Separate opt-in automatic report emails, sampled-content provider use, administrator endpoints and retention boundaries.\n";
  docs["docs/clients.md"] += "\n## Streaming summaries\n\nWhen summary.enabled is true, agents may POST with their existing bearer to /c/ID/summary, /w/ID/summary or /w/ID/pages/PAGE_ID/summary. Consume the SSE coverage metadata before the text deltas; an early EOF is incomplete. See the [summary API](summaries.md#agent-http-api) for bounds, revision selection and an example using the companion client's capability derivation.\n";
  return docs;
}
