/* global URL, window, document */
// Minimal isolated recorder (ARCHITECTURE 12.8·12.9 conventions) used by the T-084 tools
// until/unless T-082's recorder is wired in. Same rules: page at https://render.invalid/,
// every request intercepted and served from memory (allow-list), CSP, blocked proxy,
// forbidden APIs replaced by recorders, frame-by-frame time seeking of document.getAnimations().
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FONTS_DIR, findChrome, loadFonts, loadPlaywright, photoFileMap } from './env.mjs';

export const ORIGIN = 'https://render.invalid';
export const CSP =
  "default-src 'none'; img-src https://render.invalid; font-src https://render.invalid; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'";

// Runs in the page before any scene code. Replaces forbidden APIs with functions that only record.
// eval / new Function are not stubbed (the driver needs them in the main world); the CSP blocks them
// for page scripts (EvalError -> runtime.error) and the static check rejects them.
export const INIT_SCRIPT = `(() => {
  const list = [];
  const rec = (name) => { if (list.length < 200) list.push(name); };
  Object.defineProperty(window, '__navisForbidden', { value: () => list.slice(), writable: false, configurable: false });
  const stub = (obj, name, label, ret) => {
    try {
      Object.defineProperty(obj, name, { configurable: false, writable: false,
        value: function () { rec(label); return typeof ret === 'function' ? ret() : ret; } });
    } catch (e) { rec('stub-failed:' + label); }
  };
  for (const n of ['setTimeout','setInterval','requestAnimationFrame','requestIdleCallback','fetch','open']) stub(window, n, n, 0);
  for (const n of ['XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker','RTCPeerConnection','webkitRTCPeerConnection']) stub(window, n, n, undefined);
  const RealDate = Date;
  const FakeDate = function () { rec('Date'); return new RealDate(0); };
  FakeDate.now = function () { rec('Date.now'); return 0; };
  FakeDate.UTC = RealDate.UTC; FakeDate.parse = function () { rec('Date.parse'); return 0; };
  Object.defineProperty(window, 'Date', { value: FakeDate, configurable: false, writable: false });
  stub(Math, 'random', 'Math.random', 0.5);
  stub(performance, 'now', 'performance.now', 0);
  try { stub(Navigator.prototype, 'sendBeacon', 'navigator.sendBeacon', false); } catch (e) {}
  for (const n of ['localStorage','sessionStorage','indexedDB']) {
    try { Object.defineProperty(window, n, { configurable: false, get() { rec(n); return undefined; } }); } catch (e) { rec('stub-failed:' + n); }
  }
  try { Object.defineProperty(Document.prototype, 'cookie', { configurable: false, get() { rec('document.cookie'); return ''; }, set() { rec('document.cookie'); } }); } catch (e) {}
  try { Object.defineProperty(navigator, 'serviceWorker', { configurable: false, get() { rec('ServiceWorker'); return undefined; } }); } catch (e) {}
  try { HTMLFormElement.prototype.submit = function () { rec('form.submit'); }; } catch (e) {}
})();`;

export function fontFaceCss(fonts) {
  return fonts.faces
    .map(
      (f) =>
        `@font-face{font-family:"${f.family}";src:url("${ORIGIN}/${fonts.urlPrefix}${f.file}") format("${f.format}");font-weight:${f.weight};font-style:${f.style};font-display:block;}`,
    )
    .join('');
}

export function injectFonts(html, fonts) {
  const tag = `<style id="__navis_fonts">${fontFaceCss(fonts)}</style>`;
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  return tag + html;
}

/**
 * Open a scene in an isolated Chrome page.
 * @param {{html:string, story:object, catalog:object, scale?:number, chromePath?:string}} opts
 */
export async function openScene(opts) {
  const pw = await loadPlaywright();
  if (!pw) throw Object.assign(new Error('playwright-core not available'), { code: 'TOOL_MISSING' });
  const executablePath = opts.chromePath ?? findChrome();
  if (!executablePath) throw Object.assign(new Error('Chrome not found'), { code: 'TOOL_MISSING' });
  const fonts = loadFonts();
  const photos = photoFileMap(opts.catalog);
  const allowedPhotos = new Set(['store-exterior']);
  for (const s of opts.story.scenes) for (const id of s.photoIds ?? []) allowedPhotos.add(id);
  const fontFiles = new Set(fonts.faces.map((f) => f.file));
  const html = injectFonts(opts.html, fonts);
  const records = { errors: [], console: [], blocked: [] };
  const cache = new Map();
  const bytes = (p) => {
    if (!cache.has(p)) cache.set(p, readFileSync(p));
    return cache.get(p);
  };

  const browser = await pw.chromium.launch({
    executablePath,
    headless: true,
    proxy: { server: 'http://127.0.0.1:9' },
    args: [
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--hide-scrollbars',
      '--font-render-hinting=none',
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      deviceScaleFactor: opts.scale ?? 2 / 3,
      serviceWorkers: 'block',
      acceptDownloads: false,
      permissions: [],
      javaScriptEnabled: true,
      reducedMotion: 'no-preference',
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });
    context.setDefaultTimeout(10_000);
    await context.addInitScript(INIT_SCRIPT);
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN) {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': CSP }, body: html });
        }
        if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
        let m = /^\/assets\/photos\/([a-z0-9-]{1,32})\.jpg$/.exec(url.pathname);
        if (m && allowedPhotos.has(m[1]) && photos.has(m[1])) {
          return route.fulfill({ status: 200, contentType: 'image/jpeg', body: bytes(photos.get(m[1]).path) });
        }
        m = /^\/fonts\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
        if (m && fontFiles.has(m[1])) {
          return route.fulfill({ status: 200, contentType: m[1].endsWith('.woff2') ? 'font/woff2' : 'font/ttf', body: bytes(path.join(FONTS_DIR, m[1])) });
        }
      }
      records.blocked.push(url.href.slice(0, 200));
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => records.errors.push(String(e?.message ?? e).slice(0, 300)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') records.console.push(msg.text().slice(0, 300));
    });
    page.on('popup', (p) => p.close().catch(() => {}));
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 10_000 });
    await page.evaluate(async () => {
      const faces = ['400 48px "Navis Sans"', '700 48px "Navis Sans"', '800 48px "Navis Sans"', '400 48px "Navis Serif"'];
      await Promise.all(faces.map((f) => document.fonts.load(f, '가A1').catch(() => null)));
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => (img.complete ? img.decode().catch(() => null) : new Promise((r) => { img.onload = img.onerror = r; }))));
    });
    const duration = await page.evaluate(() => window.__duration);

    async function seek(t) {
      await page.evaluate((tt) => {
        if (typeof window.__onFrame === 'function') window.__onFrame(tt);
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = tt * 1000;
        }
      }, t);
    }
    async function shot(o = {}) {
      return page.screenshot({ type: o.type ?? 'jpeg', quality: o.type === 'png' ? undefined : (o.quality ?? 92), scale: 'device', animations: 'allow', caret: 'initial' });
    }
    async function forbidden() {
      return page.evaluate(() => (typeof window.__navisForbidden === 'function' ? window.__navisForbidden() : ['recorder-missing']));
    }
    return { page, browser, records, duration, seek, shot, forbidden, close: () => browser.close() };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
