# Streaming AI summaries

The native celld application can summarize a plaintext chat, a saved wiki page,
or a bounded overview of a wiki using Mercury 2.5. Summaries are optional and
off by default. Jev screening, tagging and search ranking remain independent.

## Configure the provider

Set these **Worker bindings** in `.dev.vars` for local development or in private
deployment configuration for a fleet:

```dotenv
AI_SUMMARY_ENABLED=1
MERCURY_BASE_URL=https://api.inceptionlabs.ai/v1
MERCURY_API_KEY=your-provider-key
MERCURY_MODEL=mercury-2.5
```

Supply your provider's base URL, including its API version prefix. Mayfly
appends `/chat/completions`; do not include that suffix in the base URL.
The URL must use HTTPS, except for HTTP loopback fixtures during development.
Credentials, query strings and fragments are not accepted in the URL. Redirects
are refused. Keep the key in private configuration, never in a committed file.

`AI_SUMMARY_ENABLED` accepts exactly `0` or `1` and defaults to `0`.
`MERCURY_MODEL` defaults to `mercury-2.5`. The base URL and key have no defaults.
Deploy binding changes; exporting variables on an already running celld daemon
does not change a deployed Worker. See [configuration](configuration.md).

`GET /config` reports `summary:{enabled:boolean}`. Authenticated chat config
and wiki metadata also report availability. This reports the selected policy,
not provider health: a missing or invalid key can still make generation fail.
End-to-end encryption disables summaries, including for previously encrypted
chats. No client-side decrypted chat text is uploaded for summarization.

