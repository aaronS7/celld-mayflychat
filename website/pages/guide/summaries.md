---
title: Streaming AI summaries
description: Summarize a chat, a saved page or a bounded wiki overview with Mercury 2.5.
---

# Catch up with an AI summary

When your operator enables summaries, use **AI summary** in a chat header,
or **Summarize page** and **Summarize wiki** in a wiki header. Text appears as
Mercury generates it, with a subtle animation that respects reduced-motion
preferences. Search stays in its usual place.

The summary opens in a dialog with **Stop**, **Regenerate** and **Copy**.
Closing the dialog also stops generation. The result stays separate from your
messages and pages: it is not posted or saved automatically.

## Know what was included

A chat summary covers up to the latest 200 events. A page summary uses saved
text, including the historical revision if you have one open. Save an edit
before summarizing it.

A whole-wiki summary is a **bounded overview**. It considers up to 60 pages,
starting with top-level pages and then ordering by path, and uses the beginning
of each page. A shared input limit can reduce coverage further. Comments, attachment contents
and linked chats are not included.

The coverage line shows included and total counts and marks excerpts. Open
**Sources** to visit the exact saved page revisions or chat messages. A wiki
with thousands of pages is never silently presented as fully summarized.

If generation stops or fails, the dialog keeps the partial text and labels it
incomplete. You can retry or copy what arrived. Check important details against
the sources; a generated summary can miss context or make mistakes.

<DemoImage name="summary" :width="1440" :height="1040" alt="A completed wiki overview in Mayfly's AI summary dialog, with excerpt coverage, source revisions, Regenerate and Copy controls." caption="The real application with synthetic pages and deterministic output from a local provider fixture. This shows the completed dialog, not live Mercury model output." />

<details>
<summary>See the mobile summary dialog</summary>
<DemoImage name="summary-mobile" :width="390" :height="844" alt="The same summary on a 390-pixel mobile screen, with readable coverage, source links and completion controls." caption="A mobile viewport of the same local fixture. Both captures follow your light or dark theme." />
</details>

## Enable Mercury

Summaries default off and are independent of Jev search, moderation and tagging.
Set these values in local `.dev.vars` or private Worker deployment bindings:

```dotenv
AI_SUMMARY_ENABLED=1
MERCURY_BASE_URL=https://api.inceptionlabs.ai/v1
MERCURY_API_KEY=your-provider-key
MERCURY_MODEL=mercury-2.5
```

Use your provider's base URL, including `/v1` where needed, without the
`/chat/completions` suffix. Keep the API key private. Binding changes require a
deployment; exporting variables on a running daemon is insufficient.

Selected text is sent to the configured provider only when someone requests
a summary. Encrypted chats cannot use this feature. The key stays on the
server. See [privacy](privacy.md) and the
[configuration reference](../reference/configuration.md).

## Deploy with a swamp vault

On the existing consolidated deployment VM, the checkout provides an interactive
swamp vault setup and workflow:

```sh
npm run mercury:setup
npm run mercury:preview
npm run mercury:deploy
```

The setup hides API-key entry and saves the URL, model and key in a local
encrypted vault. Preview only builds and checks. Deploy resolves current vault
values and enables summaries while preserving existing production settings.
See the [deployment instructions](../reference/mercury-deployment.md)
for prerequisites and rotation. No credentials belong in the documentation site.

## Use from an agent

Agents can stream the same summaries using the resource's existing bearer:

| Request | Scope |
| --- | --- |
| `POST /c/ID/summary` | Chat |
| `POST /w/ID/pages/PAGE_ID/summary` | Page, with optional `?revision=N` |
| `POST /w/ID/summary` | Bounded wiki overview |

The response is a sequence of `meta`, `delta`, and `done` server-sent events.
Use the metadata to report coverage and source revisions. An `error` event or
an early end means the text is incomplete. Aborting the request stops generation.
The [API reference](../reference/summaries.md) documents authentication, limits,
errors and a Node example.
