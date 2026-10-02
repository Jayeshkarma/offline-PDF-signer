// Builds a single, fully offline HTML file: dist/pdf-signer.html
// Usage: node build.mjs [--out <path>]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const nm = p => path.join(root, 'node_modules', p);
const read = p => fs.readFileSync(p);
const gzB64 = buf => zlib.gzipSync(buf, { level: 9 }).toString('base64').replace(/.{1,1000}/g, '$&\n');

const pdfjsDir = nm('pdfjs-dist');
const pdfjsVersion = JSON.parse(read(path.join(pdfjsDir, 'package.json'))).version;
const pdflibVersion = JSON.parse(read(nm('pdf-lib/package.json'))).version;

// --- libraries
const pdfjs = read(path.join(pdfjsDir, 'legacy/build/pdf.min.mjs'));
// The worker ships as an ES module, but browsers refuse module workers on file:// pages.
// Convert it to a classic script: `import.meta.url` is only used to derive a base URL.
let workerSrc = read(path.join(pdfjsDir, 'legacy/build/pdf.worker.min.mjs')).toString('utf8');
const metaCount = (workerSrc.match(/import\.meta\.url/g) || []).length;
workerSrc = workerSrc.replace(/import\.meta\.url/g, 'self.location.href').replace(/export\s*\{\s*WorkerMessageHandler\s*\}\s*;?\s*$/, '');
if (!metaCount || /import\.meta|export\s*\{/.test(workerSrc)) throw new Error('Unexpected pdf.worker structure — review the classic-script conversion');
const worker = Buffer.from(workerSrc, 'utf8');
const pdflib = read(nm('pdf-lib/dist/pdf-lib.min.js'));
for (const [n, b] of [['pdf.js', pdfjs], ['worker', worker], ['pdf-lib', pdflib]]) {
  if (b.includes('</script')) throw new Error(n + ' contains </script');
}

// --- binary data for PDF.js (CMaps, standard fonts, WASM image decoders)
const entries = [];
for (const f of fs.readdirSync(path.join(pdfjsDir, 'cmaps')).filter(f => f.endsWith('.bcmap'))) entries.push([f, path.join(pdfjsDir, 'cmaps', f)]);
for (const f of fs.readdirSync(path.join(pdfjsDir, 'standard_fonts')).filter(f => /\.(pfb|ttf)$/.test(f))) entries.push([f, path.join(pdfjsDir, 'standard_fonts', f)]);
for (const f of ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm']) entries.push([f, path.join(pdfjsDir, 'wasm', f)]);
const index = {}; const bufs = []; let off = 0;
for (const [name, file] of entries) {
  if (index[name]) throw new Error('Duplicate resource ' + name);
  const b = read(file); index[name] = [off, b.length]; off += b.length; bufs.push(b);
}
const hdr = Buffer.from(JSON.stringify(index));
const len = Buffer.alloc(4); len.writeUInt32LE(hdr.length);
const pack = Buffer.concat([len, hdr, ...bufs]);

// --- signature fonts
const fonts = [
  ['Dancing Script', '@fontsource/dancing-script/files/dancing-script-latin-400-normal.woff2'],
  ['Great Vibes', '@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff2'],
  ['Sacramento', '@fontsource/sacramento/files/sacramento-latin-400-normal.woff2'],
  ['Caveat', '@fontsource/caveat/files/caveat-latin-400-normal.woff2'],
];
const fontCss = fonts.map(([fam, file]) =>
  `@font-face{font-family:"${fam}";font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${read(nm(file)).toString('base64')}) format("woff2")}`).join('\n');

const libs = [
  ['lib-pdfjs', pdfjs], ['lib-pdfjs-worker', worker], ['lib-pdflib', pdflib], ['lib-pdfdata', pack],
].map(([id, b]) => `<script type="application/x-gzip-base64" id="${id}">\n${gzB64(b)}</script>`).join('\n');

let html = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
if (js.includes('</script')) throw new Error('app.js contains </script');
const put = (marker, value) => {
  if (!html.includes(marker)) throw new Error('Marker missing: ' + marker);
  html = html.split(marker).join(value);
};
put('/*@FONTS@*/', fontCss);
put('/*@STYLE@*/', css);
put('<!--@LIBS@-->', libs);
put('/*@APP@*/', js);
put('@PDFJS_VERSION@', pdfjsVersion);
put('@PDFLIB_VERSION@', pdflibVersion);

const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? process.argv[outArg + 1] : path.join(root, 'dist/pdf-signer.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Built ${out} (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB) · pdf.js ${pdfjsVersion} · pdf-lib ${pdflibVersion} · ${entries.length} data files`);
