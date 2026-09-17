# Verification — 2026-09-17

Mayfly runs through the added container adapter on **celld 0.5.0**. The original
Go repository by itself is not a Worker project: its initial `celld deploy .
--dry-run` failed because it had no Wrangler configuration.

The adapter is suitable for **ephemeral hosting**. A previously acknowledged
chat returned HTTP 404 after stopping and restarting celld, even though its
`.celld/dev` directory was retained. celld's Durable Object storage does not
persist the Go process's separate SQLite file. See the [hosting guide](README.md)
before deploying.

## Versions

| Component | Tested version |
| --- | --- |
| Upstream Mayfly | `06dd34e918f651e1a8b86531bd3ef1815a4d6a4e` |
| celld | `0.5.0`, Linux x86-64 |
| Go | `1.27.1` |
| Node.js | `24.21.0` |
| esbuild | `0.28.2` |
| Docker | `29.1.3` |
| Container SDK | `@cloudflare/containers@0.3.7`, locked in `package-lock.json` |

## Completed checks

| Check | Result |
| --- | --- |
| `go build ./cmd/mayfly` | Passed |
| `go vet ./...` | Passed, with one package at a time to limit memory |
| `go test -race -p 1 -count=1 ./...` with Python cryptography, Node, and `CHROME_BIN` | Passed: 742 test/subtest pass events, zero failures or skips |
| `celld deploy . --dry-run --json` | Passed, including Docker image build and Worker bundling |
| `MAYFLY_TEST_WAIT_SECONDS=125 npm run test:hosting` against celld | Passed: 9 test/subtest pass events, zero failures or skips |
| Stop/start with an existing acknowledged chat | Confirmed chat loss: HTTP 404 after restart |
| `git diff --check` and JavaScript syntax checks | Passed |

The celld integration test used the actual downloaded Mayfly creator and client.
It verified HTML and security headers, documentation, byte-identical client
downloads, channel creation, external instruction origins, authentication,
encrypted posting and decryption, ciphertext-only API responses, concurrent
long polling, a 125-second idle wait, compare-and-swap conflicts, cross-origin
creation rejection, and deletion. It also checked that a visitor cannot select
another container port through the SDK control header.

## Fixes found during verification

- A redirect setting on the Worker request did not survive the celld Durable
  Object hop. Applying `redirect: "manual"` inside `MayflyContainer.fetch()`
  preserves Mayfly's HTTP 303 creation response; otherwise its supplied creator
  fails with HTTP 200.
- celld defaults to a 120-second outbound fetch timeout and a 300-second handler
  budget. Development scripts and production instructions now use 86,500 seconds
  to accommodate Mayfly's maximum 86,400-second wait. The integration test
  exercised a successful 125-second wait.
- Upstream's browser fixture required a GitHub footer link and then asserted
  that the same link was absent. The fixture now asserts exactly one such link,
  preserving its duplicate-link check. No application UI, protocol, crypto, or
  storage code was changed.

The initial copied test tree omitted three root Markdown files, causing link
test failures; the complete tree was used for the successful final run. An
initial vet process exhausted the VM's memory; the successful run limited
compiler concurrency and memory. These were test-environment issues.

## Scope

Tests ran locally on this VM using celld's real container runtime. The Docker
engine was installed and the test account added to the `docker` group; a
new login session is required for an existing shell to pick up that group.
Build/test artifacts were kept outside the repository.

No production bucket was supplied or deployed to. Remote object storage, fleet
failover, capacity under sustained load, and public HTTPS ingress were not
validated. Container support remains experimental in celld 0.5.0. Production
hosting that preserves Mayfly's restart durability needs persistent storage
outside these containers or a port to Durable Objects.
