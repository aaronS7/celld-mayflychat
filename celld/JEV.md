# Encryption and optional Jev screening and tagging

The native celld application defaults to **plaintext messages**, with Jev off.
The [environment-variable reference](docs/configuration.md) covers all settings,
their precedence, and operational/privacy implications.
The full chat URL is still required to read, write, and delete. HTTPS protects
transport; turning off message encryption does not turn off HTTPS or bearer
authentication. Plaintext mode lets the server operator read stored messages.

| `ENCRYPTION_ENABLED` | `JEV_ENABLED` | Result |
| --- | --- | --- |
| `0` or unset | `0` or unset | Plaintext messages; no screening |
| `0` or unset | `1` | Plaintext screened before storage; API key required |
| `1` | Any value | End-to-end encryption; Jev is never called |

Independently set `JEV_TAGGING_ENABLED=1` for automatic research, question,
information, command, and undetermined labels. It defaults off. Tagging sends
plaintext to TypeSafe even without moderation; encryption disables it too.
See [automatic tagging](docs/tagging.md) for the 75%/60%/30% rules, multi-label
output, persistence, and optional-enrichment failure behavior. Both features
share one provider call when enabled together.

Flags use `0` and `1`. Other encryption values fail closed. An invalid Jev flag
fails closed in plaintext mode. Encryption takes precedence over Jev, including
when both are set to `1` or no TypeSafe key exists.

## Configure local development

Copy `.dev.vars.example` to `.dev.vars` and select the flags, then run
`npm run dev`. To enable screening, also set `TYPESAFE_API_KEY` in `.dev.vars`.
That file is ignored by Git. The flags in `wrangler.jsonc` are the defaults.
These are Worker bindings: celld 0.5 does not automatically turn arbitrary
daemon environment variables into Worker bindings, and `.dev.vars` is dev-only.

## Configure a fleet using this repository's test helper

The fleet helper translates these environment variables into Worker bindings:

```sh
# Default behavior: plaintext, without Jev.
ENCRYPTION_ENABLED=0 JEV_ENABLED=0 JEV_TAGGING_ENABLED=0 npm run fleet:deploy

# Encrypted messages; Jev stays off even if JEV_ENABLED was previously 1.
ENCRYPTION_ENABLED=1 npm run fleet:deploy

# Plaintext with enforced screening, after supplying the API key.
ENCRYPTION_ENABLED=0 JEV_ENABLED=1 npm run fleet:deploy

# Enable automatic tags alongside screening.
ENCRYPTION_ENABLED=0 JEV_ENABLED=1 JEV_TAGGING_ENABLED=1 npm run fleet:deploy
```

The helper retains the last selected flags for later deployments. For screening or tagging,
put `TYPESAFE_API_KEY=...` in `typesafe.celld.env` at the repository root with
permissions `0600`, or supply it in the deploying process's environment. The
file is ignored by Git. `TYPESAFE_MODEL` optionally pins a model; the default is
`jev-latest`.

The helper loads the credential only for plaintext screening or tagging. It excludes it
from `fleet.json`, status output, public settings, browser code, and client
downloads. celld 0.5 deploys it as a server-side Worker variable: it is present in
the private generated deployment configuration and the fleet's deployment data
in S3. Restrict access to both; this is not a separate secret vault. Historical
deployments can retain an old key, so disabling screening does not revoke it.
Never put a real key in the repository's committed `wrangler.jsonc`.

For a fleet not managed by this helper, supply the flags and credential through
its private deployment configuration. An exported daemon variable alone is not
sufficient.

## Message admission

Jev receives only the actual `from` and `text` that will be stored and delivered.
The server rejects ciphertext or additional payload fields in plaintext mode.
Modified clients cannot bypass the check by supplying harmless text alongside
different ciphertext. Names, titles, replies, and reactions use the same message
path; there is no client-controlled moderation exemption.

Moderation sends two Noul questions to TypeSafe's `POST /v1/systemone`: prompt
injection and data exfiltration (plus five independent label questions when
tagging is enabled). Either attack probability **greater than or
equal to 0.70** rejects the message with HTTP 422, `code:moderation_rejected`,
and `posted:false`. Both must be below 0.70. Noul is the probability of “yes”; it
is not the distinct Choice/Score `confidence` statistic.

