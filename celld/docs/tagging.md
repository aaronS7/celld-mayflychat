# Automatic Jev tags

Set the Worker binding `JEV_TAGGING_ENABLED=1` to classify new plaintext messages
with TypeSafe Jev. It defaults to `0` and is independent of `JEV_ENABLED`, which
controls moderation. Both features use `TYPESAFE_API_KEY` and `TYPESAFE_MODEL`.
`ENCRYPTION_ENABLED=1` always disables both features and all provider calls.
Use literal `0` or `1`; invalid tagging values cause HTTP 503
`configuration_error` when encryption is off.

For local development, add the flag to `.dev.vars`. For this repository's fleet
helper, after supplying the key in ignored `typesafe.celld.env`, run:

```sh
ENCRYPTION_ENABLED=0 JEV_ENABLED=1 JEV_TAGGING_ENABLED=1 npm run fleet:deploy
```

The helper retains this selection on later deployments. Use
`JEV_TAGGING_ENABLED=0 npm run fleet:deploy` to disable tagging. Other fleets
should set private Worker bindings through their deployment configuration; a
daemon environment variable alone does not change the Worker. See
[configuration](configuration.md) for precedence and credential storage.

## Labels and thresholds

Jev answers five independent [Noul questions](https://docs.typesafe.ai/primitives/noul).
Each result is the probability that a label applies, from 0 to 1, rather than
TypeSafe's separate Choice/Score confidence statistic. Multiple labels may qualify.

| Label | Meaning | Required probability |
| --- | --- | --- |
| `research` | Requests or presents investigation, evidence, experiments, or analysis | At least 0.75 |
| `question` | Seeks an answer, explanation, or clarification | At least 0.75 |
| `information` | Shares substantive facts, findings, an explanation, or a status update | At least 0.75 |
| `command` | Instructs or requests an action, including chat commands | At least 0.75 |
| `undetermined` | Intent is unclear or outside the other four categories | At least 0.60, with **every** other probability strictly below 0.30 |

A value of exactly 0.75 qualifies for a main label; exactly 0.60 qualifies for
`undetermined` only if the other four values are all below 0.30. Exactly 0.30
prevents `undetermined`. If no rule matches, the message has no tags.
`undetermined` never coexists with another tag. Labels have a fixed order:
research, question, information, command, undetermined.

## Delivery and persistence

Tags are server-generated metadata on accepted messages, shown as small labels
in the browser and preserved by the served Node/Python/Go clients. For example:

```json
{"id":0,"ts":"2026-09-17T12:00:00Z","src":"","from":"Alice","text":"Please investigate this question.","tags":["research","question","command"]}
```

Raw read events use `seq` instead of `id` and also contain `nonce`. A successful
post acknowledgment includes that message's optional `tags` as well. When no
label qualifies, `tags` is omitted, not replaced with `undetermined`. No tagging
probabilities or moderation diagnostics are added to HTTP responses. Existing
clients can ignore the additive field; the protocol remains version 2.

Clients still submit exactly `{nonce,from,text}` in plaintext mode. Supplying
`tags` or other extra fields is rejected; callers cannot choose their own labels.
Tags never execute commands or change message contents. Title/reaction events
are classified too, but the browser continues to fold them into its title or
reaction display instead of showing a separate message row.

Labels are stored with the event in the chat's SQLite Durable Object and survive
restarts. Existing databases gain a nullable tags column on access; old messages
stay untagged. Enabling tagging or changing models affects future posts only.
Disabling tagging preserves historical labels. Deletion and expiry remove tags
alongside their message, subject to the usual backup/replica limitations.
Message byte limits still count the normalized `{from,text}` payload; bounded tag
metadata is separate. `/config` and authenticated `/c/ID/config` expose a
`tagging` boolean, which describes policy rather than provider readiness.

## Failures, privacy, and moderation

Tagging sends the actual sender name and message text to TypeSafe, even when
moderation is off. It sends no chat history or additional channel identifiers,
bearers, encryption keys, or participant IPs. Anything embedded in the name/text
itself is still sent. The page's privacy notice reflects tagging.

When both features are enabled, one provider request contains all seven
questions. The existing moderation threshold remains 0.70 for either attack
category. A rejection stores no message or tags, and its HTTP response remains
generic. Moderation failures still refuse the message with HTTP 503.

Tagging is optional enrichment: missing credentials, provider errors, a
ten-second deadline, or invalid tag answers leave the message untagged if
moderation is off or has returned a valid allowing decision. All five tag
answers must be valid before any label is used. This emits a fixed
`tagging_unavailable` operator warning with timestamp and provider, without
message text, identifiers, secrets, or provider diagnostics. A valid response
with no qualifying label emits no failure warning.

Classification adds latency and API usage, and model output can be wrong.
There is no provider-call rate or spending limiter. Combined questions can
change model output relative to moderation alone; use a supported fixed model
and evaluate representative messages when consistency matters. Tags describe
intent, not trust or authorization; `command` does not mean safe to execute.
