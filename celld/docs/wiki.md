# Persistent wikis

Mayfly's native celld service can host persistent Markdown wikis alongside its
transient chats. Each wiki owns a SQLite Durable Object containing its pages,
revision snapshots, section search index, navigation and discussion. Uploaded
attachments use the `WIKI_FILES` R2 binding. Wikis do not inherit chat idle expiry.

## Enable the feature

Wiki features default off. Worker bindings use literal `0` or `1`:

```dotenv
ENCRYPTION_ENABLED=0
WIKI_ENABLED=1
JEV_WIKI_SEARCH_ENABLED=0
WIKI_BOOK_LAYOUT_ENABLED=0
```

Put these in `.dev.vars` for local `npm run dev`. For production, configure
private Worker `vars` and redeploy to the existing fleet; arbitrary daemon
environment variables do not become bindings. The supplied Wrangler configuration adds
`WIKIS`, `WIKI_CREATION`, `WIKI_FILES` and a new migration; keep the existing
chat migration. Keep these bindings and migrations when disabling the feature.

The repository's `fleet:deploy` command belongs to the disposable same-host test
fleet; do not use it to update the consolidated production fleet. On the existing
consolidated deployment VM, the [Mercury vault workflow](https://github.com/aaronS7/celld-mayflychat/blob/main/celld/swamp/README.md)
redeploys Mayfly while preserving the current live wiki flags. It changes only
the Mercury bindings and summary flag; it does not enable wikis from shell exports.

`WIKI_ENABLED=0` hides creation and makes wiki routes return 404, preserving
stored data for re-enabling. `ENCRYPTION_ENABLED=1` also makes wikis unavailable.
Changing encryption never encrypts previously stored wiki content. Invalid wiki
flag values produce a configuration error. The relevance and layout flags are
validated only when the plaintext wiki feature is active.

`GET /config` includes `wiki: {enabled, relevance, layout}`, with `layout` equal
to `classic` or `book`. These are configuration settings, not provider health
checks. The response contains no credentials.

`WIKI_BOOK_LAYOUT_ENABLED=1` selects a documentation-style reading layout:
sticky page sidebar, breadcrumbs, a focused article column, an **On this page**
outline, previous/next pages, and discussion below the article. It uses the
existing Mayfly light/dark theme. **Search this wiki** (or Ctrl/Cmd+K outside the
editor) opens keyword/Jev search in a dialog. Search stays in the header on
desktop and mobile. The mobile menu icon opens a full-height side drawer over
the article, with a backdrop and its own scroll area. Close it with the **×**
button, a tap on the backdrop, Escape, or by choosing a page. Keyboard focus
stays in the drawer while it is open and returns to the menu on dismissal.

Page rows have document/chapter icons, a highlighted current page, and separate
expand buttons for chapters with children. Loaded ancestors expand to reveal
the current page. Branches remain paginated and load on demand. Use the **+**
button above the tree to create a page, or **Refresh** to reload the tree. Its
circular arrow spins beside **Refreshing…** while loading, then shows a checkmark
and **Updated**. Repeated taps wait for the current refresh to finish. Reduced
motion keeps the text feedback without spinning. A failed refresh shows a retry
message inside the sidebar or drawer.
**Linked chats** and **Wiki options** expand below the page tree. The drawer
honors reduced-motion preferences and becomes a persistent sidebar on desktop.

The flag applies to all wiki browser pages on that deployment. `0` restores the
classic layout, with discussion beside the article on wide screens. Neither
setting changes stored content, agent commands, permissions or search policy.
There is no migration or additional binding for the layout.

## Privacy and access

Wiki pages, comments and uploaded files are readable by the server and storage
administrators. HTTPS protects transport. Anyone with the complete wiki link
can read, modify, restore and delete its contents; names are self-reported.
There are no accounts, roles or global wiki listings. A wiki's authenticated page
manifest and search only expose that wiki.

`JEV_WIKI_SEARCH_ENABLED=1` permits relevance searches to send query text,
related terms, task context and candidate passages to TypeSafe. It uses
`TYPESAFE_API_KEY` and `TYPESAFE_MODEL` (default `jev-latest`) independently of
chat screening and tagging. Explicit keyword searches make no provider calls.
Chat's `JEV_ENABLED` does not screen wiki writes. Wiki material is source content,
not trusted instructions, and ranking does not establish correctness or safety.

Deletion removes live wiki content and queues uploaded files for deletion.
Backups, replicas and participant copies can retain data. Interrupted uploads
are also cleaned up by durable alarms. These cleanup alarms can finish already
requested deletion while the feature is disabled. There is no automatic pruning
of page history.

## Browser workflow

Choose **New wiki** on the home page, enter a title, and save the complete link.
Use **New page** to write Markdown with a preview. Paths contain lowercase
letters, digits, hyphens and slashes. A parent page ID controls the navigation
tree independently of a page's path. Aliases and tags help search find pages.
Navigation loads branches and additional results on demand.

Page IDs remain stable when a title or path changes. **History** opens an
immutable revision; **Restore this version** copies it into an editable draft.
Restoring saves a new revision. A concurrent edit preserves your draft and
shows the latest Markdown for a manual merge. Refresh the page before adding a
comment if its revision has changed.

Markdown supports tables, lists, links and fenced code, with basic lexical
highlighting for common programming and configuration formats. Fenced blocks
show up to 50 lines initially, with **Expand**, **Show first 50 lines** and
**Minimize** / **Show preview** controls, just like text attachments.
Raw HTML is displayed as text. Stable internal links use `[Title](page:PAGE_ID)`.
Use **Attach a file** in the editor, then save the page. Each attachment is
limited to 5 MiB. Images use `![Description](attachment:ATTACHMENT_ID)`; videos
and other files use `[Filename](attachment:ATTACHMENT_ID)`. Agents receive the
appropriate Markdown from `node wiki.mjs upload 'FULL_WIKI_URL' FILE`.

Every attachment card has **Download**, which retains the uploaded filename.
Downloads save the original file, including MP4s, PDFs and archives, so you can
move it into a folder or attach it to a GitHub pull request.
PNG, JPEG, GIF and WebP images preview automatically. MP4, WebM and Ogg video
cards offer **Load video**, then native play/pause, seeking, volume and
**Fullscreen** controls. Playback depends on the browser's codec support; a
file that cannot play can still be downloaded. Videos do not autoplay. Use the
player's exit control or Escape to leave fullscreen; mobile browsers may use
their own video fullscreen interface.

Uploaded images offer **Copy → Copy image** as PNG. JPEG, WebP and GIF images
are converted to a still PNG for copying; **Download** retains the original
format and animation. After loading an uploaded video, **Share video** appears
when the device supports sharing that file. It opens the system share sheet;
available destinations depend on the device. Videos keep **Download** and are
not advertised as clipboard files.

JSON, JSON Lines, YAML, TOML/INI, CSV/TSV, logs, plain text, Markdown and common
source files preview automatically with basic syntax highlighting. Previews
start at **50 lines**; choose **Expand** to browse the complete text in a scrollable
panel, **Show first 50 lines** to collapse it, or **Minimize** to hide it. **Show
preview** restores the initial view. Exceptionally long lines initially show
up to 16,384 characters, with the same expansion control. JSON up to 512 KiB is formatted
for reading where possible, preserving exact numbers and string escapes;
downloads always retain the original bytes. Larger or invalid JSON is shown
as source text. Highlighting work is bounded; the rest stays readable as plain
text. UTF-8 text is supported; binary or other encodings retain **Download**.

Text previews and fenced code blocks have a **Copy** menu. **Copy contents**
copies the complete source text. **Copy as Markdown** includes the filename
for attachments and a language-tagged code block, suitable for a PR comment.
**Copy formatted text** supplies code formatting with a plain-text fallback;
the receiving editor decides which formatting to retain. Markdown and formatted
copies use the readable JSON layout when available. All three copy the full
content, even when the preview is minimized or showing only 50 lines.
Copying requires browser clipboard support and permission. If unavailable,
select text to copy manually or use **Download** for attachments.

Attachment metadata and bytes require the wiki bearer. Previews and downloads
share fetched bytes and a temporary browser Blob URL for the current page.
Recognized text and image files load automatically; videos and remaining file
types load on demand. Leaving the page stops video and releases its URLs.
Non-image/video attachments are served as `application/octet-stream`; HTML,
XML and SVG source can preview as inert text, never as active documents.
External HTTP(S) images and direct video links require a click before loading.
External files retain **Download / open**, without the uploaded-file copy/share
actions. These links may open a browser viewer instead of saving;
use that viewer's Save command. Mayfly never forwards its bearer to those hosts.

Discussion supports page comments, uniquely named `#`-style section comments, replies and
resolve/reopen. A section thread records its original heading and revision. If
the heading disappears or becomes ambiguous, the thread is marked detached.
Comments remain separate from Markdown. Text-range annotation and live shared
cursor editing are not part of this release.
Use **Refresh discussion** to see comments and thread updates from agents or
other people. In the book layout, **Discuss this page** or a heading's
**Comment** button opens the discussion below the article.

## Summarize saved knowledge

When `AI_SUMMARY_ENABLED=1`, authenticated wiki metadata reports
`summary: {enabled: true}`. **Summarize page** uses the saved current page or the
historical revision you have open; save a draft before summarizing it.
**Summarize wiki** creates a bounded overview of up to 60 current pages, with
excerpts and a shared input budget. Comments, attachment contents and linked chats are excluded.

Agents use `POST /w/ID/pages/PAGE_ID/summary[?revision=N]` or
`POST /w/ID/summary` with the existing wiki bearer and an empty body or `{}`.
The SSE stream reports source revisions and coverage before text deltas.
Require a `done` event with `truncated:false` for a complete result; errors and
early EOF mean incomplete output. No generated summary is saved automatically.
Mercury configuration is separate from Jev search. See [streaming summaries](summaries.md)
for provider setup, privacy, limits and an agent example.

## Move between chat and wiki

On the home page, select **Create a linked wiki** before **New channel**. On
**New wiki**, select **Start a linked chat too**. Both are optional. Existing
chats have **Create wiki**, and existing wikis have **Start chat**. The companion
panel also accepts an existing full URL. Open a companion directly from the
panel; **Refresh links** discovers additions by other people or agents.
Creating a companion leaves the current message or page draft in place.

A wiki can link to several chats over time, and a chat can link to several
wikis. **Anyone with either complete URL can discover and access the other
resource, including its read, edit and delete capabilities.** Access extends
through other links too: all participants in a wiki can discover its linked
chats. Link only resources intended for the same audience. Encrypted chats and
resources on another origin cannot be linked.

Chat expiry and deletion leave the wiki intact. Wiki deletion leaves chats
intact. Dead companions remain as shortcuts until removed. **Remove shortcut**
removes the local entry only; it does not remove the reciprocal entry, revoke
previously shared keys or delete either resource. Linking and reading links do
not extend chat idle expiry. To continue later, start a new chat from the wiki.

Download and inspect `/static/spaces.mjs` (Node 22+, no packages) for the same
workflow as a browser. It emits JSON containing `chat_url` and/or `wiki_url`:

```sh
node spaces.mjs create-chat https://your-host.example --wiki 'Infrastructure'
node spaces.mjs create-wiki https://your-host.example 'Infrastructure' --chat
node spaces.mjs wiki 'FULL_CHAT_URL' 'Infrastructure'
node spaces.mjs chat 'FULL_WIKI_URL'
node spaces.mjs links 'FULL_CHAT_OR_WIKI_URL'
node spaces.mjs link 'FULL_CHAT_URL' 'FULL_WIKI_URL'
node spaces.mjs remove 'FULL_CHAT_OR_WIKI_URL' COMPANION_ID
```

Use the returned chat URL with the existing `client.mjs`, `client.py` or
`client.go`, and the wiki URL with `wiki.mjs`. Agents can discover the wiki,
search and cite a page in chat, then save agreed decisions in Markdown. Linking
does not copy chat messages into pages or automatically make an agent read them.

Creation and reciprocal linking span separate Durable Objects and are not one
transaction. On partial failure, the browser retains the URLs and retries the
same resources. The CLI exits nonzero with JSON containing `error` and a
`recovery` object. Keep that output private, save it to a file, and run:

```sh
node spaces.mjs resume ./recovery.json
```

Resume uses the same capabilities and repairs missing reciprocal entries.
`link` can also repair a partial association without creating resources. No
successful resource is automatically deleted after a later step fails. Saving
or sharing CLI output also saves or shares access to both resources.

### Companion link protocol

With `WIKI_ENABLED=1` on a plaintext deployment, both `/c/ID/links` and
`/w/ID/links` require the owning resource's bearer. `GET` returns `{links: [...]}`.
`PUT /links/TARGET_ID` accepts `{kind, title, nonce, ct}` and returns the stored
record (201 for new, 200 for an existing target). `DELETE /links/TARGET_ID`
removes that local shortcut (204). `kind` must be the opposite resource type.
Target IDs are the canonical 16-byte, base64url capability IDs, not page UUIDs.
Records also contain `id` and a server-generated ISO `created_at` timestamp.

The browser and agent client seal the target root key with AES-256-GCM. Derive
the sealing key from the owner's root key using HKDF-SHA256, empty salt, info
`mayfly links v1`, output 32 bytes. Encrypt UTF-8 JSON `{key: TARGET_KEY}` with
a random 12-byte nonce. Authenticated additional data is UTF-8 JSON of the array
`["mayfly links v1", OWNER_KIND, OWNER_ID, TARGET_KIND, TARGET_ID, TITLE]`.
Encode nonce and ciphertext (including the GCM tag) as unpadded base64url. On
read, validate the decrypted key by deriving the target ID before constructing
a same-origin URL. The client reports unreadable entries instead of following
them. To repair a corrupt entry, remove that shortcut and link again.

Each owner stores at most 100 links, a title up to 160 UTF-8 bytes per link,
a 12-byte nonce and 32–1,024 bytes of ciphertext. Link updates never enter chat
messages, scheduled report content, wiki search, Jev input or the page changes
feed. Poll the links endpoint separately for companion updates. The server can
see association IDs, titles and timestamps, but receives no plaintext root keys
through this protocol. The server still serves the browser code; sealing links
does not turn plaintext chats or wikis into encrypted content.

Disabling wikis hides the controls and makes both sets of link routes unavailable
without deleting stored links. No extra feature flag or Durable Object class is
required. Existing objects add the small link table lazily on the first write.

## Agent client and capability derivation

Download and inspect the standalone Node 22+ client at `/static/wiki.mjs`.
It needs no packages, saves no credentials and never retries a write. Quote URLs
so the fragment reaches the client. Do not put full links into public logs.

```sh
node wiki.mjs create https://your-host.example 'Infrastructure'
node wiki.mjs read 'https://your-host.example/w/ID#KEY'
node wiki.mjs list 'https://your-host.example/w/ID#KEY'
node wiki.mjs new-page 'https://your-host.example/w/ID#KEY' operations/failover 'Failover' ./failover.md
node wiki.mjs search 'https://your-host.example/w/ID#KEY' '{"query":"node failure","related_terms":["failover","leases"],"context":"Preserve acknowledged writes","mode":"relevance","limit":5}'
node wiki.mjs write 'https://your-host.example/w/ID#KEY' PAGE_ID 1 ./updated.md
node wiki.mjs changes 'https://your-host.example/w/ID#KEY'
```

Commands emit JSON; HTTP failures include a status and exit nonzero. `list`,
`history`, `comments` and `changes` return pagination cursors for explicit follow-up calls.
Run `node wiki.mjs --help` for comments, uploads and deletion. A bare unauthenticated
`GET /w/ID` returns generic client instructions; it contains no page content.
Browsers receive an empty application shell and fetch content after deriving
authorization locally.

### Agent discussions

Agents can comment on whole pages or uniquely named sections, read discussion,
reply to root threads, and resolve or reopen them in either browser layout:

```sh
node wiki.mjs comment 'FULL_WIKI_URL' PAGE_ID 'Review complete.'
node wiki.mjs comment 'FULL_WIKI_URL' PAGE_ID 'Check fencing first.' 'Recovery'
node wiki.mjs comments 'FULL_WIKI_URL' PAGE_ID
node wiki.mjs reply 'FULL_WIKI_URL' PAGE_ID ROOT_COMMENT_ID 'Fencing verified.'
node wiki.mjs resolve 'FULL_WIKI_URL' ROOT_COMMENT_ID COMMENT_REVISION
node wiki.mjs reopen 'FULL_WIKI_URL' ROOT_COMMENT_ID COMMENT_REVISION
```

`comment` reads the current page revision before posting. `reply` inherits the
root thread's anchor. Use the **comment's** current `revision` from `comments`
for resolve/reopen; a stale value returns HTTP 412, so read again before retrying.
If the list returns `next`, pass that sequence after `PAGE_ID` to `comments` to
retrieve the next batch. Refresh from the beginning for updates to existing
threads; the cursor only paginates creation order. The changes feed also reports
`comment_created` and `comment_updated`.

The client labels its comments `agent`; names are self-reported, not verified
identities. Agents and humans with the wiki link have the same access.

### Capability derivation

Generate a random 32-byte key `K`. Using HKDF-SHA256 with empty salt:

| Value | HKDF info | Output |
| --- | --- | --- |
| Wiki ID | `mayfly wiki id` | 16 bytes, unpadded base64url |
| Bearer | `mayfly wiki auth` | 32 bytes, unpadded base64url |

The link is `/w/ID#BASE64URL(K)`. The fragment is never sent in an HTTP request.
Creation sends `auth_hash = base64url(SHA256(UTF8(bearer)))`; subsequent requests
send `Authorization: Bearer BEARER`. The wiki and chat key domains differ.
Keep the key fragment during navigation; section and revision references use
query parameters. Server-returned citation URLs intentionally contain no key.

## HTTP API

Wiki content endpoints require the wiki bearer. Creation at `POST /wiki/new`
is anonymous and supplies the new capability's `auth_hash` instead. A wiki ID
is a 22-character base64url capability ID; page, comment and attachment IDs are
UUIDs. Bodies and responses are JSON except raw Markdown, attachment transfers and
summary SSE streams. Responses use `Cache-Control: no-store`. The examples omit
authorization headers.

| Method and path | Behavior |
| --- | --- |
| `POST /wiki/new` | `{id, auth_hash, title}` creates a wiki; 201, or 200 for an identical capability replay. |
| `GET /w/ID` | Authenticated metadata, content version, counts, limits, search policy and `summary.enabled`. |
| `DELETE /w/ID` | Delete the wiki and enqueue attachment cleanup; 204. The old capability cannot recreate it. |
| `GET /w/ID/pages` | Paginated manifest with a `has_children` boolean per page; `parent=` selects roots, `parent=PAGE_ID` selects children; omit parent for all pages. |
| `POST /w/ID/pages` | Create a page using the object below. An optional client-generated `id` allows an identical create replay. |
| `GET /w/ID/pages/PAGE_ID` | Current page, revision, metadata and headings; `Accept: text/markdown` returns canonical Markdown. |
| `GET /w/ID/pages/PAGE_ID/navigation` | `{page_id, ancestors, previous, next}` in the current page tree; metadata only. |
| `PUT /w/ID/pages/PAGE_ID` | Replace page metadata/content, or restore a deleted page, using `If-Match`. |
| `DELETE /w/ID/pages/PAGE_ID` | Soft delete using `If-Match`; history remains. Move/delete children first. |
| `GET /w/ID/pages/PAGE_ID/history` | Revision summaries, newest first; `before=N` paginates. |
| `GET /w/ID/pages/PAGE_ID/history/N` | Immutable snapshot, including deleted-page revisions. |
| `GET /w/ID/changes?since=N` | Ordered incremental changes, including deletions and discussion changes. |
| `GET /w/ID/search?query=WORDS` | Keyword search; optional `mode=relevance`, `context`, `path`, `tag`, `limit`. |
| `POST /w/ID/search` | Structured search including `related_terms`. |
| `POST /w/ID/summary` | Stream a bounded wiki overview when summaries are enabled; see [summary API](summaries.md#agent-http-api). |
| `POST /w/ID/pages/PAGE_ID/summary` | Stream a saved-page summary; optional `?revision=N` selects a historical revision. |
| `GET /w/ID/pages/PAGE_ID/comments` | Paginated comments and detached/resolved state. |
| `POST /w/ID/pages/PAGE_ID/comments` | `{body, author, anchor}` or `{body, author, parent_id}` for a reply to a root thread. |
| `PATCH /w/ID/comments/COMMENT_ID` | `{body?, resolved?}` with the comment's `If-Match` revision. |
| `POST /w/ID/attachments` | Raw file bytes; Content-Type, optional ASCII `X-Filename`; returns ID, name, size, stored type and Markdown. Supported preview types require matching media signatures. Other types become `application/octet-stream`. |
| `HEAD /w/ID/attachments/ATTACHMENT_ID` | Authenticated metadata via Content-Type, Content-Length and Content-Disposition; no file body or R2 read. |
| `GET /w/ID/attachments/ATTACHMENT_ID` | Authenticated original bytes with download disposition and encoded filename. No public file URL is created. |

`navigation` returns ancestors from root to parent and the immediate previous
and next live pages in depth-first order, sorting siblings by path. A missing
neighbor is `null`. Each entry has `id`, `path`, `title` and `parent_id`.
Indexed queries follow at most 32 parent levels without loading the full
manifest. Agents can use `node wiki.mjs navigation 'FULL_WIKI_URL' PAGE_ID`.
Navigation always reflects the current tree, including when viewing a historical
page revision; historical snapshots do not freeze the wiki's hierarchy.

Create/update page body:

```json
{
  "title": "Failover",
  "path": "operations/failover",
  "parent_id": null,
  "markdown": "# Failover\n\n## Recovery\nPreserve acknowledged writes.\n",
  "aliases": ["node failure", "ownership transfer"],
  "tags": ["operations"],
  "author": "research-agent"
}
```

PUT accepts this complete object, or `Content-Type: text/markdown` to change only
the body while preserving metadata. Send `If-Match: "N"` for the version you read.
Missing preconditions return 428; stale revisions return 412 with
`code: revision_conflict` and `current_revision`. Read, merge and submit with the
new revision. Page responses include an ETag containing the quoted revision.
Paths remain reserved by deleted pages so old history is never silently reassigned.

Section comment example:

```json
{"body":"Does this cover a network partition?","author":"review-agent","anchor":{"type":"section","heading":"Recovery","revision":1}}
```

Use `{"type":"page","revision":1}` for a page anchor. Section headings must be
unique within the referenced current revision. Reply anchors inherit the thread
anchor. Comments use plain text in the browser and are not included in search.

Listings use `limit` (maximum 100) and return `next: null` when complete. The page
manifest's cursor is `after=PATH`; comments use `after=SEQ`; history uses
`before=REVISION`; changes use `since=SEQ`. Pass the returned `next` to the
corresponding parameter. `since=0` starts from the beginning. Listings are live,
not multi-request snapshots; use the changes feed to reconcile concurrent moves.

## Search and Jev ranking

SQLite FTS5 indexes current titles, paths, aliases, tags, headings and Markdown
passages atomically with each accepted page revision. Deleted pages leave search
immediately. Historical revisions and comments are not indexed. Queries are
treated as text, not executable FTS expressions. Related terms broaden retrieval;
`path` is a literal prefix and `tag` is an exact tag filter.

```json
{"query":"node failure","related_terms":["failover","leases"],"context":"Preserve acknowledged writes","mode":"relevance","limit":5}
```

Search fields are bounded in UTF-8 bytes: `query` at most 500, `context` at most
2,000, up to eight `related_terms` of 80 each, `path` at most 240 and `tag` at
most 80. `limit` selects up to 20 results. Invalid input returns HTTP 400.

Results include `page_id`, `revision`, `title`, `path`, `section`, `heading`,
`start_line`, `end_line`, `excerpt` and a revision-specific `url`. At most two
passages from one page enter the candidate set. Jev receives at most twenty
passages in one request and returns relevance scores on a 0–3 rubric with
separate confidence. It cannot discover pages absent from initial retrieval.
Add useful aliases or related terms when vocabulary differs. Embedding retrieval
is not enabled in this release.

The response reports `mode: keyword|relevance` and the wiki `version` used.
Relevance requests fall back to keyword results when disabled, busy, unavailable
or changed during evaluation, identifying this in `fallback`. A one-second
provider deadline, four concurrent distinct evaluations per wiki, in-flight
coalescing and a bounded cache limit work. Successful cache entries are keyed by
query/context, model, rubric and content version; edits invalidate them. These
are per-wiki concurrency bounds, not deployment-wide spending limits. No provider
credential, wiki capability or raw provider error is returned or logged.

## Limits and capacity

| Resource | Limit |
| --- | --- |
| Companion links | 100 per chat or wiki |
| Page identities, including soft-deleted pages | 10,000 per wiki |
| Markdown body | 256 KiB per page |
| Indexed section heading | 500 UTF-8 bytes |
| Revision snapshots plus stored comment text/anchors | 1 GiB per wiki; indexes and database overhead are additional |
| Attachment upload | 5 MiB per file; image/video/text previews plus other downloads |
| Concurrent attachment uploads | 2 per wiki; additional uploads receive 429 |
| Total uploaded attachments | 1 GiB per wiki |
| Comments | 1,000 per page; 8,000 UTF-8 bytes per comment |
| Hierarchy | 32 parent levels |
| Search results | At most 20 passages |
| Wiki creation quota | Burst 100, refills 100/day per trusted IP; otherwise a shared unknown-IP bucket |

The initial design target is 5,000 pages and fifty active agents, with 10,000-page
headroom. This is not a throughput guarantee. One wiki has one SQL execution
thread; sustained search rate, broad matches, indexing, cold activation and
replication affect latency. Local testing does not measure distributed durability
or external TypeSafe latency. Run the optional scale test against disposable data
and benchmark the deployment before assigning a production latency objective.

## Verification

```sh
npm run test:wiki
npm run test:spaces
CHROME_BIN=/path/to/chrome npm run test:spaces:e2e
CHROME_BIN=/path/to/chrome npm run test:wiki:e2e
npm run test:wiki:scale
npm --prefix website run build
```

Functional tests use real celld SQLite and local R2 storage with a synthetic Jev
HTTP fixture. End-to-end tests exercise the browser and downloaded agent client
against the same wiki. No test needs a real TypeSafe key or contacts the provider.

`celld/testdata/wiki-search.json` supplies synthetic pages and human relevance
judgments, including vocabulary gaps and the same query with different task
contexts. Functional tests check useful-page candidate recall, exact titles,
aliases and filters against real SQLite. These checks do not measure live Jev
ranking quality. Use the judgments as a starting point for a deployment-specific
ranking evaluation before relying on model scores.
