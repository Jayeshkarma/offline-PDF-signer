// Which worker flavours do browsers allow on a file:// page with our CSP?
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob: data:"><script>
window.probe = async () => {
  const code = 'self.onmessage = e => self.postMessage("pong:" + e.data);';
  const test = (mk) => new Promise(res => { let w; try { w = mk(); } catch (e) { return res('throw ' + e.name); }
    const t = setTimeout(() => res('timeout'), 3000);
    w.onmessage = e => { clearTimeout(t); res('ok ' + e.data); }; w.onerror = e => { clearTimeout(t); res('error'); }; w.postMessage(1); });
  return {
    blobClassic: await test(() => new Worker(URL.createObjectURL(new Blob([code], {type: 'text/javascript'})))),
    blobModule: await test(() => new Worker(URL.createObjectURL(new Blob([code], {type: 'text/javascript'})), {type: 'module'})),
    dataClassic: await test(() => new Worker('data:text/javascript;base64,' + btoa(code))),
    dataModule: await test(() => new Worker('data:text/javascript;base64,' + btoa(code), {type: 'module'})),
  };
};</script>`;
const f = path.join(os.tmpdir(), 'probe-workers.html'); fs.writeFileSync(f, html);
for (const [name, exe] of [['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'], ['edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
  const b = await puppeteer.launch({ executablePath: exe, headless: true });
  const p = await b.newPage(); await p.goto('file:///' + f.replace(/\\/g, '/'));
  console.log(name, await p.evaluate(() => window.probe()));
  await b.close();
}
