# Private PDF Signer

A single HTML file that signs PDFs entirely inside the browser. No server, no upload, works offline.
The Content-Security-Policy in the file blocks all network access.

## Use
Open `dist/pdf-signer.html` (also copied to `Downloads/preview.html`) by double-clicking it.

## Rebuild
```
npm install
node build.mjs                 # -> dist/pdf-signer.html
```
Source: `src/template.html`, `src/style.css`, `src/app.js`. pdf.js, its worker and font/CMap/WASM data,
pdf-lib, and four OFL signature fonts are embedded (gzip + base64) by `build.mjs`.

## Tests
```
node tests/make-fixtures.mjs   # rotated / cropped / encrypted / 300-page test PDFs
node tests/offline-e2e.mjs     # opens the file from disk in Chrome + Edge with networking OFF and signs a PDF
```
`tests/serve.mjs` + `tests/helpers.js` were used for in-browser accuracy tests (open the app with `#debug`).
