# Admin management, retention, and backups

Management is opt-in (`MANAGEMENT_ENABLED=1`), with an OIDC-protected UI at
`/admin`. Only chats and wikis created after enabling it are registered. Existing
resources retain their original behavior and never enter the catalog merely
because someone reads or edits them. Disabling management hides the UI and stops
registration of new resources; already managed resources continue their saved
retention policies, pending deletions and expiry. Keep the Management and archive
storage bindings when disabling the UI.

New to the panel? Follow [Setting up the admin panel](management-setup.md) for
OIDC registration, local and production configuration, deployment, a
verification checklist and troubleshooting.

## Configure

Use private Worker bindings for secrets. The checked-in configuration adds the
`MANAGEMENT` SQLite Durable Object (migration `v3-management`) and the
`ARCHIVES` R2 binding, with management disabled. Archives use Celld's existing
fleet bucket by default; no additional S3 endpoint or credentials are needed.
Keep existing DO bindings and names unchanged when deploying.
Run `npm ci` before building: `jose` validates
OIDC signatures and claims; `aws4fetch` supports the optional external S3 adapter.

### Minimal setup with Celld

Include the checked-in `MANAGEMENT` migration and `ARCHIVES` binding in your
deployment, then supply these Worker variables with your own OIDC values:

```dotenv
MANAGEMENT_ENABLED=1
MANAGEMENT_ORIGIN=https://mayfly.example.com
OIDC_ISSUER=https://identity.example.com
OIDC_CLIENT_ID=mayfly-admin
OIDC_ADMIN_SUBJECTS=["stable-admin-subject"]
```

For a confidential OIDC client, also supply `OIDC_CLIENT_SECRET` privately.
Register `https://mayfly.example.com/admin/callback` as the redirect URI, using
your actual Mayfly origin. Leave `ARCHIVE_STORAGE` and all `ARCHIVE_S3_*`
variables unset: the default `ARCHIVES` binding reuses Celld's bucket and
credentials.

Set `MANAGEMENT_ARCHIVE_ON_TTL=1` if newly created resources should default to
backup before deletion at their TTL deadline. Its default is `0` (delete without
a new backup). Admins can change this policy separately for each managed resource.

### Configuration reference

| Binding | Meaning / default |
| --- | --- |
| `MANAGEMENT_ENABLED` | `0`; `1` enrolls future creations and enables `/admin` |
| `MANAGEMENT_ORIGIN` | Exact HTTPS origin for `/admin`, without trailing slash; a dedicated admin hostname is recommended |
| `OIDC_ISSUER` | Exact provider issuer (must match discovery and ID token) |
| `OIDC_CLIENT_ID` | Registered OIDC client ID |
| `OIDC_CLIENT_SECRET` | Optional secret; confidential clients use `client_secret_basic` |
| `OIDC_ADMIN_SUBJECTS` | JSON array of allowed `sub` strings for this issuer, e.g. `["admin-subject"]` |
| `MANAGEMENT_CHAT_IDLE_SECONDS` | `RETENTION_SECONDS`, normally `86400` |
| `MANAGEMENT_CHAT_AGE_SECONDS` | `0` (no maximum age) |
| `MANAGEMENT_WIKI_IDLE_SECONDS` | `0` (no idle limit) |
| `MANAGEMENT_WIKI_AGE_SECONDS` | `0` (no maximum age) |
| `MANAGEMENT_ARCHIVE_ON_TTL` | `0`; `1` archives before automatic deletion |
| `MANAGEMENT_AUDIT_DAYS` | `90`; range 1–3650 |
| `ARCHIVE_STORAGE` | `r2` by default; uses `ARCHIVES`. Set `s3` only for an optional separate bucket |

TTL defaults are whole seconds from 1 to 315360000, or `0` to disable. If the
legacy `RETENTION_SECONDS` is fractional, set `MANAGEMENT_CHAT_IDLE_SECONDS`
explicitly. Defaults are copied once on creation; changes never rewrite existing
policies. Admin API policies use `null` for no limit and include a `paused` flag.
While management is enabled, an invalid TTL, archive or audit default, or
`MANAGEMENT_ARCHIVE_ON_TTL=1` without archive storage, makes **every chat and
wiki creation fail with 503**, not just the admin panel.

