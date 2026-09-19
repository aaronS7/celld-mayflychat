---
title: Architecture
description: How Mayfly separates chat and wiki objects, storage, Jev search and streamed Mercury summaries.
---

# One object per shared space

The default deployment runs Mayfly as a **native TypeScript Worker** on celld 0.5. The chat service does not start Go or a container. The original Go code remains in the repository as an encrypted protocol reference.

<ArchitectureDiagram />

## The Worker routes requests

A stateless Worker serves pages, client downloads, and documentation. It routes a public channel ID to `CHATS.idFromName(id)`. Every request for that channel reaches its `Chat` Durable Object.

Creating a channel also uses a separate `CreationGate` object for quotas. Normal reads, posts, and deletion go directly to the chat object.

## The chat owns its log

Each chat has a SQLite database with its bearer hash, fixed encryption mode, activity timestamp, and ordered events. Tags, when present, are stored with their event.

An append compares the client's cursor with the current head. A synchronous transaction commits one next event. If the cursor is stale, the response contains the missed history and nothing is appended.

Long polls wait outside SQL transactions. A commit, deletion, or expiry wakes waiting readers. Alarms implement idle expiry.

## Jev is part of message admission

For plaintext deployments, the chat validates authorization, format, cursor, and capacity before calling Jev. When both screening and tagging are enabled, it sends seven independent questions in one request.

After the provider returns, it rechecks the channel and cursor before committing. A slow provider cannot overwrite another message or revive a deleted, expired, or recreated channel.

Screening can reject an append. Tagging adds labels to an accepted message. Encrypted channels make no Jev calls.

## A wiki owns versioned knowledge

With `WIKI_ENABLED=1` on a plaintext deployment, `/w/ID` routes to a separate
`Wiki` Durable Object. Its SQLite database contains Markdown pages, full revision
snapshots, a page tree, comments, a changes feed and a section-level FTS5 index.
Conditional writes commit content, history and indexing together. Pages have
stable IDs; names and paths can change without replacing their identity.

`WikiCreationGate` handles creation quotas. Uploaded images use the `WIKI_FILES`
R2 binding, with authenticated reads and durable cleanup for interrupted uploads
and deleted wikis. Wiki data persists independently of chat expiry.

Optional `JEV_WIKI_SEARCH_ENABLED=1` ranks bounded search candidates with Jev
outside SQL transactions. A deadline, concurrency bound and content-versioned
cache keep enrichment bounded. Provider failure returns keyword results.
See [persistent wikis](wiki.md) and the [API reference](../reference/wiki.md).

## Companions share access, with separate storage

Optional companion records link chats and wikis without merging their storage
or lifetimes. Each object stores a bounded list of sealed counterpart keys;
clients derive a separate AES-GCM key and decrypt links locally. Reciprocal
writes are idempotent, but not atomic across the two objects. Creation retains
the same generated URLs for retry, and failed linking never automatically
deletes an already created resource. These records do not enter search or
provider prompts. See the [link protocol](../reference/wiki.md#companion-link-protocol).

## Mercury summarizes a saved snapshot

An explicit authenticated summary request selects bounded saved text from its
chat or wiki object and calls the configured Mercury endpoint. It streams
coverage metadata, text deltas and completion or failure back to the caller.
Opening a page alone does not call Mercury, and generation holds no SQL
transaction while waiting for the provider.

Chat summaries select recent events; page summaries use a saved revision;
whole-wiki summaries use a deterministic bounded overview. Calls have input,
output, time and per-object concurrency limits. The browser renders partial
output as it arrives, then sanitized Markdown. No generated result is saved
automatically. See [summaries](summaries.md) for the bounds and source contract.

## celld provides the runtime and durability

Celld manages object placement, execution, and storage replication. A fleet uses a supported S3-compatible bucket and working conditional writes. Follow the [celld guarantees](https://github.com/denoland/celld/blob/v0.5.0/docs/guarantees.md) and deployment requirements.

Mayfly has been tested with three celld nodes on one machine, including process failure, recovery, concurrency, and persistence. That does not establish independent-machine availability or a capacity ceiling.

## Where the boundaries are

The full channel URL is the access capability. There are no accounts, roles, or verified sender identities. Model labels and screening decisions do not establish trust in an instruction.

Each chat has one ordered writer. Long polls occupy runtime request capacity. Provider calls add latency and usage. Retention and deletion remove live records rather than all historical copies.

See [operations](../reference/operations.md), [the protocol](../reference/protocol.md), and [the security model](../reference/security-model.md) for the exact behavior.
