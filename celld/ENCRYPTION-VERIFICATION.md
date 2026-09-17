# Optional encryption and Jev verification — 2026-09-17

The three-node celld 0.5.0 test fleet was verified with
`ENCRYPTION_ENABLED=0` and `JEV_ENABLED=1` through a private tailnet HTTPS
endpoint. Hostnames, bucket names, and deployment identifiers are omitted
from this public report.
Configuration defaults and implications are in the
[environment reference](docs/configuration.md); screening details are in
[JEV.md](JEV.md).

## Completed checks

| Check | Result |
| --- | --- |
| Generated assets, TypeScript, whitespace checks | Passed |
| Original Go regression suite, race detector, Node/Python/Chrome | 742 test/subtest passes, zero failures or skips |
| Encrypted compatibility harness against Go | 27 checks passed, including Chrome and Node/Python/Go interoperability |
| Encrypted persistence and expiry | Restart, alarm recovery, disabled retention, and deployment dry-run passed |
| TypeSafe adapter | 8 tests passed, including real celld, exact 0.70 boundaries, malformed responses, and ten-second deadline |
| Configuration and private deployment bindings | 3 tests passed; encryption overrides Jev, invalid flags/retention fail closed, unused credentials omitted |
| Full admission path in real celld with local provider fixture | 10 tests/subtests passed, plus two nested 14-check browser/client/hosting runs |
| Initial three-node rollout | All nodes advertise plaintext/Jev-off; authenticated plaintext posts/reads agree across nodes |
| Upgrade from the previous live schema | Synthetic legacy encrypted history remained identical after schema upgrade; previous-mode posts refused |
| Plaintext HTTPS owner failure | Killed the owner; history recovered through nginx in 9,225 ms; subsequent append and deletion passed |
| Downloaded clients over fleet HTTPS | 13 checks passed across all three creators and every sender/reader combination |
| Real Chrome over fleet HTTPS | Creation, two-tab plaintext delivery, Markdown/title handling, missing-key notice, CSP, docs, and deletion passed |
| Fleet diagnostics after recovery | All 8 checks passed; all three daemons running |
| Live Jev deployment | All three nodes and HTTPS advertise `encryption:false`, `moderation:true`; real TypeSafe key works |
| Live Jev sample messages | Ordinary conversation and defensive discussion accepted; injection and exfiltration rejected with HTTP 422 |
| Live rejection persistence | Rejections leave history/cursor unchanged; all three nodes return identical accepted history; temporary chat deleted |
| Published curl examples | Executed all four examples from `JEV-CURL.md` against a second temporary chat; HTTP 200/422/422/200; chat deleted |
| Operator logging and generic HTTP | Each rejected message writes one JSON warning with categories and exact probabilities; HTTP body/headers expose neither |
| Logging regression checks | TypeScript and generated assets passed; policy suite 10/10 plus two nested 14/14 browser/client/hosting runs passed |
| Real Jev logging | Four live messages returned 200/422/422/200; actual daemon warnings captured, matching scores and categories; chat deleted |

Policy tests cover plaintext authentication and format validation, disabled
provider calls, enabled screening without credentials, either score at or above
0.70, unchanged history/expiry on rejection, stale-cursor avoidance of provider
calls, provider errors, concurrent CAS winners, deletion/recreation with the
same bearer during screening, expiry during screening, and both mode switches.
Chrome checks that a rejected draft remains editable and does not establish a
successful sender identity. All three CLIs report rejection as `posted:false`.

An independent configuration review found that blank or sub-millisecond
retention values could silently disable expiry. They now fail closed before
Durable Object dispatch. Regression checks verify HTTP 503
`configuration_error` with `posted:false`, unchanged existing history, no
provider calls, and exact millisecond parsing (including `1.001` seconds).
These additional checks use isolated local celld instances and provider
fixtures; the live fleet results above are earlier evidence, and this review
did not redeploy the live fleet.

The first policy harness attempt exposed a Node test-runner issue: inherited
`NODE_TEST_CONTEXT` silently skipped nested tests. The harness now removes that
variable; the final runs executed all 28 nested checks successfully.

The first Go regression run hit the existing navigation fixture's 60-second
deadline. The same timeout reproduced with the unmodified upstream browser
sources supplied through a Go overlay. That single fixture now has 180 seconds
for its 18 creation gestures and additional native navigation; other fixtures
retain their 60-second allowance. No assertions were removed. It completed in
79.09 seconds in the final full race run, which passed all 742 test/subtest events.
The structured Go test output was retained outside the repository.

## Evidence and limits

Private fleet evidence includes `encryption-rollout-report.json`,
`ingress-report.json`, and `diagnose-encryption-update.log` in the operator's
fleet state directory. The earlier encrypted
ingress report is retained as `ingress-report-encrypted-previous.json`.

The initial live verification used the supplied TypeSafe API key for eight
real screening calls on 2026-09-17: four sample messages, then the same four
through the published curl examples. The private evidence files are
`jev-live-report.json` (including
actual rejection responses) and `jev-curl-report.json` in the same fleet state
directory. The ordinary message and defensive question returned HTTP 200.
At that earlier deployment, the injection sample returned HTTP 422 with
`blockedBy:["prompt_injection"]`; the exfiltration sample returned HTTP 422 with
both categories. Rejected messages
did not change history or cursor. Authenticated history agreed across all three
nodes, and both synthetic chats were deleted. No pre-existing chat was used.
The model alias remains `jev-latest`. These four samples establish live
integration, not detection accuracy
against a broad corpus or guaranteed future classifications. The exact 0.70
boundary remains covered by deterministic provider-fixture tests.

The latest deployment moves rejection categories into private operator logs
alongside both validated probabilities and the 0.70 threshold. HTTP bodies now
contain only the generic error, `code:moderation_rejected`, and `posted:false`.
Categories, scores, and the threshold are absent from both response bodies and
headers. Log entries contain no message content, sender, channel identifier,
nonce, URL key, bearer, provider key, or raw provider response.

The logging update was checked with four additional live messages at 11:41 UTC.
The actual daemon entries are captured in `jev-logging-report.json` alongside
the generic HTTP responses. The injection sample logged probabilities of 0.99
for prompt injection and 0.08 for exfiltration; only prompt injection crossed the
threshold. The exfiltration sample logged 0.93 and 0.99 respectively and both
categories crossed the threshold. Both messages returned HTTP 422 and did not
change history or cursor. Ordinary conversation and defensive discussion were
accepted without rejection log entries. Reads agreed across all three nodes,
and the temporary chat was deleted.

The first logging test run could not see warnings because `celld dev` hides them
by default. The fixture now uses `--logs`; the final suite passed all 9 policy
checks and both nested 14-check runs, including Chrome and Node/Python/Go clients.
Tests assert exact generic replies, both 0.70 boundaries, valid structured logs,
omission of identifying data, and no scored rejection for provider errors or
allowed, disabled, or encrypted traffic. The logging update also passed generated
asset freshness, TypeScript, and whitespace checks; the older full Go and
destructive fleet checks above were not repeated for this change.

Before enabling Jev, the three test daemons and the dedicated nginx ingress were
stopped. They were restarted using their existing state and S3 prefix. The live
configuration now retains plaintext screening on subsequent fleet deployments.

The topology remains three processes on one VM with a remote S3 endpoint.
This update did not repeat the full nine-case destructive fleet suite, capacity
testing, or separate-machine failure tests. The daemons are still test processes
without a production supervisor. No original chat content was read or converted;
upgrade and rollout checks used synthetic chats and deleted their fixtures.
