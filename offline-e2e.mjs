// End-to-end test of the built single file opened from disk (file://) with networking disabled.
// Runs in real Chrome and Edge (headless) and verifies the downloaded signed PDF with pdf-lib.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const { PDFDocument, PDFName } = require('pdf-lib');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist/pdf-signer.html');
const fileUrl = 'file:///' + target.replace(/\\/g, '/') + '#debug';
const fixture = path.join(root, 'tests/fixtures/wesearch-guide.pdf');
const browsers = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};

async function run(name, exe) {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-dl-'));
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
  const result = { browser: name };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }).catch(() => cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }));
    const requests = [], errors = [];
    page.on('request', r => requests.push(r.url().slice(0, 60)));
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.setOfflineMode(true);
    await page.goto(fileUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!globalThis.pdfjsLib, { timeout: 20000 });
    await new Promise(r => setTimeout(r, 300));
    result.worker = await page.evaluate(() => (globalThis.pdfjsLib.GlobalWorkerOptions.workerPort ? 'real worker' : globalThis.pdfjsWorker ? 'main-thread fallback' : 'none'));

    // open the PDF through the real file input
    const input = await page.$('#pdfInput');
    await input.uploadFile(fixture);
    await page.waitForFunction(() => document.title.startsWith('wesearch-guide.pdf'), { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.page.ready').length > 0, { timeout: 20000 });
    result.pages = await page.evaluate(() => document.querySelectorAll('.page').length);

    // create a typed signature through the UI and add it
    await page.click('#newSigBtn');
    await page.waitForSelector('.tab[data-tab=type]');
    await page.click('.tab[data-tab=type]');
    await page.type('.modal .text-input', 'Jayesh Karma');
    await page.click('.font-opt[data-font=dancing]');
    await page.click('[data-act=create]');
    await page.waitForFunction(() => window.__signer.S.items.length === 1);
    // add a date as well
    await page.click('#addDateBtn');
    await page.waitForFunction(() => window.__signer.S.items.length === 2);
    const items = await page.evaluate(() => window.__signer.S.items.map(i => ({ type: i.type, page: i.page, x: i.x, y: i.y, w: i.w, h: i.h })));

    // download
    await page.click('#downloadBtn');
    let file = null;
    for (let i = 0; i < 100 && !file; i++) {
      await new Promise(r => setTimeout(r, 150));
      file = fs.readdirSync(dl).find(f => f.endsWith('.pdf'));
    }
    if (!file) throw new Error('No download produced');
    await new Promise(r => setTimeout(r, 300));
    const bytes = fs.readFileSync(path.join(dl, file));
    const doc = await PDFDocument.load(bytes);
    const p1 = doc.getPage(0);
    const xobjects = p1.node.Resources().lookup(PDFName.of('XObject'));
    result.download = { file, kb: Math.round(bytes.length / 1024), pages: doc.getPageCount(), page1Images: xobjects ? xobjects.keys().length : 0 };
    result.items = items.map(i => `${i.type}@p${i.page}`).join(', ');
    result.done = await page.evaluate(() => document.querySelector('.modal .dn')?.textContent);

    // refresh: the document, its items and the signed copy must still be there
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__signer?.S.pdf && window.__signer.S.items.length > 0, { timeout: 20000 });
    result.afterRefresh = await page.evaluate(async () => ({
      title: document.title,
      items: window.__signer.S.items.length,
      signedCopies: (await window.__signer.DB.all('signed')).length,
      savedSignatures: (await window.__signer.DB.all('sigs')).length,
    }));
    result.nonLocalRequests = requests.filter(u => !/^(file|data|blob):/.test(u));
    result.errors = errors;
  } finally {
    await browser.close();
    fs.rmSync(dl, { recursive: true, force: true });
  }
  return result;
}

for (const [name, exe] of Object.entries(browsers)) {
  if (!fs.existsSync(exe)) { console.log(name, 'not installed'); continue; }
  try { console.log(JSON.stringify(await run(name, exe), null, 2)); }
  catch (e) { console.log(name, 'FAILED:', e.message); }
}
