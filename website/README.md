# Mayfly documentation website

Published at <https://aarons7.github.io/celld-mayflychat/>. This is a static
documentation site; the chat and optional wiki application runs separately on celld.

Like [PicoMQ's website](https://github.com/PicoMQ/picomq/tree/main/website), it uses
VitePress 1.6 with a custom Vue theme. The colors, wordmark, typography, and small
controls follow Mayfly's browser interface. Search is local; there are no
analytics, external fonts, API keys, or Jev calls in the documentation site.

## Develop and build

Use Node.js 22 or newer:

```sh
cd website
npm ci
npm run dev
```

```sh
npm run build
npm run preview
```

Open the printed URL with `/celld-mayflychat/` appended. The production output is
`.vitepress/dist/`. `BASE_PATH` overrides the project path; it must start and end
with `/`. For example, `BASE_PATH=/ npm run build` builds for a domain root.

The Vite override keeps VitePress 1.6 on the patched Vite 6 line, supported by its
Vue plugin. Keep the lockfile and run `npm audit` when updating dependencies.

Screenshots reserve their space and show a loading indicator until the browser
resolves the saved/system theme and decodes the matching image. Theme changes
also wait for the new image, so a light screenshot never flashes in dark mode.
The indicator respects reduced-motion preferences and reports failed downloads.

After building, run the browser regression check with Chrome or Chromium:

```sh
CHROME_BIN=/path/to/chrome npm run test:images
```

Use the same `BASE_PATH` as the build. The check uses a disposable local server
and browser profile, delays scripts and images, and covers desktop/mobile cold
loads, rapid theme changes, reduced motion, failed downloads and lazy images.
The publication workflow runs this check before uploading the site.

## Edit content

- `pages/guide/`: authored guides and interactive examples.
- `.vitepress/theme/`: Vue components and Mayfly theme styles.
- `.vitepress/config.mts`: navigation, search, and build settings.
- `public/media/`: committed screenshots, video, and English captions.
- `scripts/sync-docs.mjs`: generates the reference from the same source as the
  application's native documentation, including the protocol adaptations.

The wiki guide lives in `pages/guide/wiki.md`; its API/reference is generated
from `celld/docs/wiki.md`. The site's local documentation search is separate
from authenticated application wiki search and never calls Jev.

The summary guide is `pages/guide/summaries.md`; its reference is generated from
`celld/docs/summaries.md`. It documents the separate Mercury configuration,
bounded overview coverage and agent streaming API. The static documentation
site never calls Mercury.

The vault deployment guide is generated locally from `celld/swamp/README.md` as
`reference/mercury-deployment`, so setup instructions work before publication.
The separate scheduled-report reference explains automatic email/provider use;
it is not the on-demand summary feature. `public/llms.txt` is generated with the
current `BASE_PATH` and links agents to this site's guides and references.
Client downloads and application API calls still use the operator's app origin.

Both `dev` and `build` regenerate `pages/reference/`; do not edit that ignored
directory. Change the source in `srv/docs/`, `celld/docs/`, `celld/JEV.md`,
`celld/TAGGING-VERIFICATION.md`, `celld/WIKI-VERIFICATION.md`, `celld/swamp/README.md`, or the native adaptations in
`celld/documentation.mjs`. Re-run `npm run sync` after editing a reference source
while the development server is running.

Generated `pages/reference/`, `public/llms.txt` and `.vitepress/dist/` are ignored.
References derived from the Go docs link both the upstream page and the native
adaptation source, since raw upstream text alone does not describe this fork.

## Refresh the demo media

Install celld 0.5, esbuild, FFmpeg, and Chrome/Chromium. From this directory:

```sh
CHROME_BIN=/path/to/chromium npm run capture
```

The capture script starts a disposable local celld instance and a local provider
fixture, using Mayfly's real browser, moderation, tagging, and storage code. It
creates a synthetic conversation, records a tagged post and a refused post,
captures both themes, and removes its temporary chat and state afterward. The
recording holds background reads on the real refusal state for readability. It uses reserved
example IPs and replaces the displayed access link with a placeholder.

No production deployment, real API key, private conversation, or external
provider call is involved. The fixture's probabilities illustrate the UI;
they are not a claim about the live model's accuracy. Inspect the resulting
images and video before committing them. Captures are committed so the ordinary
documentation build needs neither Chrome nor celld.

Wiki captures include `wiki-light.png` / `wiki-dark.png` for the classic layout
and `wiki-book-light.png` / `wiki-book-dark.png` for the optional book layout.
Both use a disposable wiki with a linked chat, synthetic pages and discussion.
Regenerate both layouts and themes after wiki UI changes:

```sh
npm run generate
CHROME_BIN=/path/to/chrome node celld/capture-wiki.mjs
CHROME_BIN=/path/to/chrome node celld/capture-wiki.mjs --book
CHROME_BIN=/path/to/chrome node celld/capture-wiki.mjs --book --mobile
CHROME_BIN=/path/to/chrome node celld/record-wiki.mjs
```

Run these commands from the repository root. The script uses isolated local
storage and needs no provider key or production data.
The mobile capture produces `wiki-book-mobile-light.png` and its dark variant.
The recording command also requires `ffmpeg` and `ffprobe`; it produces desktop
and mobile MP4s, caption tracks and poster images. It drives real mouse/touch
input against the application with synthetic pages, including page navigation,
search, refresh feedback and discussion. Chrome simulates one second of network
latency during refresh so loading is visible; captions identify this delay.
The mobile viewport is 390 × 844 with touch emulation.
The recordings use keyword search and make no Jev calls. Inspect the videos
before publishing; they are browser recordings, not animations or UI mockups.

Summary-dialog screenshots use synthetic pages and a deterministic local
streaming provider, with no real Mercury calls. From the repository root:

```sh
npm run generate
CHROME_BIN=/path/to/chrome npm --prefix website run capture:summaries
```

This produces `summary-light.png` / `summary-dark.png` at 1440 × 1040 and
`summary-mobile-light.png` / `summary-mobile-dark.png` at 390 × 844. It verifies
completed output, excerpt coverage, source links and visible controls, then
deletes the temporary wiki and local state. The caption identifies fixture
output so these screenshots make no claim about model quality.

## Publish

The `Documentation` GitHub Actions workflow builds relevant pull requests and
publishes successful builds from `main`. Enable **Settings → Pages → Build and
deployment → Source: GitHub Actions** on your fork. It uploads only
`.vitepress/dist/`, with no custom secrets required.

Local edits and `npm run build` do not update GitHub Pages. Commit and push the
authored pages, reference sources, sync/theme changes and required media to
`main`, then check both the build and deploy jobs in `Documentation`. Newly
added reference sources must be included: an untracked local file can make a
local build pass while a clean CI checkout fails. Keep vault runtime data,
private deployment configuration and provider keys out of the commit.

The workflow derives the base path from the repository name. If publishing on a
custom domain, set `BASE_PATH` to `/` and follow GitHub's custom-domain setup.
