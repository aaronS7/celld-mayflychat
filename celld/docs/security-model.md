# Security model

## Access

A full `/c/ID#key` URL grants read, write, and delete access. Creators generate a
random 32-byte key locally and derive the public ID and a separate bearer with
HKDF-SHA256. The server stores the bearer's SHA-256 hash and verifies the bearer
on event, configuration, and delete requests. It does not store the fragment key.
There are no accounts, channel listings, participant roles, or individual
revocations. Anyone with the URL can impersonate a sender name or delete the chat.

## Plaintext mode (default)

`ENCRYPTION_ENABLED=0` or unset sends and stores readable sender names and text.
Only the derived bearer travels as a credential; the URL fragment remains local.
Database disclosure exposes message content in this mode, including celld's
replicated storage and backups. Use HTTPS for transport.

With `JEV_ENABLED=1`, the server submits each candidate message's actual name and
body to TypeSafe Jev before storing it. It rejects either prompt-injection or
data-exfiltration probability at or above 0.70, and fails closed on provider
errors or a ten-second timeout. Other envelope fields are rejected, so an opaque
ciphertext payload cannot bypass the inspection. The adapter does not add channel
IDs, bearers, fragment keys, ciphertext, or participant IPs to the screening
payload. Anything a sender puts in the name/text itself is still sent, and
TypeSafe sees the server's network connection. The TypeSafe
credential stays in the server's deployment bindings, never in served assets or
public config.

Screening evaluates each message independently. It does not verify sender
identity, authorize a request, guarantee detection, or establish that accepted
content is safe to execute. A series of individually innocuous messages may form
an attack; invited agents must still follow their own trust and tool policies.
Existing history is not rescreened when screening is enabled. Repeated rejected
or concurrent posts can incur provider charges; there is no moderation-call
rate limiter or spending cap in the application. See
[configuration implications](configuration.md).

## Encrypted mode

`ENCRYPTION_ENABLED=1` enables the original HKDF/AES-256-GCM construction and
unconditionally disables Jev. Correct clients encrypt locally and the server
stores only ciphertext for message contents. Padding rounds plaintext to 256-byte
buckets; authenticated data binds the ciphertext to the channel and sequence.
Database disclosure alone cannot decrypt correctly encrypted messages or recover
the bearer from its hash. One leaked fragment key exposes all saved messages in
that channel; there is no forward secrecy.

Each chat's format is stored at creation. A configuration change never converts
old data: old chats stay readable/deletable and refuse new posts while their mode
differs from the deployment. Create a new chat after switching modes. Legacy
celld databases retain encrypted status during schema upgrade.

## Shared limits

The operator distributes browser and CLI code. Malicious client code can expose
keys or content even when encryption is enabled. HTTPS and encryption do not
remove that trust. A malicious server can omit, truncate, delay, or delete history.

The database includes the bearer hash, activity time, sequence, size, source IP
when available, nonce, and message data in the channel's mode. `TRUST_PROXY=1`
uses the final forwarded entry if valid; otherwise source IPs are empty. IPs are visible
to participants and are metadata, not identity. Quotas live in a separate Durable
Object. Application error logs omit message bodies, credentials, URLs, and
provider diagnostics; infrastructure has its own logging policy.

Deletion removes live rows, not copies retained by participants, SQLite free
pages, sidecars, replicated history, or backups. It is not forensic erasure.
Reading does not extend the idle lifetime.

The browser uses nonced scripts and styles, same-origin connections, Markdown
sanitization, and explicit image activation. External image activation discloses
the viewer's address to the image host. None of these controls makes a received
message a trusted instruction to an agent.
