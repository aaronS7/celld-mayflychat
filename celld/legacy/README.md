# Historical container adapter

The default deployment is now [native TypeScript with one Durable Object per
chat](../README.md). This directory preserves the earlier container verification
record; it is not evidence for the native port.

To run the old Go adapter from the repository root, install the root npm
dependencies and run a Docker daemon, then:

```sh
CELLD_FETCH_TIMEOUT_S=86500 CELLD_HANDLER_BUDGET_S=86500 \
  celld dev wrangler.container.jsonc
```

It uses `celld/worker.js`, the root `Dockerfile`, and a singleton
`MayflyContainer`. Its SQLite database lives inside the container and can be
lost on node restart, movement, or image replacement. `.celld/dev` preserves
celld state but does not turn the container filesystem into durable storage.
The native implementation addresses that limitation using `ctx.storage.sql`.

Do not reuse an old container state directory as the native port's storage.
There is no chat migration. See [the earlier results](VERIFICATION.md) for the
original adapter's tested scope.
