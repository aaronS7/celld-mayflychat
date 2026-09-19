# Run your own

This deployment uses the native TypeScript port of Mayfly for celld 0.5. Each
chat is a Durable Object with its own SQLite storage. The browser and the Node,
Python, and Go command-line clients negotiate the selected message format.
Messages are plaintext by default. Set Worker variable `ENCRYPTION_ENABLED=1`
for the original local encryption; this always disables Jev. Plaintext can be
screened with `JEV_ENABLED=1` and a server-side `TYPESAFE_API_KEY`.
`JEV_TAGGING_ENABLED=1` independently enables [automatic message tags](tagging.md)
with the same provider credential. Encryption disables tagging as well.

From a checkout containing `celld/native/worker.ts`:

```sh
npm ci
npm run dev
```

Use the [upstream celld 0.5 documentation](https://github.com/denoland/celld/blob/v0.5.0/docs/README.md)
for installation, storage, and node setup. With celld 0.5.0, `esbuild` on PATH,
and Node.js 22+ available, open
`http://127.0.0.1:9876`. Local chat storage lives in `.celld/dev` and survives an
ordinary stop/start. `--clean` deletes it. The native deployment starts fresh;
it does not import chats from the Go database or the older container adapter.

Copy `.dev.vars.example` to `.dev.vars` for local flags and credentials. Fleet
deployments use Worker bindings instead; see [environment variables](configuration.md)
for defaults, accepted values, and privacy/key-handling implications. After switching encryption modes, create a new
chat. Existing histories are not converted.

## Enable persistent knowledge and summaries

`WIKI_ENABLED=1` enables a SQLite Durable Object per wiki, with versioned pages,
FTS5 search and discussion. Keep the `WIKIS`, `WIKI_CREATION` and `WIKI_FILES`
bindings and existing migrations from `wrangler.jsonc`; uploaded attachments use the
R2 binding. Wikis persist independently of chat retention. Disabling the feature
hides its routes without deleting data. `WIKI_BOOK_LAYOUT_ENABLED=1` adds the
desktop sidebar and mobile drawer. Optional `JEV_WIKI_SEARCH_ENABLED=1` reuses
the chat TypeSafe credential for bounded search ranking. See [wikis](wiki.md).

`AI_SUMMARY_ENABLED=1` enables on-demand Mercury summaries. Configure the
provider base URL, separate API key and model together as private Worker
bindings. Summaries stream over the request connection, so the ingress must
allow incremental SSE delivery and the request deadline. Encryption makes
wikis and summaries unavailable. See [streaming summaries](summaries.md).

## Update an existing deployment

Keep the existing Worker name, Durable Object identities, storage bindings and
production variables when redeploying. The repository's `fleet:*` commands are
for a disposable same-host test fleet; they are not the update path for the
existing consolidated production fleet.

That deployment VM has a [swamp vault workflow](https://github.com/aaronS7/celld-mayflychat/blob/main/celld/swamp/README.md):
`npm run mercury:setup` stores provider settings through a hidden key prompt,
`npm run mercury:preview` builds and checks without publishing, and
`npm run mercury:deploy` enables summaries while preserving live bindings.
It requires the existing consolidated fleet's private configuration and helper;
it does not provision a new fleet. Verify a real summary after deploying, since
availability flags alone do not establish provider health.

For production, deploy to a supported fleet bucket, run celld under a process
supervisor, and put its public listener behind an HTTPS proxy, following the
upstream celld guide. [Operations](operations.md) covers Mayfly's timeouts,
retention, quotas, and proxy trust.

The upstream Go implementation remains available at
[github.com/josharian/mayfly](https://github.com/josharian/mayfly). The native port
is separate code in this checkout.
