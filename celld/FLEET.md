# Same-host fleet test helper

This optional repository helper runs **three celld 0.5.0 daemons on one Linux
host**, with separate local state directories and a shared, isolated S3 prefix.
It tests process failure and recovery, not independent-host failure or capacity.
For celld installation, bucket setup, process supervision, and multi-machine
operation, use the [upstream celld docs](https://github.com/denoland/celld/blob/v0.5.0/docs/README.md)
and [durability requirements](https://github.com/denoland/celld/blob/v0.5.0/docs/guarantees.md).

## Inputs and commands

With celld 0.5.0, esbuild, Node.js 22+, and npm dependencies available, provide
`s3.celld.env` at the repository root. This ignored JSON file needs:

```json
{
  "accessKeyId": "<access-key-id>",
  "secretAccessKey": "<secret-access-key>",
  "bucket": "example-mayfly-bucket",
  "s3Endpoint": "https://s3.example.invalid:8333",
  "region": "us-east-1",
  "forcePathStyle": true,
  "signatureVersion": "s3v4"
}
```

An optional `sessionToken` supports temporary credentials. Extra identity,
access, `verified`, `createdAt`, and `iamEndpoint` fields are informational;
the helper does not contact IAM or alter bucket policy. It checks storage
conditional writes itself. The file is restricted to `0600`; keys go into daemon
environments, not Worker bindings or command arguments.

```sh
npm run fleet:up
npm run fleet:status
node celld/fleet.mjs diagnose
npm run fleet:deploy
npm run fleet:down
```

State defaults to `~/.local/state/mayfly-celld-fleet`. See the
[environment reference](docs/configuration.md#optional-fleet-helper-inputs) for
`MAYFLY_FLEET_STATE`, retained policy selections, Jev key handling, and which
shell variables the helper actually forwards. New state gets a unique prefix
under `s3://BUCKET/mayfly-fleet-test/`; credentials themselves are not
prefix-scoped by the helper. No command deletes objects outside that prefix.

Status includes private infrastructure identifiers; do not attach it to public
issues without scrubbing. Local public/operator listeners bind to loopback.
These detached test processes have no supervisor and do not restart after a
crash or reboot. Stopping retains the bucket and local disks; `fleet:up` reuses
the same state. Keep follower disks until recovery has completed, because fleet
acknowledgments can precede bucket upload.

## Tests and evidence

Only run fault tests on a disposable deployment. `npm run test:fleet` kills and
pauses nodes, switches to encrypted mode with Jev off, temporarily shortens
retention, and exercises cold recovery on fresh local directories. It attempts
to restore the selected policy and three healthy nodes, leaving the fleet
running after success. It does not delete unrelated bucket data or prove that
all unflushed follower disks can be lost simultaneously.

Run client/browser/hosting checks to completion before fault injection; use
[test controls](docs/configuration.md#test-controls) to select the test URL and
executables. Do not run these tests concurrently against the same fleet.

The private state directory holds `fault-report.json`, node logs, deployment
configuration, diagnostics, and acknowledgment evidence. Tests include signed
peer probes, CAS races, cross-node polls, process failover/fencing, deletion,
expiry, and recovery after a graceful shutdown. See
[FLEET-VERIFICATION.md](FLEET-VERIFICATION.md) for recorded results and limits.

## Optional private HTTPS test helper

On a host already configured for Tailscale HTTPS, `npm run fleet:https` creates
an independent nginx instance and a Serve listener on port `8443`. It requires
nginx and permission to run `sudo -n tailscale serve`. Use
`node celld/fleet-https.mjs up 8444` to select another unused port. Refer to
[upstream Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
for Tailscale setup and access policy.

The helper retains existing unrelated listeners, enables both forwarded-origin
and Worker source-IP trust, and rolls the three nodes. It supplies a fixed HTTPS
origin and observed client IP while keeping the backend on loopback. The
separate `npm run test:ingress` also injects node failure. A POST interrupted
after forwarding can have committed; read before retrying.

Remove only this fleet's ingress before stopping its nodes:

```sh
node celld/fleet-https.mjs down
npm run fleet:down
```
