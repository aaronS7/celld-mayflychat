# Wiki verification

Verified locally on 2026-09-22 with celld 0.5.0 and real headless Chrome. Tests
create disposable storage; they do not alter a running deployment. Wiki and Jev
search flags and the book layout remain off in the default configuration.

## Functional and browser coverage

### ZIP export

`CHROME_BIN=/path/to/chrome npm run test:wiki:export` covers the ZIP writer,
real celld/SQLite/R2 export endpoints, the served Node client, and actual browser
downloads in desktop/mobile views of both wiki layouts. Python's standard ZIP
reader independently verifies every entry's CRC and the downloaded file bytes.
Coverage includes relative page/file links, Unicode, safe filenames, hierarchy
metadata, resolved discussion/replies, unreferenced uploads, empty wikis, deleted
content exclusion, credential isolation, ticket replay, cancellation and existing
output protection. Drafts remain in the editor and do not appear in exports.

Single-page coverage checks `README.md` plus only referenced uploads, binary
integrity, self-links, unresolved cross-page links, current discussion alongside
historical Markdown, explicit revision selection, deleted-page history, missing
and cross-wiki attachment references, code-example exclusion and shared export
concurrency. Both served agent commands and eight native browser downloads
(page/whole wiki × desktop/mobile × book/classic) are exercised. The page browser
flow selects revision 1 while revision 2 exists and verifies the downloaded ZIP
contains revision 1, with relative links and no unsaved draft.

The exact 1 GiB boundary and ZIP overhead are checked arithmetically without
allocating a GiB fixture. A disposable runtime with a reduced cap exercises HTTP
413. A delayed object-store read exercises a concurrent edit during streaming:
the response fails and status reports `export_changed`. Browser checks include
download progress/completion, light/dark themes, mobile overflow and CSP. They
do not test a GitHub PR upload, a Notion/Confluence import, or Safari/device download behavior.

On 2026-09-22, the extended capacity test exported 2,000 synthetic pages while
50 readers searched the same wiki. Local preparation took 683 ms; download and
independent ZIP validation finished in 4,422 ms total, producing 3,636,152 bytes.
This measures a small local archive, not a 1 GiB production throughput guarantee.
The streaming implementation bounds memory to entry metadata and current chunks.

### Core wiki features

`npm run test:wiki` exercises real celld SQLite and local R2, plus a synthetic
TypeSafe HTTP server. Coverage includes:

- Wiki capabilities, authentication, isolation, creation replay and private HTML
  shells; disabling/re-enabling the feature and encryption policy changes.
- Stable page identities, navigation, pagination, optimistic concurrency,
  immutable history, restoration, soft deletion and permanent wiki deletion.
- Atomic search indexing, aliases, related terms, filters, revision citations,
  Unicode passage boundaries, concurrent reads and changes-feed synchronization.
- Page/section comments, replies, conditional updates and detached anchors.
- Authenticated images, videos, text and other files; content-type/signature
  checks, metadata HEAD requests, filename preservation, upload size limits and
  persistence across daemon restart. HTML/SVG stay opaque on the wire and
  preview only as inert source text in the browser.
- Jev score validation, cache invalidation, coalescing, concurrency limits,
  deadlines, provider failure and edits/deletion during evaluation.

The synthetic judged corpus in `celld/testdata/wiki-search.json` retained all
nine useful-page judgments in its top twenty candidates across eight cases.
This is a small retrieval regression check, not evidence of live model quality.

`CHROME_BIN=/path/to/chrome npm run test:wiki:e2e` drives the actual browser and
the client downloaded from the running service through one shared wiki. It
checks creation, human/agent edits, conflict preservation and merge, history
restoration, discussion, image upload/rendering, keyword/Jev search, source-line
citations, client changes, mobile layout, missing keys, CSP and deletion.
The Jev endpoint is replaced by the local fixture; no provider key is needed.

The book-layout functional checks additionally exercise flag validation and
reversibility, authenticated depth-first navigation, ancestors, nested and moved
pages, deleted-page exclusion and wiki isolation. The downloaded agent client
creates page/section comments, reads discussion, replies, resolves and reopens
threads, including stale-revision rejection.

A second Chrome test enables `WIKI_BOOK_LAYOUT_ENABLED=1` and checks the sticky
sidebar, breadcrumbs, section outline, previous/next links, capability-preserving
section URLs, browser history, keyword/Jev search dialog and revision citations.
It shares discussion between a human and the downloaded agent client, refreshes
agent replies, reopens an agent-resolved thread, and saves a human edit. It also
checks draft preservation, light/dark themes, the mobile page menu, overflow,
agent instructions and CSP. The original browser test keeps the flag off to
cover the classic layout too.

The mobile navigation is additionally exercised using actual touch events in
Chrome's mobile viewport: opening a full-height modal drawer, independent tree
scrolling, no article reflow, keyboard focus containment and return, Escape,
backdrop and close-button dismissal, selection and create-page dismissal, and
search from the drawer. Checks cover responsive movement between drawer and
desktop sidebar, reduced motion, current-page ancestors after saving, and expand
controls only on pages with live children. The manifest's indexed child-existence
query is checked after moving and deleting child pages.

