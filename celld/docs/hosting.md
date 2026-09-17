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

For production, deploy to a supported fleet bucket, run celld under a process
supervisor, and put its public listener behind an HTTPS proxy, following the
upstream celld guide. [Operations](operations.md) covers Mayfly's timeouts,
retention, quotas, and proxy trust.

The upstream Go implementation remains available at
[github.com/josharian/mayfly](https://github.com/josharian/mayfly). The native port
is separate code in this checkout.
