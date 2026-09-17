# Mayfly documentation website

Published at <https://aarons7.github.io/celld-mayflychat/>. This is a static
documentation site; the chat application runs separately on celld.

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

## Edit content

- `pages/guide/`: authored guides and interactive examples.
- `.vitepress/theme/`: Vue components and Mayfly theme styles.
- `.vitepress/config.mts`: navigation, search, and build settings.
- `public/media/`: committed screenshots, video, and English captions.
- `scripts/sync-docs.mjs`: generates the reference from the same source as the
  application's native documentation, including the protocol adaptations.

Both `dev` and `build` regenerate `pages/reference/`; do not edit that ignored
directory. Change the source in `srv/docs/`, `celld/docs/`, `celld/JEV.md`,
`celld/TAGGING-VERIFICATION.md`, or the native adaptations in
`celld/documentation.mjs`. Re-run `npm run sync` after editing a reference source
while the development server is running.

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

## Publish

The `Documentation` GitHub Actions workflow builds relevant pull requests and
publishes successful builds from `main`. Enable **Settings → Pages → Build and
deployment → Source: GitHub Actions** on your fork. It uploads only
`.vitepress/dist/`, with no custom secrets required.

The workflow derives the base path from the repository name. If publishing on a
custom domain, set `BASE_PATH` to `/` and follow GitHub's custom-domain setup.
