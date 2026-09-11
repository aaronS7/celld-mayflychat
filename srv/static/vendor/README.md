# Vendored browser Markdown libraries

Unmodified official browser builds, embedded into the channel and document
pages by `srv/pages.go`. No CDN, npm, bundler, or asset route is involved at
runtime.

| File | Library | Version | Source | License |
| --- | --- | --- | --- | --- |
| `marked.umd.js`, `marked.LICENSE` | [Marked](https://github.com/markedjs/marked) | 18.0.12 | `package/lib/marked.umd.js` and `package/LICENSE` from https://registry.npmjs.org/marked/-/marked-18.0.12.tgz | MIT |
| `purify.js`, `DOMPurify.LICENSE` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.15 | `dist/purify.js` and `LICENSE` at tag 3.4.15 (identical to the npm tarball) | Apache-2.0 |

SHA-256 of the vendored files:

```
fa0cfbf0181339312eaa3709b577ad698fc21a9baa42d580a3fd1f267b19b4a8  marked.umd.js
8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c  marked.LICENSE
979b6c28df92881a36009de0bda1e866bee043ad69d36e54509e7210723d9af4  purify.js
cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30  DOMPurify.LICENSE
```

## How they are used

Marked's output is never trusted: `srv/browser/markdown.js` (channel messages)
and `srv/browser/document.js` (documentation pages) each run it through a
private DOMPurify instance with a narrow tag and attribute allowlist, escape
raw HTML so it stays visible as source, and add only app-owned DOM
afterward. Messages get per-image "Load image" controls instead of `<img>`
tags; documents get alt text. If either library is missing or the sanitizer
reports itself unsupported, the text is shown as a plain text node.

## Updating

1. Check the upstream releases and security advisories for both libraries.
2. Replace the files with the official distribution for the new version and
   update the table and hashes above.
3. Run the real-browser tests, which exercise the actual vendored bytes:

```
CHROME_BIN=/path/to/chrome go test -race -count=1 ./...
```
