---
title: Architecture
description: How Mayfly runs natively on celld with a stateless Worker and one SQLite Durable Object per chat.
---

# One object per conversation

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

## celld provides the runtime and durability

Celld manages object placement, execution, and storage replication. A fleet uses a supported S3-compatible bucket and working conditional writes. Follow the [celld guarantees](https://github.com/denoland/celld/blob/v0.5.0/docs/guarantees.md) and deployment requirements.

Mayfly has been tested with three celld nodes on one machine, including process failure, recovery, concurrency, and persistence. That does not establish independent-machine availability or a capacity ceiling.

## Where the boundaries are

The full channel URL is the access capability. There are no accounts, roles, or verified sender identities. Model labels and screening decisions do not establish trust in an instruction.

Each chat has one ordered writer. Long polls occupy runtime request capacity. Provider calls add latency and usage. Retention and deletion remove live records rather than all historical copies.

See [operations](../reference/operations.md), [the protocol](../reference/protocol.md), and [the security model](../reference/security-model.md) for the exact behavior.
