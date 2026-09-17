# Native celld verification — 2026-09-17

This records the original encrypted-only baseline. The current optional
encryption and Jev implementation has [separate verification](ENCRYPTION-VERIFICATION.md);
the default mode and served client sources have changed since this baseline.

The native TypeScript implementation runs on **celld 0.5.0**, using one SQLite
Durable Object per chat. The default deployment does not use Docker or the Go
server. Tests exercised the real celld runtime, not a mocked Durable Object API.
Existing chats were not imported.

## Environment

| Component | Version |
| --- | --- |
| Mayfly reference | `06dd34e918f651e1a8b86531bd3ef1815a4d6a4e` |
| celld | `0.5.0`, Linux x86-64 |
| Go reference and Go client | `1.27.1` |
| Node.js | `24.21.0` |
| TypeScript | `7.0.2` |
| Worker types | `5.20260917.1` |
| esbuild | `0.28.2` |
| Chrome for Testing | `153.0.8010.12` |

The final native harness ran from an isolated local-disk copy with temporary
listeners and databases. Its native sources, generated assets, Wrangler config,
and dependency lock were verified identical to this workspace.

## Native checks

| Check | Result |
| --- | --- |
| Generated asset freshness and TypeScript type checking | Passed |
| Original Go regression suite, with race detector, Node, Python, and Chrome | 742 test/subtest pass events; zero failures or skips |
| `npm test` integration tests | 27 pass events; zero failures, skips, or cancellations |
| Real browser | Creation, two-tab encrypted delivery, Markdown, title changes, missing-key notice, CSP, documentation, deletion passed |
| Original Node, Python, and Go programs | All three creators and every sender/reader combination passed; conflicts and undecryptable placeholders preserved |
| Differential HTTP checks against Go | Passed: validation, auth/error precedence, methods, cross-origin checks, integer bounds, padded base64, opaque envelopes, atomic CAS, polling, deletion, re-creation, byte limits, paging, quotas, content negotiation, headers |
| Exact source downloads | All six client/creator files remain byte-identical to upstream |
| Stop/start persistence | Acknowledged ciphertext, bearer hash, cursor, and deletion persisted |
| Retention | Reads did not refresh activity; accepted posts did; alarms woke polls with 404; an expiry alarm survived restart |
| Retention disabled and proxy trust disabled | Passed; empty source metadata and no automatic expiry |
| Deployment dry-run | Passed with `Chat` and `CreationGate` SQLite bindings |
| Extended event-count check | 10,000 consecutive appends and rejection of the next append passed against both implementations |
| Extended idle poll | A 125-second idle poll passed with the configured runtime budgets |

Native operational and security documentation intentionally differs from the
Go reference. It documents empty IP metadata without a trusted proxy, persistent
quotas, alarm-based expiry, and celld-controlled shutdown. The UI and crypto
sources are reused without changes.

The Go suite retains the earlier correction to `srv/testdata/markdown.js`: its
footer test required a GitHub link and also required that link to be absent.
It now checks that there is exactly one such link. No Go application behavior
was changed. The final Go run completed in 193 seconds; its JSON evidence was
retained outside the repository.

## Reproduction

```sh
npm ci
CHROME_BIN=/path/to/chrome npm test
CHROME_BIN=/path/to/chrome \
  MAYFLY_TEST_FULL=1 MAYFLY_TEST_WAIT_SECONDS=125 npm test
```

Go 1.27.1+, Node, Python with `cryptography`, celld 0.5.0, and esbuild must be
available. `GO_BIN` and `PYTHON_BIN` override the executables. Test scripts create
and remove their own temporary state; `MAYFLY_KEEP_TEST_STATE=1` retains it.

The successful native harness evidence was retained in local test logs outside
the repository. The extended cases passed, but that earlier combined run
encountered a stale documentation bundle
while documentation was being edited and a timeout under concurrent test load.
The final 27-test run and lifecycle checks used consistent sources, ran alone,
and completed successfully. The extended cases are not represented as a clean
run of the entire extended harness.

## Scope and remaining boundaries

After the local checks above, supplied credentials were used for a real
three-daemon deployment against the remote S3 endpoint. Nine fleet checks,
private HTTPS ingress checks, and the final 14-check HTTPS client/browser run
passed. See [the fleet report](FLEET-VERIFICATION.md) for exact scope and evidence.
The daemons share one VM: independent-host failure, public internet ingress,
and fleet capacity remain untested. The test daemons are not supervised
production services.

The Go-specific shutdown JSON is not reproduced. celld can interrupt a held
request or return a runtime overload response. A post with an uncertain outcome
may have committed; existing clients require reading before resubmitting.
Long polls remain active requests and count toward the runtime admission limit.

The old container verification is retained separately in
[legacy/VERIFICATION.md](legacy/VERIFICATION.md). Its confirmed container chat
loss does not describe the native Durable Object implementation.
