---
title: Jev screening
description: Screen plaintext messages for prompt injection and data exfiltration before delivery.
---

# Screen messages before delivery

Optional TypeSafe Jev screening evaluates the actual sender name and message text before an append. It asks independent questions about **prompt injection** and **data exfiltration**.

If either attack probability is **at least 70%**, the message is rejected. It does not enter history, advance the cursor, refresh expiry, or wake readers.

## Enable screening

For local development, set these Worker bindings in `.dev.vars`:

```dotenv
ENCRYPTION_ENABLED=0
JEV_ENABLED=1
TYPESAFE_API_KEY=your-api-key
```

For a fleet, use private deployment bindings and deploy the change. The optional repository fleet helper can load the credential from the ignored `typesafe.celld.env` file. See [configuration and precedence](../reference/configuration.md).

`JEV_TAGGING_ENABLED=1` can enable tags alongside screening. Both features share one provider request. Encryption always disables both.

## What the sender sees

<DemoImage name="screening" alt="Mayfly preserves a refused message in the composer and displays the generic Jev rejection notice." caption="A deterministic screening example in a disposable local chat. Rejected text is not delivered to readers." />

A scored refusal returns:

```json
{
  "error": "Message rejected by Jev screening.",
  "code": "moderation_rejected",
  "posted": false
}
```

The HTTP status is **422**. A missing key, provider error, malformed screening result, or ten-second deadline returns **503** with `moderation_unavailable` and `posted:false`. Enabled moderation fails closed.

## What the operator sees

The celld node log records the rejection category, probabilities, and threshold. For example, with illustrative scores:

```json
{
  "event": "moderation_rejected",
  "timestamp": "2026-09-17T12:00:00.000Z",
  "provider": "typesafe",
  "blockedBy": ["prompt_injection"],
  "probabilities": {
    "prompt_injection": 0.95,
    "data_exfiltration": 0.10
  },
  "threshold": 0.7
}
```

Those categories and scores are excluded from HTTP responses. Application rejection logs also omit message contents, sender names, channel IDs, keys, and raw provider diagnostics. Use `npm run dev -- --logs` to show warnings locally.

## Know what the check means

Jev evaluates individual messages, without chat history. Its [Noul values](https://docs.typesafe.ai/primitives/noul) are probabilities of “yes,” not a guarantee that accepted content is safe. A model can miss attacks or reject legitimate discussion.

There is no application rate or spending limiter for provider calls. Rejected and concurrent proposals can still consume usage. `/config` reports the selected policy, not provider readiness.

For exact payload handling, timeout behavior, and private key storage, see the [Jev reference](../reference/jev.md).
