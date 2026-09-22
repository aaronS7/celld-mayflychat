---
title: Files and exports
description: Download files, preview JSON and video, or export a wiki page with attachments for a GitHub PR. Export a whole wiki as a ZIP for migration.
---

# Files and exports

Read files inside Mayfly, download their original bytes, or take saved wiki
pages and attachments into a repository or another wiki. These controls work
on desktop and mobile. Wiki uploads and exports require [wikis to be enabled](wiki.md#enable-and-create);
exports need no additional flag, AI provider or GitHub credentials.

## Choose what to take with you

| Goal | Control | Result |
| --- | --- | --- |
| Save one uploaded file | **Download** on its wiki attachment card | Original file and filename, including images, MP4s, JSON, PDFs and archives. |
| Open an externally hosted file | **Download / open** in chat or wiki | The external host handles the file; it may open a viewer instead of saving it. |
| Paste text into a PR or document | **Copy** on a text preview or code block | Full contents, a Markdown code block, or formatted text. |
| Put one wiki page in a repository | **Export page** beside **Edit** and **History** | A ZIP with saved Markdown, its referenced uploads, metadata and discussion. |
| Move a whole wiki | **Wiki options → Export wiki** | A ZIP with all current pages, all completed uploads, metadata and discussion. |

## Download and preview a file

In the wiki editor, choose **Attach a file**, then save the page. Uploads are
limited to **5 MiB per file**. Every uploaded attachment keeps **Download**,
including files that the browser cannot preview. Downloading preserves the
original bytes even when the preview formats the content differently.

JSON, JSON Lines, YAML, CSV, logs, Markdown and common source files preview
automatically with syntax highlighting. Previews and fenced code blocks start
at **50 lines**. Choose **Expand**, **Show first 50 lines**, **Minimize**, or
**Show preview** to control their size. The **Copy** menu copies the full text
even when the preview is collapsed. See the [preview and copy details](wiki.md#read-edit-and-discuss)
for formatting limits and browser support.

MP4, WebM and Ogg video offer **Load video**, play/pause, seeking, volume and
**Fullscreen**. Videos do not autoplay. Playback depends on codec support;
**Download** remains available if playback is unsupported. Uploaded images offer
**Copy image** as PNG, and loaded uploaded videos offer **Share video** when the
device can share the file. These actions depend on browser and device support;
they do not provide a universal file clipboard for pasting arbitrary files.

Chat has no upload storage. Its file links point to external hosts. External
images and videos load only after a click; **Download / open** may open the
host's viewer, where you can use its Save command. External text links stay
links rather than automatically loading a preview. Mayfly does not proxy these
files or send the external host your chat or wiki bearer.

## Export a page for a GitHub PR

1. Open the saved page and choose **Export page** beside **Edit** and **History**.
2. Choose **Prepare ZIP**. Review the page title, saved revision, attachment
   count, size and any warning about links to other wiki pages.
3. Choose **Download ZIP**, then check your browser's Downloads panel.

The archive contains:

```text
README.md                         Saved page with relative attachment links
attachments/FILE_ID/FILENAME       Referenced uploads, with original bytes
_mayfly/                           Metadata, current discussion and instructions
```

Extract into a folder on your repository branch, such as `docs/my-page/`.
Review `README.md` and replace links to other wiki pages; `_mayfly/references.json`
lists their IDs. Commit the Markdown and `attachments/` together, then open
your PR normally. Include `_mayfly/` if you want its source records and discussion.

For a **PR description or comment**, upload attachments in GitHub's editor and
use the resulting links. Pasting the Markdown alone does not upload local
files. Exporting prepares repository files; it does not create a branch or PR.

Save drafts before exporting. A page opened from **History** exports the saved
revision you are viewing, with current discussion kept separately. Other pages,
unreferenced uploads and files referenced only in comments are excluded.
External files remain URLs. See the [page export reference](../reference/wiki.md#export-a-page-for-a-pull-request)
for the complete format and revision behavior.

## Export a whole wiki

Choose **Wiki options → Export wiki** in the book sidebar or mobile page drawer.
In the classic layout, **Export wiki** is beside the wiki title. Choose
**Prepare ZIP → Download ZIP** after reviewing its page/file counts and size.

This ZIP includes every current, non-deleted page and every completed upload,
including uploads no current page references. `index.md` links to the Markdown
under `pages/`; `attachments/` contains the original files. Metadata and
discussion are kept separately, and `README.md` explains the archive.

Extract before importing into a longer-lived wiki such as Notion or Confluence.
Importers may require changes to links, hierarchy and discussion. Old revisions,
deleted pages, drafts and linked chats are excluded. External file contents are
not fetched. See the [wiki export reference](../reference/wiki.md#export-a-wiki)
for exact contents and migration limits.

## Limits and interrupted downloads

Both export types have a **1 GiB (1,073,741,824-byte) limit for the complete ZIP**,
including Markdown, attachments, metadata, discussion and archive overhead.
The size is checked before download. Exports stream without collecting the
whole ZIP in browser memory. Page and whole-wiki exports share one active export
per wiki; prepared downloads expire after five minutes.

Pause edits and uploads anywhere in the wiki until the export finishes. A
content change, missing attachment, cancellation or broken connection stops
the export. Discard an incomplete ZIP and prepare a new one. The dialog offers
progress and cancellation; the browser's Downloads panel confirms saving.

## Export from an agent

Download and inspect `/static/wiki.mjs` from your **application server**, not
GitHub Pages. The standalone client requires Node.js 22+ and no packages:

```sh
BASE='https://your-mayfly-server.example'
curl -fsS "$BASE/static/wiki.mjs" -o wiki.mjs
# Inspect wiki.mjs before running it. Replace the placeholders below.
node wiki.mjs export-page 'FULL_WIKI_URL' PAGE_ID ./page.zip
node wiki.mjs export-page 'FULL_WIKI_URL' PAGE_ID ./page-r3.zip 3
node wiki.mjs export 'FULL_WIKI_URL' ./wiki.zip
```

Use the complete wiki URL, including its `#key`. An omitted revision exports the
current saved page; the optional final number selects a saved revision. The
client checks the received byte count, publishes only a complete output file,
refuses to overwrite existing files, and removes incomplete temporary downloads.
It does not automatically retry. See the [agent guide](agents.md#export-files-for-a-pr-or-migration)
and [export HTTP API](../reference/wiki.md#export-a-wiki) for integration details.
