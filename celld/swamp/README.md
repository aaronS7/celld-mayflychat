# Mercury credentials and celld deployment

This directory is a swamp repository for the existing Mayfly consolidated
fleet. The vault and workflow definitions are ready to use on the deployment
VM. No Mercury credential is included in the checkout.

Run these commands from the application checkout:

```sh
# Interactive: URL, model, then hidden API-key entry and confirmation.
npm run mercury:setup

# Build, check and bundle without publishing a deployment.
npm run mercury:preview

# Build, check, redeploy Mayfly and enable summaries.
npm run mercury:deploy
```

The setup command does not deploy anything. Repeat it to rotate the key or
change providers, then run the deployment workflow again. Enter credentials
only into the terminal prompt, not into chat, shell arguments or YAML files.

## Vault storage

`configure.py` uses swamp's `local_encryption` vault named `mayfly-mercury`.
It stores a single encrypted entry, `MERCURY_CONFIG`, containing
`MERCURY_BASE_URL`, `MERCURY_API_KEY` and `MERCURY_MODEL`. Keeping them together
prevents a partial setup from pairing a new endpoint with an old key. The key
is entered without terminal echo; the script sends the entry to `swamp vault
put` over stdin. Model selection defaults to `mercury-2.5`.

Vault runtime state, including its local encryption key, lives under the
ignored `.swamp/` directory. The encryption key has to be retained along with
the encrypted data to recover this local vault. This is a local encrypted
vault on the VM, not a separately hosted key-management service. The committed
vault YAML contains only its ID, name, type and storage configuration.

List key names without revealing values:

```sh
swamp vault list-keys mayfly-mercury --repo-dir celld/swamp --json
```

## Deployment workflow

The deployment checkout's `workflows/workflow-mayfly-deploy.yaml` uses
swamp's built-in `command/shell` model. There is no celld-specific installed
model type. The workflow has two ordered steps:

1. Generate the app assets and run the TypeScript/generated-file checks.
2. Resolve the vault entry at execution time and run `deploy.py`. It loads
   Mayfly's current production bindings, overlays the three Mercury values
   and `AI_SUMMARY_ENABLED=1`, bundles a dry-run, then publishes and verifies.

The second step receives the vault entry as an environment value, never as
literal YAML or a command argument. Celld's application settings are **Worker
bindings**: the adapter writes a temporary private Wrangler configuration and
passes that to the consolidated fleet's `ctl.py`. Exporting variables only on
the celld daemon would not update its Worker.

Existing Jev, wiki, retention, reporting and other production values come from
the live deployment manifest and remain unchanged. The adapter checks Durable
Object classes, R2 bindings, compatibility date and cron configuration before
publishing. Infrastructure changes or an encrypted deployment stop the run.
It also refuses to overwrite a catalog changed during preparation. A local
lock prevents overlapping runs of this adapter.

Staging uses a private directory outside the checkout and a mode-0600 config.
It is removed on success, failure and ordinary cancellation. Deployment output
contains status and version, not credentials or raw celld diagnostics. As with
other celld Worker variables, the key is present in private fleet deployment
metadata after publication; the vault does not change that storage boundary.

An applied deployment checks the manifest's bindings and summary availability
on the three existing nodes and public HTTPS. It does not call Mercury or
test the key's provider permissions; use an actual summary afterward for that.
A failure after publishing is reported as such where detected and does not
automatically roll back user data or the deployment.

## Direct swamp commands and inputs

Always validate before running:

```sh
swamp workflow validate mayfly-deploy --repo-dir celld/swamp
swamp workflow run mayfly-deploy --repo-dir celld/swamp --input dryRun=true

swamp workflow validate mayfly-deploy --repo-dir celld/swamp
swamp workflow run mayfly-deploy --repo-dir celld/swamp
```

`dryRun` defaults to `false`: an ordinary run deploys and enables summaries.
The workflow has defaults for this VM's application `checkout`, consolidated
`fleetDirectory`, deployment `python` with boto3, and `publicOrigin`. Override
these using repeated `--input name=value` arguments when using a different
checkout. Do not pass provider secrets as workflow inputs. After relocating
the swamp repository, also update the local vault's `base_dir` through
`swamp vault edit` so it refers to the intended vault storage.

The fleet directory must contain its existing `ctl.py`, `migration-plan.json`,
`environment-private.json` and matching celld binary. Storage credentials remain
in the fleet's private configuration; this setup does not copy them into the
Mercury vault. Node.js, npm dependencies, esbuild, swamp, and Python with boto3
must be installed. This workflow targets the consolidated fleet and does not
use the retired `fleet.mjs` deployment helper.

Inspect a run through swamp:

```sh
swamp workflow history get mayfly-deploy --repo-dir celld/swamp --json
swamp data get mayfly-deploy result --repo-dir celld/swamp --json
```

## Tests

```sh
npm run test:deployment
npm run test:deployment:e2e
```

The functional suite checks validation, preservation of existing bindings,
resource drift, cancellation, private staging and both preview/apply paths.
The end-to-end suite creates a disposable swamp repository and encrypted vault,
drives the real interactive prompt through a terminal, runs the actual swamp
workflow and celld dry-run against a local S3 fixture, then rotates the fixture
key and runs again. It checks that terminal output and swamp result/history
data contain no test credentials. It never publishes to the live fleet or calls
Mercury. The E2E suite needs this VM's tools or `MAYFLY_TEST_CELLD` and
`MAYFLY_DEPLOY_PYTHON` overrides.

The separation between model methods, workflow ordering and runtime vault
references follows swamp's [workflow design](https://github.com/swamp-club/swamp/blob/main/design/primitives/workflows.md)
and [vault design](https://github.com/swamp-club/swamp/blob/main/design/primitives/vaults.md).
