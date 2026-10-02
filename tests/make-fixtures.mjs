// Generates tricky PDFs used to verify placement accuracy of the signer.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFNumber, PDFArray, PDFRawStream, pushGraphicsState } = require('pdf-lib');
const cantoo = require('@cantoo/pdf-lib');

const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'fixtures');
fs.mkdirSync(out, { recursive: true });

// Draws a labelled grid in *displayed* coordinates so a human/screenshot can verify positions.
function grid(page, font, label) {
  const { width, height } = page.getSize();
  for (let x = 0; x <= width; x += 50) page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: x % 100 ? 0.3 : 0.8, color: rgb(0.75, 0.8, 0.9) });
  for (let y = 0; y <= height; y += 50) page.drawLine({ start: { x: 0, y }, end: { x: width, y }, thickness: y % 100 ? 0.3 : 0.8, color: rgb(0.75, 0.8, 0.9) });
  page.drawText(label, { x: 40, y: height - 60, size: 22, font, color: rgb(0.1, 0.1, 0.3) });
  page.drawText('Sign here:', { x: 60, y: 120, size: 14, font });
  page.drawLine({ start: { x: 140, y: 118 }, end: { x: 360, y: 118 }, thickness: 1, color: rgb(0, 0, 0) });
}

async function multiSize() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  grid(doc.addPage([595.28, 841.89]), font, 'Page 1 — A4 portrait');
  grid(doc.addPage([792, 612]), font, 'Page 2 — Letter landscape');
  grid(doc.addPage([300, 420]), font, 'Page 3 — small');
  fs.writeFileSync(path.join(out, 'multi-size.pdf'), await doc.save());
}

async function rotated() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const r of [0, 90, 180, 270]) {
    const p = doc.addPage([595.28, 841.89]);
    grid(p, font, `Rotate ${r}`);
    p.setRotation(degrees(r));
  }
  // page whose CropBox does not start at 0,0
  const c = doc.addPage([800, 900]);
  grid(c, font, 'CropBox offset (100,150)');
  c.setCropBox(100, 150, 500, 600);
  c.drawText('visible area origin', { x: 105, y: 155, size: 10, font });
  // rotated + cropped
  const d = doc.addPage([800, 900]);
  grid(d, font, 'Rotate 90 + CropBox');
  d.setCropBox(50, 100, 600, 700);
  d.setRotation(degrees(90));
  fs.writeFileSync(path.join(out, 'rotated-cropped.pdf'), await doc.save());
}

// Page content that leaves the CTM scaled/translated (no q/Q) — naive appenders draw in the wrong place.
async function messyState() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595.28, 841.89]);
  grid(p, font, 'Unbalanced graphics state');
  const raw = doc.context.flateStream('0.5 0 0 0.5 200 300 cm 1 0 0 RG 4 w 0 0 m 100 100 l S');
  p.node.addContentStream(doc.context.register(raw));
  fs.writeFileSync(path.join(out, 'messy-state.pdf'), await doc.save());
}

async function big() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 300; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`Page ${i} of 300`, { x: 50, y: 780, size: 26, font });
    for (let l = 0; l < 30; l++) p.drawText(`Line ${l + 1}: the quick brown fox jumps over the lazy dog ${i}-${l}`, { x: 50, y: 730 - l * 20, size: 11, font });
  }
  fs.writeFileSync(path.join(out, 'big-300-pages.pdf'), await doc.save());
}

async function encrypted() {
  for (const [name, opts] of [['encrypted-owner-only.pdf', { ownerPassword: 'owner123', userPassword: '' }], ['encrypted-user-pw.pdf', { ownerPassword: 'owner123', userPassword: 'test123' }]]) {
    const doc = await cantoo.PDFDocument.create();
    const font = await doc.embedFont(cantoo.StandardFonts.Helvetica);
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(name + ' — protected document', { x: 50, y: 780, size: 18, font });
    p.drawText('Sign here: ______________________', { x: 60, y: 120, size: 14, font });
    doc.encrypt({ ...opts, permissions: { printing: 'highResolution', modifying: false, copying: false } });
    fs.writeFileSync(path.join(out, name), await doc.save());
  }
}

await multiSize(); await rotated(); await messyState(); await big(); await encrypted();
console.log(fs.readdirSync(out).map(f => `${f} ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)}KB`).join('\n'));
