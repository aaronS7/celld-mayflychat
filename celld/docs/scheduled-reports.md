# Scheduled Mayfly reports

Reporting is opt-in with `REPORTS_ENABLED=1`. It automatically prepares report
emails and is configured separately from the [on-demand Mercury buttons](summaries.md).
Reports do not inherit Mercury or Jev provider settings. Use private Worker
bindings and explicitly configure the recipient before enabling this feature.

## Configuration and prerequisites

| Binding | Default and behavior |
| --- | --- |
| `REPORTS_ENABLED` | Off unless exactly `1`. Enables scheduled reports and queued-mail delivery. |
| `REPORT_CONTENT` | On when reporting is enabled unless exactly `0`. `0` uses metadata-only reports without sampled-content provider calls. Unset, blank or `false` do not disable content. |
| `OWNER_EMAIL` | No portable default. Set an explicit permitted recipient. The implementation's automatic owner lookup is deployment-specific and is not a supported setup step. |
| `REPORT_ADMIN_TOKEN` | Unset. A separate private bearer for the administrator routes below; without it they return 401. It is not required for scheduled execution itself. |
| `REPORT_SUMMARY_URL` | Unset. Full HTTPS Chat Completions endpoint, including `/chat/completions`; no path is appended. Required when sampled plaintext is summarized. |
| `REPORT_SUMMARY_MODEL` | Unset. Required for content summaries; no Mercury or Jev default is supplied. |
| `REPORT_SUMMARY_KEY` | Unset. Optional Bearer credential; supply it if the report provider requires authentication. No fallback to other provider keys. |

The mail transport targets the documented [exe.dev email service](https://exe.dev/docs/send-email.md),
which requires an exe.dev VM and an eligible recipient. This is not a generic
celld email facility; hosting elsewhere requires adapting the transport. No
mail is sent by the documentation site. Use literal `0` and `1` for policy
choices; the reporting code uses literal comparisons rather than the strict
validation used for wiki and on-demand summary flags.

## Scheduling and coverage

The `CreationGate` Durable Object holds a creation journal, report windows and an email outbox. Creation intents are persisted before the cross-object call; per-chat creation receipts allow recovery without creating/counting a chat twice or resurrecting deleted/expired content. The journal counts creations even after deletion. Ordinary message traffic still goes directly to the Chat object. Slow model and email calls release the creation queue.

* The gate's alarm prepares an hourly digest of chats **created in that hour** and their plaintext messages before the interval end. Quiet hours produce no email. The digest samples the first 40 new chats and up to six messages per chat, with sender names clipped to 80 and text to 500 JavaScript string code units. It discloses sampling. This is not a transcript archive or a summary of activity in all older chats.
* The Worker's `scheduled()` handler and `triggers.crons = ["0 */12 * * *"]` prepare creation-count emails for 00:00 and 12:00 UTC boundaries, including zero. Actual delivery may be delayed by retries. Windows are half-open and checkpointed. Duplicate cron calls cannot enqueue the same period twice. Delayed calls catch up persisted windows; the first interval starts at activation and may be partial.
* Existing per-chat alarms still enforce chat retention. Chats already deleted or expired when sampled contribute counts but no content. Encrypted chats contribute metadata only; their ciphertext and keys never enter the summary-provider request.

## Privacy and retention

With content reporting enabled, the server automatically sends sampled names
and plaintext to the report provider and emails the digest. A participant does
not need to press a summary button. Provider and mailbox copies can outlive
chat expiry or deletion. `REPORT_CONTENT=0` stops future content sampling and
summarization; it does not erase already prepared or queued email bodies.

Pending outbox bodies survive retries. During later delivery processing, bodies
whose transport acceptance was recorded more than seven days earlier are cleared;
this is not a guaranteed seven-day expiry timer. Receipt metadata and subjects
remain. Disabling reports pauses delivery and this cleanup without deleting the
queue. Creation journal rows are removed after both reporting checkpoints pass
them. Opaque per-chat creation receipts remain to make recovery safe.

## Administrator API

Use the report administrator token as `Authorization: Bearer ...` for:

* `GET /api/reports` — persisted windows and delivery receipts.
* `POST /api/reports/start` — idempotently initialize report windows and schedule work; initialization also happens on the first new chat or scheduled cron request.
* `POST /api/reports/test-email` — queue a labeled test using the native alarm/outbox; HTTP 202 is not delivery confirmation. Requests in the same calendar minute are deduplicated, without advancing regular windows.

The internal `/_report` path is a binding-only route and is never forwarded by public ingress. The token and raw email bodies are never returned by the status endpoint. Email delivery is at least once; ambiguous acceptance followed by a crash can duplicate a message.

## Verification

`node --test celld/reports.test.mjs` exercises report windows, counts and encrypted
text exclusion with local in-memory fixtures. It does not establish live email
delivery, provider permissions or shared-fleet crash recovery. Existing moderation,
encryption, tagging, client and long-poll tests remain relevant to the chat paths.
