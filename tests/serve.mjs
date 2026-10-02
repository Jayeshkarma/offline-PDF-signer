// Tiny static server used only for automated testing (the product itself needs no server).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const types = { '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.js': 'text/javascript' };
const port = +process.env.PORT || 5174;
http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // test-only: deliver a fixture as a script, because the app's CSP blocks fetch()
  const fx = rel.match(/^\/fx\/(.+)\.js$/);
  if (fx) {
    const f = path.join(root, 'tests/fixtures', fx[1]);
    if (!f.startsWith(path.join(root, 'tests/fixtures')) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(`(window.__fx=window.__fx||{})[${JSON.stringify(fx[1])}]=${JSON.stringify(fs.readFileSync(f).toString('base64'))};`);
    return;
  }
  const file = path.join(root, rel === '/' ? 'dist/pdf-signer.html' : rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('serving ' + root + ' on http://localhost:' + port));
