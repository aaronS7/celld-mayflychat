# Mermaid browser bundle

`celld/generate.mjs` bundles the pinned `mermaid` dependency from
`package-lock.json` into the native Worker's `/static/mermaid.js` asset. The
bundle is fetched only by a wiki page with a `mermaid` code fence. No CDN or
diagram text is sent to a remote renderer.

The bundle runs in `/static/mermaid-frame`, an iframe with `sandbox="allow-scripts"`
and a restrictive CSP. Its origin is opaque. The parent passes bounded source
through `postMessage`, validates the response, and displays the generated SVG
as a data URL image. The SVG is never inserted as page markup. The frame CSP
allows inline styles for Mermaid's temporary layout nodes; it blocks network
connections and external images. Mermaid uses `securityLevel: 'strict'`, and
author directives cannot change the site-owned security and size limits.

Mermaid is MIT licensed. See `node_modules/mermaid/LICENSE` after `npm ci`;
the generated bundle retains legal notices from bundled packages.
