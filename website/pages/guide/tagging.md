---
title: Automatic tags
description: Label messages with research, question, information, command, or undetermined, using precise probability thresholds.
---

# Give messages a little context

Optional Jev tagging labels the intent of each new plaintext message. Labels appear beneath the message in the browser and in API and CLI output. Several labels can apply to one message.

## Try the rules

Move the sliders to explore the exact thresholds. This is a local illustration of the rules; it does not contact Jev or classify any text.

<TagExplorer />

| Label | Required probability |
| --- | --- |
| `research` | At least 75% |
| `question` | At least 75% |
| `information` | At least 75% |
| `command` | At least 75% |
| `undetermined` | At least 60%, with **every other label below 30%** |

Exactly 30% prevents `undetermined`. Exactly 75% qualifies for a main label. If no rule matches, there is no tag. `undetermined` never accompanies another label.

## Enable automatic tags

Set the Worker bindings in `.dev.vars` for local development:

```dotenv
ENCRYPTION_ENABLED=0
JEV_TAGGING_ENABLED=1
TYPESAFE_API_KEY=your-api-key
```

`JEV_TAGGING_ENABLED` defaults to `0`. It works independently of `JEV_ENABLED`, which controls screening. For fleet configuration, see [environment variables](../reference/configuration.md).

Enabling tagging sends sender names and message text to TypeSafe, even when moderation is off. Enabling encryption disables tagging entirely.

## Stored with the conversation

<DemoImage name="chat" alt="Messages with research, question, command, and information labels shown beneath their text." caption="Server-generated labels in the Mayfly UI. A message can carry several tags." />

Tags are stored with the accepted event in the chat's SQLite Durable Object. They survive restarts and remain readable after tagging is switched off. Existing messages are not retagged.

Clients submit only the message envelope. Sending a `tags` field is rejected; labels come from the server. Untagged messages omit the field entirely.

## If classification fails

Tagging is optional enrichment. Missing credentials, invalid tagging answers, provider failures, and timeouts leave messages untagged if moderation is off or has returned a valid allowing decision. Enabled moderation still fails closed.

A tagging failure emits a `tagging_unavailable` warning without contents or credentials. Successful assignments are stored in message metadata; they do not produce a separate success log.

These are model predictions about intent. A `command` tag does not make an instruction safe or authorized. Read the [complete tagging reference](../reference/tagging.md) for definitions, provider behavior, and protocol details.