The provider receives a Chat Completions request with `stream:true`,
`diffusing:false`, `reasoning_effort:"instant"` and `max_completion_tokens:1800`.
This uses Mercury's normal incremental stream, documented in the
[provider streaming guide](https://docs.inceptionlabs.ai/capabilities/streaming).
Only generated content is forwarded; reasoning fields are not displayed.

## Deploy with a swamp vault

For the existing consolidated deployment VM, this checkout also includes an
interactive swamp vault setup and redeployment workflow:

```sh
npm run mercury:setup
npm run mercury:preview
npm run mercury:deploy
```

Setup prompts for the base URL, model and hidden API-key entry, then saves one
encrypted vault entry. Preview builds without publishing. Deploy reads the
current vault value, preserves existing production bindings, sets
`AI_SUMMARY_ENABLED=1` and verifies the rollout. See the
[swamp deployment guide](https://github.com/aaronS7/celld-mayflychat/blob/main/celld/swamp/README.md) for prerequisites, key rotation,
storage boundaries and direct workflow commands.

## Browser behavior

The chat header offers **AI summary**. The wiki header offers **Summarize page**
and **Summarize wiki** in both layouts, keeping search in its existing position.
Page summaries use saved text; the page button is disabled while editing.
Opening a historical revision summarizes that revision.

A dialog displays text as it arrives, with a short reveal animation and a live
status indicator. Reduced-motion preferences disable these animations. **Stop**,
**Close**, Escape and leaving the page cancel generation. **Regenerate** starts
a new request; **Copy** copies the generated Markdown after generation or a stop.
Finished output is rendered as sanitized Markdown without model-supplied links
or images. Source links are built from the saved source metadata instead.

The coverage line reports the number of included messages or pages and whether
excerpts were used. Expand **Sources** for chat message locations or wiki links
to the exact saved revisions. Incomplete or failed streams stay marked as
incomplete; partial text remains available. Summaries are never automatically
posted to a chat, saved as a wiki revision or cached by the application.

## Coverage and limits

| Scope | Selection |
| --- | --- |
| Chat | Up to the latest 200 events, favoring the newest text when the input budget is reached, then supplied in chronological order. Names are bounded and timestamps included. |
| Wiki page | The saved current revision, or the requested historical revision. Large pages are excerpted to fit the input budget. |
| Whole wiki | Up to 60 current, non-deleted pages. Top-level pages come first; each group is ordered by path. Each page contributes at most its first 4,000 UTF-8 bytes, further limited by the shared input budget. |

Whole-wiki summaries are a **bounded overview**, not a guarantee of coverage of
every topic. Selection is deterministic; it does not crawl every page or use
Jev to pick pages. Empty text is skipped. Comments, attachment contents, page history
and linked companion resources are not included. The response identifies the
snapshot version and actual included sources, so callers can assess coverage.

Source records share a 160,000-byte input budget, accounting for JSON escaping
and record overhead. Output is capped at 64,000 UTF-8 bytes and the provider's
1,800-token completion limit. Each request has a 45-second total deadline.
At most two summaries run concurrently per chat or wiki; at most ten starts
are allowed per minute per active object. These limits are in memory and reset
when an object restarts; they are not a deployment-wide spending quota.

Summary reads do not refresh chat expiry or change wiki revisions. Generation
uses a saved snapshot even if someone edits later. A removed or expired resource
stops subsequent streamed content when availability is checked. Provider errors
are generic and never relay provider response bodies or credentials.

## Agent HTTP API

Use the same derived bearer as ordinary chat or wiki reads. Capability keys stay
in URL fragments in browser links; never put a key in a query parameter.

| Request | Meaning |
| --- | --- |
| `POST /c/ID/summary` | Summarize the latest plaintext chat events. |
| `POST /w/ID/summary` | Generate the bounded wiki overview. |
| `POST /w/ID/pages/PAGE_ID/summary` | Summarize the saved page. |
| `POST /w/ID/pages/PAGE_ID/summary?revision=N` | Summarize a particular saved revision. |

Send `Authorization: Bearer DERIVED_BEARER`. The body must be empty or `{}`;
custom prompts and other fields are rejected. Only a page summary accepts the
`revision` query parameter. A successful response uses
`Content-Type: text/event-stream` and `Cache-Control: no-store, no-transform`.

Events have an `event:` line and a JSON `data:` line, separated by a blank line:

- `meta`: `scope`, `title`, `version`, `total`, `included`, `partial`, `model`
  and `sources`. Each source has a 1-based `number`, title, URL, excerpt flag
  and either wiki `revision` or chat `seq`. No source text is repeated here.
- `delta`: `{text:"..."}` to append to the draft.
- `done`: `{truncated:false}` after a complete provider stream. `true` means the
  provider reached its output token limit and the summary is incomplete.
- `error`: `{error:"...",code:"summary_interrupted"}` if generation fails after
  streaming has begun. Keep earlier text marked incomplete. An EOF without
  `done` also means an incomplete result.

Before streaming starts, ordinary JSON HTTP errors apply: 401 for failed
authentication, 404 for absent resources or disabled summaries, 412 for an old
encrypted chat in a plaintext deployment, 422 for no saved text, 429 for the
per-object limits, and 503/504 for provider configuration, availability or
timeout failures. Aborting the client request cancels upstream work. Retrying
starts a new model call and can incur additional provider usage.

For example, after downloading and inspecting `/static/spaces.mjs` from your
application server, a Node 22+ agent can use its existing capability derivation.
Save this as `summary.mjs` beside the downloaded client, set `MAYFLY_URL` to a
complete chat or wiki URL, and run `node summary.mjs` to inspect the raw SSE:

```js
import { MayflySpaces } from './spaces.mjs';
const cap = await MayflySpaces.capability(process.env.MAYFLY_URL);
const response = await fetch(cap.origin + cap.path + '/summary', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + cap.auth },
});
if (!response.ok) throw new Error('Summary HTTP ' + response.status);
for await (const chunk of response.body) process.stdout.write(chunk);
```

This example prints transport data; its process exit status is not proof of a
complete summary. An automated consumer must parse complete SSE frames across
chunk boundaries, retain `meta` coverage, append deltas, and require `done` with
`truncated:false`. Treat `error`, output truncation and EOF without `done` as
incomplete. Chat sources identify message `seq` values: keep the original
capability fragment rather than replacing it with a message anchor.

## Data sent to the provider

An explicit button press or authenticated API request sends the selected saved
text and titles, source numbers, revisions or sequence numbers to the configured
provider. Chat source titles also include a bounded sender name and timestamp.
Loading a page does not call the model. Mayfly does not add access keys, bearers,
source IPs, companion link records or API credentials to the prompt. Any secrets
or links people wrote inside the selected text are still part of that text.
The provider API key is used only in the server's authorization header.

This is generated guidance, not a new authoritative source. Check consequential
details against the linked revisions. Provider retention and billing follow
your provider account's policy; disabling summaries does not erase provider
copies or deployment history. See [security and privacy](security.md).

## Verification

`npm run test:summaries` covers authentication, resource isolation, saved
revisions, bounded input, feature flags, encryption, streaming, provider errors,
cancellation and limits. `CHROME_BIN=/path/to/chrome npm run test:summaries:e2e`
drives the real application through Chrome on desktop and mobile, including
animation, reduced motion, sanitized output, source links, Stop and retry.
These tests use a local provider fixture and make no real Mercury calls;
they verify transport and behavior, not the quality of a live model's summary.