Missing credentials, provider errors, invalid answers, oversized responses, and
a ten-second timeout fail closed with HTTP 503, `code:moderation_unavailable`,
and `posted:false`. Rejections do not append, advance the cursor, refresh expiry,
or notify readers. Authentication and cursor/capacity checks precede the provider
call and are checked again before commit, including channel recreation and
expiry. Concurrent valid proposals may each incur a provider call; only one can
win the same cursor.

The adapter does not add channel IDs, bearer credentials, encryption keys,
ciphertext, or participant IPs to the screening payload; anything a sender
includes in the name/text itself is still sent. TypeSafe also sees the server's
network connection. Errors never reflect provider bodies or credentials, and
redirects are refused. Model scores are not a guarantee that all attacks will be
detected. Large messages can exceed a provider context limit and fail closed.
Screening is per message, with no conversation history. There is no moderation
call-rate or spending limit: rejected messages and concurrent proposals can
still incur API usage. Apply appropriate access and usage controls.

`/config` reports policy, not provider readiness: `moderation:true` does not
verify a valid key or a working provider. Enabling screening or changing models
affects future posts, including those in existing plaintext chats; it does not
rescan old history. Already-open browser pages need a reload to show a changed
privacy policy, although the server applies its current policy to posts.

## Operator logging

Each Jev rejection emits a JSON warning to the celld node log with
`event:moderation_rejected`, a UTC timestamp, `provider:typesafe`, `blockedBy`,
both category `probabilities`, and `threshold:0.7`. For example (illustrative
scores):

```json
{"event":"moderation_rejected","timestamp":"2026-09-17T12:00:00.000Z","provider":"typesafe","blockedBy":["prompt_injection"],"probabilities":{"prompt_injection":0.95,"data_exfiltration":0.1},"threshold":0.7}
```

A probability of `0.95` means 95% for that attack category. These are Jev's Noul
attack probabilities, not the separate Choice/Score confidence statistic. Both
scores are logged so an operator can see every category that crossed the
threshold. Allowed messages and disabled moderation emit no rejection entry.
Provider failures have no valid score and must not be mistaken for a scored
rejection.

The application log entry contains no message text, sender name, channel ID,
nonce, URL key, bearer, TypeSafe key, or raw provider response. HTTP 422 bodies
contain only the generic error, `code:moderation_rejected`, and `posted:false`;
neither headers nor bodies expose categories or scores.

For a fleet managed by this repository's helper, inspect the private daemon logs
on its host (`MAYFLY_FLEET_STATE` overrides the default state directory):

```sh
rg '"event":"moderation_rejected"' \
  "${MAYFLY_FLEET_STATE:-$HOME/.local/state/mayfly-celld-fleet}"/mayfly-*.log
```

Use `npm run dev -- --logs` to display warnings in local development; celld dev
hides node warning and information logs by default.

## Switching modes and clients

A chat's format is fixed at creation. Changing the flag never decrypts or
encrypts stored history. Chats in the previous mode remain readable and deletable
but reject new posts with HTTP 412; create a new chat to use the selected mode.
Older ciphertext-only celld databases are recognized as encrypted during upgrade.

The served browser and Node/Python/Go clients support both modes. Pages display
the active privacy policy. Clients read `/config` for creation and authenticated
`/c/ID/config` for messages. Old upstream clients work in encrypted mode; download
the current clients for plaintext mode. The upstream Go server stays encrypted.

## Verification

```sh
npm run check
npm run test:moderation
npm run test:tagging
CHROME_BIN=/path/to/chrome npm run test:policy
```

Adapter tests cover the threshold, response validation, metadata minimization,
and bounded failures. Policy tests run the full Worker in celld 0.5 with a local
provider fixture, exercise both formats, real browsers and all three CLI
languages, and test concurrency, recreation, expiry, and mode switches.
Tagging additionally covers exact thresholds, independent labels, failure
isolation, persistence, and display. See [tagging verification](TAGGING-VERIFICATION.md)
for fixture and real-provider results.
Live TypeSafe checks on the three-node fleet passed with the supplied key on
2026-09-17: ordinary conversation and defensive discussion were accepted;
prompt injection and data exfiltration samples were rejected without appending.
See [the verification report](ENCRYPTION-VERIFICATION.md) and
[copyable curl examples for your own chat](JEV-CURL.md). These samples verify
live integration; they are not a comprehensive measure of detection accuracy.

References: [TypeSafe API](https://docs.typesafe.ai/api),
[Noul probabilities](https://docs.typesafe.ai/primitives/noul),
[confidence versus probability](https://docs.typesafe.ai/confidence).
