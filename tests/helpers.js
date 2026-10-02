// Test helpers injected into the app page during automated testing (not part of the product).
window.T = {
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async fx(name) {
    if (!window.__fx?.[name]) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/fx/' + name + '.js'; s.onload = res; s.onerror = rej; document.head.append(s); });
    const bin = atob(__fx[name]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  },
  async open(name) {
    const u = await this.fx(name);
    const dt = new DataTransfer(); dt.items.add(new File([u], name, { type: 'application/pdf' }));
    const inp = document.getElementById('pdfInput'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    for (let i = 0; i < 100; i++) { await this.sleep(100); if (document.title.startsWith(name)) break; }
    await this.sleep(400);
  },
  pe(type, target, x, y, o = {}) {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: o.id || 1, pointerType: o.type || 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, pressure: type === 'pointerup' ? 0 : 0.5 }));
  },
  async drag(target, pts, o = {}) {
    const [x0, y0] = pts[0]; this.pe('pointerdown', target, x0, y0, o);
    for (const [x, y] of pts.slice(1)) { this.pe('pointermove', document.elementFromPoint(x, y) || target, x, y, o); await this.sleep(o.delay ?? 8); }
    const [xl, yl] = pts[pts.length - 1]; this.pe('pointerup', document.elementFromPoint(xl, yl) || target, xl, yl, o);
    await this.sleep(30);
  },
  path(x0, y0, x1, y1, n = 12) { return Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); },
  center(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; },
  // capture downloads instead of saving them
  hookDownloads() {
    if (window.__dl) return; window.__dl = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (b) { const u = orig.call(URL, b); if (b && b.type === 'application/pdf') window.__dl.push(b); return u; };
    HTMLAnchorElement.prototype.click = function () { if (!this.download) return HTMLElement.prototype.click.call(this); };
  },
  async lastDownloadBytes() { const b = window.__dl[window.__dl.length - 1]; return new Uint8Array(await b.arrayBuffer()); },
  // render a page of a PDF (bytes) at scale 1 and return a canvas
  async renderPdfPage(bytes, n, scale = 1) {
    const task = pdfjsLib.getDocument({ data: bytes.slice() }); const doc = await task.promise;
    const pg = await doc.getPage(n); const vp = pg.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await pg.render({ canvas: c, viewport: vp, background: '#fff' }).promise;
    const info = { numPages: doc.numPages, w: vp.width, h: vp.height };
    await task.destroy();
    return { c, info };
  },
  // bounding box of "ink" pixels matching a predicate, in canvas px
  inkBox(c, pred) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (pred(d[i], d[i + 1], d[i + 2], d[i + 3])) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return n ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, n } : null;
  },
  isMagenta: (r, g, b) => r > 200 && g < 60 && b > 200,
  // a solid magenta PNG with a 2px transparent margin - easy to find in renders
  magentaPng(w = 200, h = 80) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  },
};
'helpers loaded';
