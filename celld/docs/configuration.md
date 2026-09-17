# Environment variables and their implications

This reference covers the native TypeScript application on **celld 0.5.0**.
The original Go server is always encrypted and uses its own command-line flags;
these Worker settings do not configure it. For installing celld, configuring
storage, and operating nodes, use the
[upstream celld documentation](https://github.com/denoland/celld/blob/v0.5.0/docs/README.md).

## Where settings belong

Mayfly reads **Worker bindings**, not arbitrary environment variables on the
celld process. The committed `wrangler.jsonc` contains non-secret defaults.
For local development, copy `.dev.vars.example` to the ignored `.dev.vars` and
run `npm run dev`. `.dev.vars` overrides those defaults for `celld dev` only.
For a fleet, put bindings in its private deployment configuration and deploy
the change. Exporting a Worker setting on a running daemon does not update it.

The repository's optional three-node test helper explicitly translates a few
shell variables into bindings; its precedence is described below. `npm run deploy`
is a direct celld deployment and does not perform that translation or
read `typesafe.celld.env`.

## Worker bindings

Values are strings. Use `0` and `1` for flags, not `false` and `true`.

| Variable | Default and accepted values | Effect and implications |
| --- | --- | --- |
| `ENCRYPTION_ENABLED` | `0`; exactly `0` or `1` | `0` sends and stores readable message names/text. `1` enables client-side end-to-end encryption and always disables Jev, even if its flag is invalid or its key is missing. Other values cause HTTP 503 `configuration_error`. |
| `JEV_ENABLED` | `0`; exactly `0` or `1` when encryption is off | `1` sends each candidate message's name/text to TypeSafe before acceptance. An invalid flag fails with HTTP 503 `configuration_error` in plaintext mode. Ignored when encryption is on. |
| `JEV_TAGGING_ENABLED` | `0`; exactly `0` or `1` when encryption is off | Independently enables automatic tags on new plaintext messages. Sends names/text to TypeSafe even when moderation is off. Invalid flags cause HTTP 503 `configuration_error`; ignored when encryption is on. Tagging failures leave messages untagged, without bypassing moderation. See [tagging rules](tagging.md). |
| `TYPESAFE_API_KEY` | Unset; nonblank TypeSafe credential | Used by plaintext moderation or tagging. Leading/trailing whitespace is trimmed. Missing credentials or provider failures refuse posts with HTTP 503 `moderation_unavailable` when moderation is on; tagging alone accepts without labels. Never commit a real key. |
| `TYPESAFE_MODEL` | `jev-latest`; a model identifier supported by TypeSafe | Shared by moderation and tagging. An empty string also selects `jev-latest`. A moving alias may change results; use a supported fixed model identifier when reproducibility matters. Invalid/unavailable models fail closed for moderation or leave tagging-only posts untagged. |
| `RETENTION_SECONDS` | `86400`; non-negative decimal seconds, at most three fractional digits, maximum `315360000` | Zero disables idle expiry. Positive values must be at least `0.001`. Blank values, whitespace, signs, exponent/hex notation, excess precision, and out-of-range values cause HTTP 503 `configuration_error`. Disabling expiry retains live chats until deletion or storage loss; channel size limits still apply. |
| `TRUST_PROXY` | `0`; use `0` or `1` | Only the literal `1` trusts the final comma-delimited `X-Forwarded-For` entry if it is a valid IP. Every other value disables trust. With trust off, event source IPs are empty and callers share one creation quota. With trust on, IPs are stored and visible to all chat participants. |

The actual TypeSafe endpoint, moderation/tagging thresholds, and ten-second provider timeout are
fixed in the application; there are no environment overrides for them.

## Encryption, moderation, and tagging policy

| Encryption | Moderation (`JEV_ENABLED`) | Tagging (`JEV_TAGGING_ENABLED`) | New messages |
| --- | --- | --- | --- |
| `0` | `0` | `0` | Plaintext, without provider calls |
| `0` | `1` | `0` | Plaintext, screened before append |
| `0` | `0` | `1` | Plaintext, tagged when classification succeeds |
| `0` | `1` | `1` | Plaintext, screened and tagged in one provider call |
| `1` | Any | Any | Client-encrypted; no provider calls |

The full chat URL remains a bearer capability in every mode: anyone with it can
read, post, or delete. Plaintext mode exposes contents to the server operator
and storage administrators. Jev additionally discloses candidate contents to
TypeSafe, including rejected messages. HTTPS protects transport independently
of message encryption. Encryption still requires trusting the client code
distributed by the server.

A chat keeps the format chosen at creation. Changing encryption never converts
stored history: chats in the previous mode remain readable/deletable but refuse
new posts with HTTP 412 `mode_changed`. Create a new chat for the selected mode.
Changing Jev or its model applies to future plaintext posts; it does not rescan
or remove old messages. Tagging does not backfill history, and disabling it does
not erase stored labels. Previously stored plaintext and provider copies do not
become encrypted when encryption is enabled later. Reload already-open browser
pages to display a changed privacy policy; the server applies its current
policy to subsequent posts regardless of the displayed text.

Jev rejects when either prompt-injection or data-exfiltration **attack
probability is at least 0.70**. These are Noul probabilities, not TypeSafe's
separate Choice/Score confidence statistic. Rejections return generic HTTP 422
`moderation_rejected`; provider failures return generic HTTP 503
`moderation_unavailable`. Neither appends a message or refreshes its expiry.
Operator logs contain rejection categories and probabilities; HTTP responses
contain neither. Messages, sender names, and credentials are excluded from
those application log entries. Infrastructure logging is configured separately.

Tagging uses probabilities of at least 0.75 for research, question, information,
and command; multiple tags may apply. Undetermined requires at least 0.60 with
every other probability strictly below 0.30. No match means no tag. Tag failures
produce a `tagging_unavailable` operator warning without content or credentials.
See [automatic tags](tagging.md) for delivery, persistence, and failure behavior.

Screening and tagging add an external dependency, latency, and API usage. Jev classifies
each message independently, can miss attacks or reject benign content, and does
not authorize instructions. There is no application limit on moderation calls
or spend: repeated rejected posts and concurrent proposals can consume calls
without appending. Creation quotas are not a message-rate limit. Restrict access
and set suitable ingress/provider usage controls for your deployment.

`/config` reports the selected policy, not key validity or provider health.
`moderation:true` can coexist with posts failing because the key is absent,
invalid, or the service is unavailable. See `celld/JEV.md` and
`celld/JEV-CURL.md` in the checkout for logging details and test requests.

## Retention and proxy consequences

Creation and accepted posts refresh activity. Reads, waits, rejected posts, and
conflicts do not. A retention change affects an existing chat on its next
request or already scheduled alarm; shortening it does not reschedule every
dormant object immediately. Expiry and deletion remove live records, not
participant copies, SQLite free pages, replicas, or backups.

Only enable `TRUST_PROXY=1` behind a trusted proxy that appends or replaces the
observed client IP and prevents direct access to the backend. An invalid final
forwarded entry produces an empty IP; earlier entries are not searched. This
setting does not configure the public origin. Celld's separate
`--trust-forwarded-headers` / `CELLD_TRUST_FORWARDED_HEADERS` setting handles
forwarded host/protocol; the trusted proxy must replace those headers too.

## Celld process settings relevant to Mayfly

These belong on each **daemon**, not in Worker `vars`. Restart/reconfigure the
nodes to change them; deploying Worker code alone does not do so. Use the
[upstream environment reference](https://github.com/denoland/celld/blob/v0.5.0/docs/README.md#environment-variables)
and `celld -h` for the full list, supported values, and storage credentials.

| Variable | Mayfly implication |
| --- | --- |
| `CELLD_FETCH_TIMEOUT_S` | Use `86500` to accommodate Mayfly's maximum 86,400-second poll; celld's default is 120 seconds. |
| `CELLD_HANDLER_BUDGET_S` | Use `86500` for the same reason; celld's default is 300 seconds. The ingress timeout must also accommodate the wait. |
| `CELLD_MAX_CELL_REQUESTS` | Default `64`. Held polls occupy request slots on their chat object; an overloaded cell can refuse requests with 503. More chat objects do not raise one chat's limit. |
| `CELLD_TRUST_FORWARDED_HEADERS` | Forwarded-origin trust; separate from Mayfly's `TRUST_PROXY` source-IP policy. Restrict backend access before enabling either. |
| `CELLD_BUCKET`, `S3_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Storage/deployment configuration, not application bindings. Bucket access grants fleet-administrator capabilities and can expose plaintext chats and private deployment variables. |

`npm run dev` fixes both timeout budgets to `86500` for its child process.
The test fleet helper also fixes them; ordinary `npm run deploy` does not.

## Optional fleet-helper inputs

This is the repository's same-host test runner, not a celld installation guide.
See `celld/FLEET.md` in the checkout for its commands and fault-test boundaries.

| Input | Resolution and consequences |
| --- | --- |
| `MAYFLY_FLEET_STATE` | Defaults to `~/.local/state/mayfly-celld-fleet`. An explicit state-directory argument to `fleet.mjs` wins. Changing the directory selects another fleet/prefix; it does not migrate the current one. Keep it outside the repo on local disk: it contains databases, logs, private deployment config, and infrastructure identifiers. |
| `ENCRYPTION_ENABLED`, `JEV_ENABLED`, `JEV_TAGGING_ENABLED`, `TYPESAFE_MODEL` | A supplied shell variable overrides the previously saved selection, which overrides `wrangler.jsonc`. Omission keeps the previous selection; use explicit `0` to disable a flag. A model reset can use `TYPESAFE_MODEL=jev-latest`. |
| `TYPESAFE_API_KEY` | For plaintext screening or tagging, a nonempty shell value takes precedence over the `TYPESAFE_API_KEY=...` line in ignored `typesafe.celld.env`. The file supports optional enclosing quotes, not shell execution. Missing, blank, or multiline resolved key values stop deployment; provider validity is checked only on a post. The key is loaded again for every deployment using Jev; it is not saved in `fleet.json`. |

The helper only forwards the four policy/model variables and credential above.
Exporting `RETENTION_SECONDS` or `TRUST_PROXY` does not configure its Worker.
Retention comes from `wrangler.jsonc`; the HTTPS helper enables proxy trust in
both the Worker and daemon configuration and retains that selection.
`TYPESAFE_MODEL` in `typesafe.celld.env` is not read; use a shell variable or
private Worker configuration for the model.

The helper reads `s3.celld.env` for storage credentials, including optional
`sessionToken`; it replaces inherited AWS key/region/endpoint values and clears
an inherited session token unless the file supplies one. These credentials are
not copied into Worker bindings. The runner fixes durability to `fleet`, two
Tokio threads, placement weight `1`, a 64 MiB isolate heap, and a 256 MiB RSS
pressure threshold per process; the latter is not a hard memory cap. These are
test-runner choices, not generic celld defaults or shell overrides.

The TypeSafe key **is** included in the generated private Worker configuration
and S3 deployment metadata. Those are not a separate secret vault. The helper
omits it from new deployments when unused, but old deployments can retain it;
disabling Jev does not revoke a key or erase historical copies. Keep `.dev.vars`,
credential files, and private state out of Git; do not put keys in committed
`wrangler.jsonc` or attach private state/logs to public issues.

## Test controls

Standalone integration tests create, post to, and delete synthetic chats. Use
test deployments; targeting a screened or tagged server can consume real API calls. The
policy suite substitutes a local provider fixture and does not call TypeSafe.

| Variable | Default and effect |
| --- | --- |
| `MAYFLY_BASE_URL` | Hosting smoke test defaults to `http://127.0.0.1:9876`; browser/client/protocol tests default to port `9890`. The full harness supplies temporary ports itself. |
| `MAYFLY_REFERENCE_URL` | Protocol comparison defaults to `http://127.0.0.1:9891` for the Go reference; the full harness supplies its own. |
| `CHROME_BIN` | Chrome/Chromium executable path. Required for the browser/full harness; policy tests include browser checks when set. |
| `GO_BIN`, `PYTHON_BIN` | Default `go` and `python3`; override the client/reference test executables. Python client tests require `cryptography`. |
| `MAYFLY_TEST_FULL` | Only `1` selects the 10,000-event boundary test; otherwise the protocol suite uses 503 events. |
| `MAYFLY_TEST_WAIT_SECONDS` | Default `1`; integer `1` through `86400` for the hosting poll check. Larger values lengthen the test; use `125` to exceed celld's usual fetch timeout. |
| `MAYFLY_KEEP_TEST_STATE` | Unset/empty lets the full harness clean up after success. Any nonempty value, including `0`, retains its temporary state/logs. Failures retain them automatically. |
| `MAYFLY_TEST_REJECTION_TEXT` | Unset disables the extra rejection assertion. When set, browser/client tests submit that text and expect refusal; the policy suite sets a synthetic fixture value. |
| `MAYFLY_TEST_TAGS` | Unset disables tag assertions. A JSON array enables checks that browser/client messages retain exactly those labels. Intended for the policy suite's deterministic local provider fixture. |
