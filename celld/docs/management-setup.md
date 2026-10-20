# Setting up the admin panel

This walkthrough takes a checkout to a working, verified `/admin` panel.
[Admin management](management.md) is the reference for retention, backup,
restore and the admin API; read its introduction before enabling the panel on a
deployment with valuable data.

Management enrolls only chats and wikis **created after** `MANAGEMENT_ENABLED=1`
takes effect. It never adopts existing resources.

## 1. Prerequisites

- celld 0.5.0, `esbuild` and Node.js 22+, as for any Mayfly build. See the
  [upstream celld documentation](https://github.com/denoland/celld/blob/v0.5.0/docs/README.md).
- `npm ci` in every checkout you build or deploy from, including the Mercury
  deployment checkout. The Worker bundles `jose` (ID token verification) and
  `aws4fetch` (optional S3 archive adapter) from `node_modules`; the deployment
  scripts symlink it into their staging directories, so the build fails without it.
- A celld fleet with its usual fleet bucket. Backups go to the logical R2 bucket
  `r2/mayfly-archives/` inside it; no separate bucket or credentials are needed.
- An OIDC provider with discovery, Authorization Code with PKCE `S256`, and
  RS256 or ES256 ID tokens. celld nodes must reach it over HTTPS: Mayfly fetches
  discovery, the token endpoint and the JWKS server-side with a 15-second
  timeout and refuses redirects.
- An HTTPS origin for the panel. Prefer a **dedicated admin hostname**, see
  [Choose the admin origin](#choose-the-admin-origin).

### Choose the admin origin

`/admin` is served by the same Worker as chats and wikis. Mayfly pins every
admin request to `MANAGEMENT_ORIGIN` and refuses others with 403 "Use the
configured management origin", so you can point a second hostname, for example
`https://admin.mayfly.example.com`, at the same celld listener and set
`MANAGEMENT_ORIGIN` to it. The session cookie then belongs to a host where
users do not open shared chat and wiki content. The Worker still serves chat and
wiki routes on that hostname; don't share links that use it. The ingress needs
a certificate for the hostname and must pass it through as the request host
(see [Operations](operations.md) for forwarded-header trust).

## 2. Register an OIDC client

| Setting | Value |
| --- | --- |
| Application type | Web application with a client secret (recommended). Public clients also work; Mayfly then sends only `client_id` to the token endpoint. |
| Grant | Authorization Code |
| PKCE | `S256`; discovery must list it in `code_challenge_methods_supported`. |
| Redirect URI | Exactly `MANAGEMENT_ORIGIN` + `/admin/callback`, e.g. `https://admin.mayfly.example.com/admin/callback`. Locally: `http://127.0.0.1:9876/admin/callback`. |
| Client authentication | `client_secret_basic` when `OIDC_CLIENT_SECRET` is set, otherwise none. |
| ID token signing | RS256 or ES256. Other algorithms are rejected. |
| Scopes | Only `openid`. No email, name or group claims are read. |

Mayfly authorizes the stable `(issuer, sub)` pair for the single configured
`OIDC_ISSUER`. Confirm the issuer before continuing:

```sh
curl -s https://identity.example.com/.well-known/openid-configuration \
  | jq '{issuer, code_challenge_methods_supported, id_token_signing_alg_values_supported}'
```

Copy `issuer` **character for character into `OIDC_ISSUER`, including any
trailing slash**. The configuration check tolerates a slash difference, but
sign-in compares the discovery `issuer` and the ID token `iss` exactly and
fails with 503 "Provider must support OIDC and PKCE S256" on a mismatch.

### Provider notes

These are starting points only. Console labels, issuer formats and defaults
change: **check your provider's current documentation**, and always use the
issuer that discovery reports.

- **Google:** a Web application OAuth client (Google Cloud Console credentials)
  with the redirect URI as an authorized redirect URI. Issuer
  `https://accounts.google.com`. Web clients use a secret. `sub` is a numeric
  account ID.
- **Okta:** an OIDC Web Application integration with the Authorization Code
  grant, client-secret authentication and PKCE required; assign the admins to
  it. The issuer differs between the org and custom authorization servers.
  `sub` is the user's Okta ID (`00u…`).
- **Auth0:** a Regular Web Application with RS256 signing and the redirect URI
  as an allowed callback URL; use the Basic client-secret method. The issuer
  typically **ends with `/`**. `sub` is the `user_id`, e.g. `auth0|…`.
- **Keycloak:** an OpenID Connect client with client authentication and the
  standard flow on, PKCE method `S256`. Issuer
  `https://<host>/realms/<realm>`. `sub` is the user's ID (a UUID).

### Find your `sub`

Mayfly never shows or logs the subject of a rejected sign-in, so obtain it
first: from the provider's admin console, or (for providers that issue pairwise
subjects per client) by decoding an ID token issued **to this client** locally:

```sh
node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64url")).sub)' "$ID_TOKEN"
```

`OIDC_ADMIN_SUBJECTS` is a JSON array of 1–255 character strings, e.g.
`["00u1a2b3c4","00u5d6e7f8"]`. After sign-in, `GET /admin/api/session` returns
the accepted `subject`.

## 3. Try it locally

`npm run dev` runs `celld dev .` on `http://127.0.0.1:9876` and reads
`.dev.vars`. Copy `.dev.vars.example` to `.dev.vars` and set:

```dotenv
MANAGEMENT_ENABLED=1
MANAGEMENT_ORIGIN=http://127.0.0.1:9876
OIDC_ISSUER=http://localhost:8080/realms/mayfly
OIDC_CLIENT_ID=mayfly-admin
OIDC_CLIENT_SECRET=local-client-secret
OIDC_ADMIN_SUBJECTS=["your-subject"]
```

In `.dev.vars`, write the JSON array as-is (or in single quotes). Don't
backslash-escape the quotes and don't add a trailing `# comment`: celld keeps
both in the value, which makes the allowlist invalid. Restart `npm run dev`
after editing.

Open exactly `http://127.0.0.1:9876/admin`; `http://localhost:9876/admin` gets
403 "Use the configured management origin". On another port
(`npm run dev -- --port 9890`), change `MANAGEMENT_ORIGIN` and the registered
redirect URI to match.

Plain HTTP is accepted whenever `MANAGEMENT_ORIGIN` is `http://127.0.0.1:<port>`
or `http://localhost:<port>`. The issuer and provider endpoints may then also
use HTTP on loopback, which suits a local Keycloak container. A hosted provider
works if it accepts a loopback redirect URI; its issuer must still be HTTPS.
In this mode the cookies are `mayfly_admin` and `mayfly_admin_login`, without
`Secure` or the `__Host-` prefix. **Never use a loopback origin for a shared
deployment.**

Local archives use the `ARCHIVES` binding in `.celld/dev`;
`npm run dev -- --clean` deletes them with everything else.

The automated suite needs no provider account:

```sh
npm run check
CHROME_BIN=/usr/bin/google-chrome npm run test:management
```

It runs an in-process signing provider without an interactive login page, so it
cannot be used for manual sign-in and doesn't validate a real provider.

## 4. Configure production

| Binding | Example | Notes |
| --- | --- | --- |
| `MANAGEMENT_ENABLED` | `1` | Only exactly `1` enables `/admin` and enrollment. |
| `MANAGEMENT_ORIGIN` | `https://admin.mayfly.example.com` | Scheme, lowercase host and optional port only: no path, trailing slash or `:443`. |
| `OIDC_ISSUER` | `https://identity.example.com` | Exactly as discovery reports it. |
| `OIDC_CLIENT_ID` | `mayfly-admin` | Required. |
| `OIDC_CLIENT_SECRET` | private | Confidential clients only. |
| `OIDC_ADMIN_SUBJECTS` | `["00u1a2b3c4"]` | JSON array, stored as a string value. |

Optional defaults for new resources are in the
[configuration reference](management.md#configuration-reference). Leave
`ARCHIVE_STORAGE` and `ARCHIVE_S3_*` unset to use `ARCHIVES`.

> **Invalid defaults break chat and wiki creation, not just the panel.** While
> management is enabled, every creation validates them and fails with 503 on a
> non-integer TTL, a fractional `RETENTION_SECONDS` without an explicit
> `MANAGEMENT_CHAT_IDLE_SECONDS`, `MANAGEMENT_ARCHIVE_ON_TTL` other than `0`/`1`,
> `MANAGEMENT_AUDIT_DAYS` outside 1–3650, `MANAGEMENT_ARCHIVE_ON_TTL=1` without
> usable archive storage, or a missing `MANAGEMENT` binding. OIDC mistakes
> affect only `/admin`.

In JSON deployment configuration (`wrangler.jsonc` `vars`), every value is a
string, so escape the inner quotes:

```json
"OIDC_ADMIN_SUBJECTS": "[\"00u1a2b3c4\",\"00u5d6e7f8\"]"
```

Variables, including `OIDC_CLIENT_SECRET`, are stored in private deployment
configuration and in deployment metadata in the fleet bucket. Treat them like
the TypeSafe and Mercury keys and never commit them to `wrangler.jsonc`.

## 5. Deploy

The committed `wrangler.jsonc` already declares the `MANAGEMENT` Durable Object,
the `v3-management` migration, the `ARCHIVES` binding and
`MANAGEMENT_ENABLED=0`. Every path must keep the existing bindings, Durable
Object names, migrations, compatibility date, crons and **all current
production variables**.

**Direct celld deployment.** `npm run deploy` deploys the committed file, which
has no OIDC values. To add them, deploy a private project directory:

1. In the checkout: `npm ci && npm run generate && npm run check`.
2. Create a `0700` directory outside the checkout, copy `celld/native/` into it
   and symlink the checkout's `node_modules` beside it.
3. Write `wrangler.jsonc` (mode `0600`): the committed configuration with your
   management and OIDC values merged into `vars`.
4. `celld deploy <directory> --dry-run`, then `celld deploy <directory>`.

**Same-host test fleet (`npm run fleet:deploy`).** The helper forwards
`MANAGEMENT_*`, `OIDC_*` and `ARCHIVE_*` from the shell and remembers the
non-secret ones. `OIDC_CLIENT_SECRET`, `ARCHIVE_S3_SECRET_ACCESS_KEY` and
`ARCHIVE_S3_SESSION_TOKEN` are never saved or printed; export them again for
every deployment, or a redeploy drops them. See
[fleet-helper inputs](configuration.md#optional-fleet-helper-inputs).

**Consolidated fleet with the Mercury workflow.** `npm run mercury:deploy`
copies the live variables and bindings and adds only the Mercury settings. It
refuses infrastructure changes, so a checkout containing this feature **cannot
run `mercury:deploy` until the migration is live**. It stops with "Durable
Object or storage bindings differ from production" or "Durable Object classes
differ from production", and with "cannot preserve a secret_text binding type"
if any live variable is a `secret_text` binding.

1. Apply the migration once through a reviewed private deployment with the
   fleet's `ctl.py`, using the staging layout of `celld/swamp/deploy.py`
   (`celld/native/`, a `node_modules` symlink, a `0600` `wrangler.json`). Start
   from the committed configuration and set `vars` to the **complete live
   variable set** (Mercury, Jev, wiki, retention) plus the management values.
   Supply `OIDC_CLIENT_SECRET` as an ordinary variable, not a `secret_text`
   binding, or later Mercury runs stop.

   ```sh
   python3 "$MAYFLY_FLEET_DIRECTORY/ctl.py" deploy <staging-dir> --json --dry-run
   python3 "$MAYFLY_FLEET_DIRECTORY/ctl.py" deploy <staging-dir> --json
   ```

2. `npm run mercury:preview` and `npm run mercury:deploy` then work again and
   preserve `MANAGEMENT`, `ARCHIVES` and the management variables.
3. Because Mercury copies live variables, it **cannot change** management
   settings. Enabling, disabling and allowlist changes each need another
   private deployment.

### Recommended order

1. **Infrastructure only:** deploy the binding, migration and `ARCHIVES` with
   `MANAGEMENT_ENABLED=0`. Chats and wikis still work; `/admin` returns 404
   "Management is disabled".
2. **Enable:** deploy `MANAGEMENT_ENABLED=1` with the OIDC values, then create
   one chat. A 503 here points to the defaults above.

## 6. First sign-in and verification

1. `GET /admin` shows "Sign in with an authorized administrator account."
2. **Sign in with OIDC** goes to `/admin/login`, which responds 302 to the
   provider with `scope=openid`, `code_challenge_method=S256` and
   `redirect_uri=<origin>/admin/callback`. The pending login is sealed in a
   five-minute, encrypted, per-browser login cookie; the server keeps no
   pending-login table, so many abandoned attempts can't lock admins out.
3. The provider redirects to `/admin/callback`, which responds 303 to `/admin`,
   sets the one-hour session cookie and clears the login cookie.
4. `/admin` shows the inventory, filters and **Sign out**.

Then check with disposable data:

- [ ] `GET /admin/api/session` shows the expected `issuer` and `subject`.
- [ ] The inventory contains only resources created after enabling.
- [ ] Create a chat and post a message. Within about 30 seconds it appears as
      `active`, with an idle deadline from `MANAGEMENT_CHAT_IDLE_SECONDS` (or
      `RETENTION_SECONDS`).
- [ ] **Archive now**. The panel polls while the job runs; the chat returns to
      `active` and **Backups** lists one entry.
- [ ] **Download full backup**; `tar -tf mayfly-chat-*.tar` lists
      `manifest.json` and `objects/0`, `objects/1`, ….
- [ ] Set **Idle TTL (seconds)** to `60`, check **Archive before automatic
      expiry**, save and wait. The chat moves through `expiring` to `deleted`,
      a new backup appears and the chat link stops working.
- [ ] **Restore** that backup. The chat is `active`, the policy shows
      **Paused**, and the original link shows the original message.
- [ ] **Recent management history** lists the actions with your identity.
- [ ] In a private window, sign in with an account that isn't allowlisted. The
      callback returns 403.
- [ ] **Delete** the chat, then **Sign out**.

Mayfly never deletes backups; test archives remain under
`r2/mayfly-archives/mayfly/v1/` until you or a lifecycle rule remove them.

## 7. Troubleshooting

Errors are JSON `{"error": "…"}` with the status shown.

| Symptom | Cause | Fix |
| --- | --- | --- |
| 404 "Management is disabled" | `MANAGEMENT_ENABLED` isn't exactly `1`, or the `MANAGEMENT` binding is missing. | Deploy the binding and migration; set the flag. |
| 503 "Admin OIDC is not configured" | `MANAGEMENT_ORIGIN` isn't an exact origin (path, trailing slash, `:443`, uppercase, HTTP on a non-loopback host); `OIDC_ISSUER` isn't HTTPS or has a query, fragment or credentials; `OIDC_CLIENT_ID` is empty; or `OIDC_ADMIN_SUBJECTS` isn't a non-empty JSON string array (e.g. bare `admin`, or escaped quotes in `.dev.vars`). | Correct the variable and redeploy. |
| 403 "Use the configured management origin" | Request origin differs from `MANAGEMENT_ORIGIN`: `localhost` vs `127.0.0.1`, another hostname, or a proxy without forwarded-origin trust. | Use the configured origin. Behind a trusted proxy, run celld with `--trust-forwarded-headers` and have the proxy replace `X-Forwarded-Host`/`-Proto` ([Operations](operations.md)). |
| 503 "Identity provider unavailable" | Discovery, token or JWKS request failed: unreachable, timeout (15 s), 5xx, redirect, body over 256 KiB or invalid JSON. | `curl <issuer>/.well-known/openid-configuration` from a node; fix egress or the issuer. |
| 503 "Provider must support OIDC and PKCE S256" | Discovery `issuer` isn't exactly `OIDC_ISSUER` (usually a trailing slash), or `S256` isn't listed. | Copy `issuer` verbatim; enable PKCE `S256`. |
| Provider page: redirect URI mismatch | Registered URI isn't `MANAGEMENT_ORIGIN/admin/callback`. | Register that exact URI. |
| Callback 400 "Invalid sign-in response" | No `code`/`state` (provider error, user not assigned, consent denied) or no login cookie (other browser, cookies blocked). | Check the provider; restart from `/admin` in one browser. |
| Callback 400 "Sign-in expired or did not match this browser" | Over five minutes, a reused callback URL, a different provider `iss`, or the issuer/client changed mid-sign-in. | Start again from `/admin`. |
| Callback 403 "OIDC sign-in failed or this identity is not an administrator" | Usually `sub` not allowlisted. Also: token endpoint rejected the exchange (wrong secret, provider expects `client_secret_post`, public client not allowed), wrong signing algorithm, `aud`/`azp`/`iss`/nonce mismatch, token over five minutes old or clock skew over 30 s. | Check the `sub`, then the client type, secret, auth method, algorithm and clock. |
| `/admin` shows the sign-in page again after signing in | The subject was removed, or `OIDC_ISSUER`/`OIDC_CLIENT_ID` changed. API calls return 403 "Admin access denied". | Sign in with an allowlisted account. |
| "Admin session expired" / "Admin sign-in required" (401) | Sessions last one hour; no refresh tokens. | Sign in again. |
| 403 "Invalid CSRF protection" on save, actions or sign-out | `Origin` isn't exactly `MANAGEMENT_ORIGIN`, `X-CSRF-Token` is missing or stale, or `Sec-Fetch-Site` is present and not `same-origin` (e.g. a proxy rewrote `Origin`). | Keep `Origin` intact. Scripts take `csrf` from `/admin/api/session` and send it with `Origin`. |
| Old chats never appear; 404 "Resource is not managed" | Only resources created after enabling are enrolled. | Expected. |
| Inventory lags activity or state | Writes don't wait for the catalog; the outbox updates it within about 30 s and retries on failure. | Wait or refresh; resource details are authoritative. |
| Creation 503 after enabling | "Invalid management TTL configuration", "Invalid archive default", "Invalid audit retention", "Management catalog is not configured" or "Archive storage is not configured". | Fix the defaults; deploy `MANAGEMENT` and `ARCHIVES`. |
| Archive actions 503 "Archive storage is not configured" | No `ARCHIVES`, or incomplete `ARCHIVE_STORAGE=s3`. | Deploy `ARCHIVES` and unset `ARCHIVE_STORAGE`, or complete `ARCHIVE_S3_*`. |
| Stuck in `expiring`/`archiving` with an error | Backup failing; live content is kept frozen. | Fix storage, then **Retry failed operation**, or **Cancel operation** to return to `active` with content intact ([details](management.md#retry-or-cancel-a-pending-operation)). |
| Stuck in `restoring` with an error | Archive objects missing or not matching their hashes. | Restore the bytes, then retry, or cancel to leave the resource `deleted`. |
| Stuck in `deleting · erase` with an error; no **Cancel operation** | Deletion has started and cannot be undone. | Fix the cause, then **Retry failed operation**. |
| Policy save 409 | Another admin changed it, or an operation is running. | Refresh and edit again. |
| No **Restore** button | Offered only for `deleted` resources with a backup. | Expected. |
| `mercury:deploy` stops on bindings, classes or `secret_text` | Migration not yet live, or a value deployed as a secret binding. | [Deploy privately](#5-deploy) first, with ordinary variables. |
| "celld dry-run failed; check fleet access and build dependencies" | `node_modules` missing in the deployment checkout. | `npm ci` there. |

## 8. Disable or roll back

Disabling stops enrollment and returns 404 for all of `/admin`. It does **not**
stop pending deletions or expiry: managed resources keep their policies and
pending jobs on their own alarms. To keep a resource, pause or clear its TTLs
while the UI is still available.

1. Deploy `MANAGEMENT_ENABLED=0` through the private path you used to enable it
   (Mercury can't change it).
2. Keep `MANAGEMENT`, the `v3-management` migration, `ARCHIVES` and any
   `ARCHIVE_S3_*` values. Pending jobs and archive-before-delete still use them;
   without archive storage, a resource reaching its deadline stays frozen in
   `expiring` and retries rather than being deleted.
3. The `OIDC_*` variables may be removed; they're read only while enabled.

To cut off one administrator, remove the subject and redeploy; their session
is refused on its next request. Re-enabling restores the panel and all
previously managed resources; resources created while disabled are never
enrolled.

Prefer the flag over a code rollback. This repository's deployment tooling
doesn't support redeploying a build without the `Management` class once the
migration is applied, and the Mercury adapter refuses it. Deleted managed IDs
stay reserved (HTTP 410) until restored; backups remain until an operator
removes them.