Refresh checks hold a real manifest request open to verify the spinning arrow,
loading label, busy semantics, repeated-tap guard and unchanged toolbar width.
They confirm discovery of an agent-added page, completion feedback, preservation
of the article and selected ancestors, an injected failure followed by a
successful retry inside the mobile drawer, retained focus and reduced motion.

`CHROME_BIN=/path/to/chrome node celld/record-wiki.mjs` produces desktop and
mobile recordings, captions and posters from disposable synthetic content. It
uses real Chrome mouse/touch inputs and keyword search without provider calls.
Chrome adds one second of network latency during refresh to make the loading
indicator visible; the recording captions identify this simulated delay.

`CHROME_BIN=/path/to/chrome npm run test:media:e2e` uses FFmpeg to create a small
valid video and real browser downloads to compare saved image/video/document
bytes. It exercises agent uploads, human file insertion and saving, mixed image
and attachment Markdown, deferred video downloads, playback, pause, seeking,
fullscreen entry/exit, desktop/mobile layouts and cleanup on page changes.
The chat case verifies external image/video opt-in, downloads, no forwarded
credentials/referrers, literal HTML and CSP. Only local fixtures are used.
Image checks write actual PNG and converted JPEG content to the browser
clipboard and decode the result. Video sharing uses a stub at the operating
system share-sheet boundary, checking the real File's name, type, unchanged
bytes, click gesture, cancellation and unsupported-device fallback. These tests
do not drive an actual operating system share destination.

The text-preview browser test covers automatic JSON/YAML/CSV and source previews,
50-line defaults, expand/collapse/minimize/restore, exact large JSON integers,
binary fallback, malformed JSON, long-line bounds, safe XML text, unchanged
download bytes and shared attachment requests. It checks desktop/light and
mobile/dark layouts, fenced code controls in both chat and wiki, and CSP.
Clipboard checks read full original text, Markdown and rich HTML from the real
browser clipboard, including minimized content and records beyond 50 lines.
They paste chat code into an editor using the browser's paste shortcut and
exercise clipboard rejection, missing API and plain-text fallback. Download
still saves the original attachment after copying is unavailable.
`npm run test:text-preview` separately checks format recognition, lexical
highlighting bounds, JSON formatting without numeric precision loss, Markdown
fence/filename escaping and inert rich clipboard markup.

## Linked chat and wiki coverage

`npm run test:spaces` exercises authenticated reciprocal discovery, several chats
per wiki, several wikis per chat, restart persistence, independent deletion,
feature flags, encrypted-chat rejection, unchanged chat expiry, payload and
100-link limits, tampered ciphertext, and capability isolation from messages
and Jev inputs. Injected lost creation responses and failed reciprocal writes
verify that retry reuses the same resources and does not resurrect deleted
chats. The downloaded CLI also exercises discovery and recovery files.

`CHROME_BIN=/path/to/chrome npm run test:spaces:e2e` checks optional paired
creation in both directions, navigation, adding companions to existing resources,
linking an existing wiki, agent-created chats, discovery refresh, a retained
chat draft, one-sided failure and browser retry, shortcut removal, missing keys,
mobile layout and CSP. It uses real Chrome and clients downloaded from celld.

## Local capacity exercise

`npm run test:wiki:scale` seeds 5,000 synthetic pages; set
`WIKI_SCALE_PAGES=10000` to exercise the configured page ceiling. Each page has
roughly 1 KiB of Markdown across three sections. The exercise mixes selective
and broad searches: forty sequential searches, three bursts of fifty searches,
then forty searches alongside ten conditional writes. Accepted writes are
verified through fresh search results. Both runs passed without request errors.

| Measurement | 5,000 pages | 10,000 pages |
| --- | ---: | ---: |
| Seed time | 15.1 s | 28.6 s |
| Sequential search p50 / p95 | 3 / 14 ms | 5 / 88 ms |
| Burst search p50 / p95 | 94 / 167 ms | 234 / 673 ms |
| Concurrent write p50 / p95 | 133 / 140 ms | 530 / 569 ms |

These are warm local HTTP measurements from a synthetic corpus, not production
latency guarantees. They do not cover large revision histories, maximum-size
pages, cold activation, independent host failure, distributed replication or
external TypeSafe latency. Broad bursts at 10,000 pages show the queueing cost
of a single wiki's SQL thread. Measure the intended deployment before assigning
a production latency objective.

## Reproduce

```sh
npm run generate
npm run check
npm run test:wiki
npm run test:spaces
CHROME_BIN=/path/to/chrome npm run test:spaces:e2e
CHROME_BIN=/path/to/chrome npm run test:wiki:e2e
npm run test:wiki:scale
WIKI_SCALE_PAGES=10000 npm run test:wiki:scale
npm --prefix website run build
```

The complete `npm test` regression command additionally requires Chrome, Go
1.27.1 and Python with `cryptography`; `CHROME_BIN`, `GO_BIN` and `PYTHON_BIN`
can select those executables. The existing chat, configuration, moderation,
tagging and reporting checks remain in that command alongside the wiki tests.

The GitHub Pages API reference is generated from the wiki documentation served
by the application; the human guide and screenshots are maintained alongside it.
Building the site validates the documentation locally; publishing follows the
repository's deployment workflow.