Register the exact redirect URI `MANAGEMENT_ORIGIN/admin/callback` with the
provider. It must support Authorization Code, PKCE S256, discovery/JWKS, and
RS256 or ES256 ID tokens. `OIDC_ISSUER` must equal the discovery `issuer` and
the ID token `iss` exactly, including any trailing slash. Authorization uses the
stable `(issuer, sub)` pair, not email, display name, or group claims. Missing
configuration denies access. Discovery, token-endpoint and JWKS failures
(unreachable, timeout, 5xx, redirect, malformed response) return 503 "Identity
provider unavailable"; a token endpoint that rejects the exchange, an invalid ID
token or an unlisted subject returns 403.

Every admin request must arrive on `MANAGEMENT_ORIGIN`; other hosts get 403.
Because `/admin` otherwise shares the Worker and origin with chats and wikis,
point a dedicated hostname (e.g. `admin.mayfly.example.com`) at the same
listener and use it as `MANAGEMENT_ORIGIN`. Cookies are `__Host-` prefixed,
HttpOnly, Secure and SameSite=Lax. The pending login (state, nonce, PKCE
verifier) is sealed in a five-minute encrypted cookie in the signing-in browser,
so abandoned attempts do not consume server-side slots. Sessions expire in one
hour; refresh tokens are not stored. Allowlist removal takes effect on the next
request: `/admin` shows the sign-in page again and API calls return 403.
Mutations require the session CSRF token, an exact `Origin` and, when the
browser sends it, `Sec-Fetch-Site: same-origin`.

HTTP is accepted whenever `MANAGEMENT_ORIGIN` is `http://127.0.0.1:<port>` or
`http://localhost:<port>`, not only under `celld dev`; the issuer and provider
endpoints may then also be HTTP on loopback, and cookies drop `Secure` and the
`__Host-` prefix. Use this only for local development and the test IdP.

### Archive storage: use the existing Celld bucket

