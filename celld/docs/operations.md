# Operations

This server runs natively on **celld 0.5.0**. A stateless Worker serves assets and
routes each public channel ID to one `Chat` Durable Object. That object stores
the bearer hash, fixed message mode, ordered message log, byte count, and last activity in
`ctx.storage.sql`. It performs compare-and-swap appends synchronously and wakes
long polls after committing. Waiting holds no SQL transaction. A separate
`CreationGate` object coordinates anonymous creation quotas.

The runtime needs no Go executable, Docker daemon, or external SQLite driver.
The original Go sources remain a protocol reference. The native namespace is
`mayfly-native`; no existing chats are migrated.

## Storage and restarts

`ENCRYPTION_ENABLED=0` (default) stores plaintext; `1` stores client-encrypted
envelopes and always disables Jev. In plaintext mode, `JEV_ENABLED=1` requires
`TYPESAFE_API_KEY` and screens messages before append. API failures fail closed.
Use `.dev.vars` only for local development, or private Worker deployment
bindings for fleet operation. Arbitrary daemon environment variables do not
automatically become Worker bindings. See the
[environment-variable reference](configuration.md) for accepted values,
precedence, and privacy implications.

Mode changes leave old histories readable/deletable and refuse new posts to
chats in the previous mode. Create a new channel to use the selected mode.

Local development uses `.celld/dev`. Stop and restart without `--clean` to retain
chats. In production, celld replicates the Durable Object storage using its
configured fleet bucket and durability policy. Its guarantees require a
supported object store with working conditional writes and a process supervisor.
See the [versioned celld guarantees](https://github.com/denoland/celld/blob/v0.5.0/docs/guarantees.md).

Ordinary writes commit before success responses. Process shutdown, object
movement, or overload can interrupt a held request; this port does not reproduce
the Go binary's custom shutdown `503 restarting` response or 250 ms drain.
An interrupted post may already have committed: read from the old cursor before
resubmitting. Existing clients already handle uncertain transport outcomes.

Deletion and expiry remove the live channel metadata and events and wake readers
with 404. They do not erase participants' copies, SQLite free pages, or celld's
replicated history and backups. Object addresses and empty storage can remain.

## Retention and limits

`RETENTION_SECONDS` is a Worker variable in `wrangler.jsonc`, default `86400`.
`0` disables automatic deletion. It accepts non-negative decimal seconds with
at most three fractional digits, up to `315360000` seconds (ten years).
Blank, malformed, and sub-millisecond values fail with a configuration error;
they do not disable expiry. Creation and accepted posts set activity; reads,
failed posts, and waits do not refresh it. An alarm expires an inactive chat.
Requests also check expiry, so a delayed alarm cannot expose an expired channel.
Unlike Go's once-per-minute reaper, this port enforces the stored deadline.

Changing retention affects a chat at its next request or already scheduled alarm.
Shortening retention does not proactively reschedule every dormant object's
existing alarm. Requests enforce the new deadline immediately.

The limits count decoded ciphertext in encrypted mode and normalized UTF-8 JSON
`{from,text}` in plaintext mode: 512 KiB per event, 1 MiB and
10,000 events per channel, and 500 events per read page. No history is truncated
to admit a new event. Conflicts return the unread page and `posted:false`.

Creation allows a burst of 100 channels per available source IP and refills at
100 per 24 hours, with at most 4,096 buckets. Failed or duplicate creations do
not consume a token, and deletion does not refund one. Unlike the Go process's
in-memory quotas, these buckets survive restarts. Creation and quota charging
span two objects: a process failure after chat creation but before charging can
leave that creation uncharged. This is an accident guardrail, not a strict
distributed billing or abuse-prevention system.

## Long polling

GET and POST support `wait` up to 86,400 seconds. For that full range, run every
celld node with `CELLD_FETCH_TIMEOUT_S=86500` and
`CELLD_HANDLER_BUDGET_S=86500`, and configure the ingress read timeout to match.
`npm run dev` supplies both settings. Deployment alone does not change a running
node's environment. Celld defaults are 120 seconds for outbound fetch and
300 seconds for handlers.

Held polls consume concurrent request slots and keep objects active. Celld's
default per-cell limit is 64; `CELLD_MAX_CELL_REQUESTS` configures it. An overloaded
cell can refuse another request with 503. One chat remains serialized for writes,
while different chats have separate objects. Local correctness tests do not
establish fleet throughput or maximum participant counts.

## HTTPS and source IPs

The Worker trusts the origin in `request.url` for links. It never independently
uses forwarded host/protocol headers. Behind an isolated trusted proxy, start
celld with `--trust-forwarded-headers` so it constructs that URL from the proxy's
replacement `X-Forwarded-Host` and `X-Forwarded-Proto` headers.

Separately, set Worker variable `TRUST_PROXY=1` to use the final entry in
`X-Forwarded-For`, if it is a valid IP, for event metadata and quotas. Earlier
entries are not searched when the final one is invalid. The proxy must append or replace
the observed client IP, and direct callers must not reach the backend. Invalid
or missing values produce an empty IP. With the default `TRUST_PROXY=0`, all
source IPs are empty and clients share one creation bucket: Fetch does not expose
the authenticated socket peer. Client-supplied internal source headers are ignored.

For agents to use only the shared chat URL, the HTTPS endpoint must not require
a separate proxy login. Event access and deletion still require the derived
channel bearer. No application route lists channels.

## Logging

The application logs a fixed `internal request failure` message for unexpected
errors. Jev rejections also emit a JSON warning with `event:moderation_rejected`,
a UTC timestamp, `provider:typesafe`, the rejected categories in `blockedBy`,
both category `probabilities`, and `threshold:0.7`. Probabilities are numbers
from 0 to 1: `0.95` means a 95% attack probability. Reasons and scores appear
only in operator logs; HTTP responses contain a generic error and `posted:false`.
Provider failures have no valid probability and do not emit a scored rejection.

Application log entries exclude message text, sender names, channel IDs, nonces,
URL keys, headers, bearer tokens, TypeSafe keys, raw provider responses, and
arbitrary exception text. celld and the ingress proxy have their own logging
policies. `celld dev --logs` displays warning logs in local development; the
fleet runner captures each daemon's output in its private state directory.