**Celld's R2 bindings are logical buckets inside the fleet bucket**, under
`r2/<bucket_name>/`, per its [compatibility
reference](https://github.com/denoland/celld/blob/v0.5.0/docs/cloudflare-compat.md#r2).
The default works in production using Celld's existing storage configuration;
it does not require a Cloudflare R2 account or another physical bucket.

The following entry is already included in `wrangler.jsonc`'s `r2_buckets` array:

```json
{ "binding": "ARCHIVES", "bucket_name": "mayfly-archives" }
```

Here, `mayfly-archives` names a logical bucket prefix within Celld's existing
fleet bucket; you do not need to provision a physical bucket with that name.

Deploy that binding together with the management migration. Leave
`ARCHIVE_STORAGE` unset (or set it to `r2`). Archive objects then live under
`r2/mayfly-archives/mayfly/v1/` in the existing fleet bucket, separate from live
resource data. Mayfly accesses them through `env.ARCHIVES`; Celld handles the
underlying storage credentials. Configure OIDC and enable management to activate
the feature. No application-level S3 configuration is needed.

Archive retention is independent of resource TTL. The service keeps completed
archives until a storage lifecycle rule or an operator removes them. If you add
a lifecycle rule, scope it to the archive prefix in the shared fleet bucket. A
receipt may therefore outlive its bytes; restore then fails safely. Abandoned
incomplete prefixes have no manifest. Review age and receipts before removing
such prefixes, since a pending job can still resume them. A
[canceled backup](#retry-or-cancel-a-pending-operation) also leaves such a
prefix; its `archive-canceled` (or `archive-delete-canceled`) audit entry names
it, and no job will resume it.

The Mercury-only deployment adapter intentionally refuses new infrastructure
bindings, so `npm run mercury:deploy` is blocked until the management migration
has been applied through a reviewed private deployment. Subsequent Mercury
redeployments copy the live variables and preserve those bindings, which also
means they cannot change any management variable: enabling, disabling and
allowlist changes need another private deployment. The adapter also stops if any
live variable is a `secret_text` binding, so supply `OIDC_CLIENT_SECRET` as an
ordinary private variable. See [deployment paths](management-setup.md#5-deploy).

### Optional: a separate S3 bucket

Use this only when you want backups in a physically separate bucket. Set
`ARCHIVE_STORAGE=s3` and supply these private Worker bindings:

| Binding | Meaning |
| --- | --- |
| `ARCHIVE_S3_ENDPOINT` | HTTPS S3 endpoint origin, e.g. `https://s3.us-east-1.amazonaws.com` |
| `ARCHIVE_S3_BUCKET` | Private backup bucket name |
| `ARCHIVE_S3_REGION` | Signing region (`auto` for Cloudflare R2's S3 API) |
| `ARCHIVE_S3_ACCESS_KEY_ID` | Credential with access to the archive bucket |
| `ARCHIVE_S3_SECRET_ACCESS_KEY` | Signing secret |
| `ARCHIVE_S3_SESSION_TOKEN` | Optional token for temporary credentials |

The adapter uses path-style URLs, conditional creation, and authenticated
read-back verification. It needs GetObject and PutObject under `mayfly/v1/`;
it does not need permission to delete completed archives. Keep these credentials
available for pending jobs even when management is disabled.

## Retention behavior

A resource expires at the earlier of `created_at + age_seconds` and
`last_activity_at + idle_seconds`. Either may be absent. Pause disables both
computed deadlines without changing their stored values. Resuming an overdue
policy expires it immediately; changing the policy also re-evaluates it
immediately. The original creation time is preserved across restore.

Accepted chat posts advance activity. Wiki page creation/edit/deletion/restore,
comment updates (including resolving a thread), and completed attachment uploads
advance activity. Reads, search, summaries, drafts, failed writes and companion
shortcuts do not. Late writes recheck state/deadline after body or provider waits
and cannot enter an expired resource's snapshot.

At expiry the resource freezes writes and reads. Its current `archive_on_ttl`
policy chooses full backup then deletion, or direct deletion. A failed backup
never authorizes deletion. The admin screen shows lifecycle state, progress,
retry time and failure count; automatic retries use exponential backoff up to
one hour, and **Retry failed operation** requests an earlier attempt.
**Cancel operation** abandons it instead; see
[Retry or cancel a pending operation](#retry-or-cancel-a-pending-operation).

Manual actions are separate:

- **Archive now** briefly freezes access, creates a backup, then resumes the resource.
- **Archive and delete** removes live content only after a verified backup receipt.
- **Delete** creates no new backup. Existing backups remain.
- **Restore** requires a deleted resource and an existing receipt. It restores the
  original ID and access metadata, so original link holders regain access.
  Both TTLs are paused until an admin deliberately sets or resumes them.

### Retry or cancel a pending operation

An archive, expiry, deletion or restore runs as a durable job. The resource
details show its state and stage (for example `archiving · files` or
`deleting · erase`). When a stage fails, the job keeps its progress and retries
automatically with backoff. Use **Retry failed operation** once you have fixed
the cause (storage credentials, a missing archive object) to try again now from
saved progress.

Use **Cancel operation** when you would rather abandon the job than finish it:
the cause cannot be fixed soon, the backup was started by mistake, or the
resource is frozen and you need it back. Cancel is offered whenever a job is
cancellable, whether it is running or has failed, and is safe mid-run. It never
touches existing verified backups. Its effect depends on the job:

- **Archive now** or **Archive and delete** (before erasure): the resource
  returns to `active` with its live content untouched.
- **Automatic expiry** (reason `ttl`): as above, and **both TTLs are paused**,
  because the overdue deadline would otherwise expire the resource again
  immediately. Review the policy and resume it deliberately.
- **Restore** that has not yet written content: the resource returns to
  `deleted`.
- **Restore** that has written content: a rollback starts (state `deleting`,
  reason `restore-canceled`) that erases the partial restore, then the resource
  returns to `deleted`, keeping its original deletion time. The backup remains
  available to restore again.

Objects a canceled backup already wrote stay in archive storage under
`mayfly/v1/{chat|wiki}/{resource-id}/{job-id}/` (with the default binding,
`r2/mayfly-archives/mayfly/v1/…` in the fleet bucket). No backup references them,
and the audit entry records the prefix so an operator can remove it.

Once the `erase` stage has started (a **Delete**, or the deletion step after a
verified backup), live content is already being removed and the job cannot be
canceled; the API returns 409 "Deletion has started and cannot be canceled;
retry to finish it". Fix the cause and retry. Each cancel is audited as
`<action>-canceled`, e.g. `archive-canceled` or `restore-canceled`.

A normal capability holder can still delete their resource; this creates no new
backup and does not remove existing admin backups. Deleted managed IDs remain
reserved and can only be reactivated with admin restore. Linked companions are
independent; restoring a wiki does not restore its chat. The UI displays known
companion states; older unmanaged companions have unknown status.

## Full backup and restore

Each immutable archive has a unique prefix:
`mayfly/v1/{chat|wiki}/{resource-id}/{archive-id}/`. Bounded SQL batches and each
completed attachment become separately hashed objects. `manifest.json` is
published last, with format/schema version 1, original metadata, row counts,
object sizes and SHA-256 hashes. The durable receipt pins the manifest's own
SHA-256. Writes and read-back checks complete before any live deletion begins.

Chat backups include all retained events with exact sequence numbers, timestamps,
nonces, plaintext or ciphertext payloads, tags, authorization hash, mode and
sealed companion links. Wiki backups include pages (including deleted ones),
all revisions, comments/thread state, changes, navigation metadata, sealed links,
search data, and every completed attachment's metadata and bytes, even when
unreferenced. Interrupted uploads are excluded. No fragment key, OIDC token or
bucket credential is included. Encrypted chats still need their original link
key after restore.

Restore first verifies every object against the pinned manifest, then writes
rows and attachments under their original IDs while the resource remains
unavailable. It verifies restored data before exposing it. Durable cursors make
jobs resumable after a process restart. Backup failures retain live content;
restore failures retain the archive and keep partially restored content hidden.
The database schema and small tombstone remain in the original resource object.
The current restore API requires that tombstone and its receipt; rebuilding a
lost fleet/catalog from downloaded files is a separate disaster-recovery task.

**Download full backup** returns a streaming TAR containing `manifest.json` and
`objects/0`, `objects/1`, etc. The manifest retains their full bucket keys. TAR
supports backups beyond the existing user-facing wiki ZIP export limits. The
existing wiki ZIP export remains a separate current-content migration feature.
Archive downloads require an authorized session throughout streaming.

The resource-local record is authoritative. Writes do not wait for the catalog:
a durable outbox updates it, so inventory activity and state can lag by up to
about 30 seconds, longer during a catalog outage.
Resource details read the authoritative object. Audit events record admin
identity, policy version, action, outcome and retries. They expire after the
configured audit retention period; content-free tombstones and archive receipts
remain so IDs cannot be reused and backups stay discoverable.

## API and verification

All `/admin/api` routes require the OIDC session cookie. Obtain the CSRF token
from `GET /admin/api/session`; send `X-CSRF-Token` and `Origin` on writes.

- `GET /admin/api/resources?kind=wiki&state=active&after=…` — paged inventory.
- `GET /admin/api/resources/{kind}/{id}` — state, deadlines, progress and companion states.
- `PUT .../policy` — complete policy plus current `policy_version` (optimistic concurrency).
- `POST .../action` — `action`: `archive`, `archive-delete`, `delete`, `retry`,
  `cancel`, or `restore`. Restore also requires `archive_id` and
  `confirm_original_links:true`. Cancel returns 409 "No pending operation" when
  nothing is running. Resource details report `job` as `null` or
  `{action, stage, cancellable}`; `cancellable` is false only in the `erase` stage.
- `GET .../archives`, `GET .../audit` — receipts and recent audit history.
- `GET .../download?archive_id=…` — full TAR download.

Actions return 202 and continue on durable alarms. The admin UI polls the open
resource automatically while a job runs; API clients should poll resource
details for completion. A 202 response is not proof that a backup or restore
finished.

Run `npm run check` and `CHROME_BIN=/usr/bin/google-chrome npm run test:management`.
The management suite uses isolated real Celld storage, a local signing OIDC
provider and injected storage failures. It checks full wiki/plaintext/encrypted
round trips, original authorization, restart recovery, dual TTLs, overdue policy
changes, writes crossing expiry, corrupt archives, failed backups, unauthorized
identities, session/CSRF checks, and the admin UI in Chrome. These local tests do
not validate a production provider's credentials or bucket settings; verify those
with disposable resources before enabling archive policies on valuable data.
