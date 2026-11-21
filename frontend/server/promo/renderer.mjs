// 격리 Chrome에서 생성 코드 한 장을 여는 곳 (ARCHITECTURE 12.8·12.9). 장면 검사기와 녹화기가 함께 쓴다.
// - 작업마다 새 Chrome(임시 프로필, headless), 막힌 프록시, WebRTC 비프록시 UDP 차단, 백그라운드 네트워크 끔
// - 페이지 주소 https://render.invalid/, 모든 요청을 가로채 허용 목록만 메모리에서 fulfill, 나머지는 abort·기록
// - 응답 헤더 CSP, 서비스 워커 차단, 다운로드 거부, 팝업 닫기, 금지 API 기록 스크립트
import { PromoError } from './errors.mjs';

export const ORIGIN = 'https://render.invalid';
export const CSP = "default-src 'none'; img-src https://render.invalid; font-src https://render.invalid; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const CHROME_ARGS = [
  '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--disable-background-networking',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-extensions', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
  '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--metrics-recording-only', '--mute-audio',
  '--font-render-hinting=none', '--hide-scrollbars',
];

// 생성 코드보다 먼저 도는 기록 스크립트: 금지 API를 실행하지 않고 이름만 남긴다.
export const INIT_SCRIPT = `(() => {
  const log = [];
  const note = name => { if (log.length < 200) log.push(name); };
  Object.defineProperty(window, '__navisForbidden', { value: () => log.slice(), configurable: false, writable: false });
  const fn = (obj, key, name, ret) => { try { Object.defineProperty(obj, key, { configurable: true, writable: true, value: function () { note(name); return typeof ret === 'function' ? ret() : ret; } }); } catch (e) {} };
  const ctor = (obj, key) => { try { Object.defineProperty(obj, key, { configurable: true, writable: true, value: function () { note(key); } }); } catch (e) {} };
  const getter = (obj, key, name) => { try { Object.defineProperty(obj, key, { configurable: true, get() { note(name); return undefined; }, set() { note(name); } }); } catch (e) {} };
  const NeverPromise = Promise;
  fn(window, 'setTimeout', 'setTimeout', 0); fn(window, 'setInterval', 'setInterval', 0);
  fn(window, 'requestAnimationFrame', 'requestAnimationFrame', 0); fn(window, 'requestIdleCallback', 'requestIdleCallback', 0);
  fn(window, 'fetch', 'fetch', () => new NeverPromise(() => {}));
  // eval은 바꾸지 않는다(Playwright evaluate가 씀). 페이지의 eval·new Function은 CSP(unsafe-eval 없음)가 막아 runtime.error가 된다.
  fn(window, 'open', 'window.open', null);
  fn(Math, 'random', 'Math.random', 0.5); fn(performance, 'now', 'performance.now', 0);
  for (const key of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection']) ctor(window, key);
  try { fn(Navigator.prototype, 'sendBeacon', 'navigator.sendBeacon', false); } catch (e) {}
  getter(window, 'localStorage', 'localStorage'); getter(window, 'sessionStorage', 'sessionStorage'); getter(window, 'indexedDB', 'indexedDB');
  getter(Navigator.prototype, 'serviceWorker', 'ServiceWorker');
  getter(Document.prototype, 'cookie', 'document.cookie');
  const RealDate = Date;
  const FakeDate = new Proxy(RealDate, { construct() { note('Date'); return new RealDate(0); }, apply() { note('Date'); return new RealDate(0).toString(); }, get(target, key) { if (key === 'now') return () => { note('Date'); return 0; }; return Reflect.get(target, key); } });
  try { Object.defineProperty(window, 'Date', { configurable: true, writable: true, value: FakeDate }); } catch (e) {}
  try { HTMLFormElement.prototype.submit = function () { note('form.submit'); }; HTMLFormElement.prototype.requestSubmit = function () { note('form.submit'); }; } catch (e) {}
})();`;

const fontType = f => (f.format === 'truetype' || /\.ttf$/.test(f.file) ? 'font/ttf' : /\.otf$/.test(f.file) ? 'font/otf' : /\.woff$/.test(f.file) ? 'font/woff' : 'font/woff2');

export function fontFaceCss(fonts) {
  return fonts.map(f => `@font-face{font-family:${JSON.stringify(f.family)};src:url("${ORIGIN}/fonts/${f.file}")${f.format ? ` format("${f.format}")` : ''};font-weight:${f.weight || 'normal'};font-style:${f.style || 'normal'};font-display:block}`).join('');
}

/** 녹화기가 넣는 머리: 글꼴과 기본 여백. 생성 코드의 스타일이 뒤에 오므로 덮어쓸 수 있다. */
export function injectHead(html, fonts) {
  const style = `<style data-navis-recorder>${fontFaceCss(fonts)}html,body{margin:0;padding:0;background:#000;overflow:hidden}</style>`;
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + style + html.slice(m.index + m[0].length);
  return style + html;
}

const withTimeout = (promise, ms, onTimeout) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new PromoError('TIMEOUT')); }, ms); })]).finally(() => clearTimeout(timer));
};

/**
 * @param {{html:string, assets: Map<string,{bytes:Buffer,type:string}>, fonts: Array, browserPath:string, scale?:number, opTimeoutMs?:number, chromium?:any}} options
 * assets 키는 "/assets/photos/<id>.jpg" 같은 경로. 글꼴은 fonts에서 "/fonts/<file>"로 넣는다.
 * opTimeoutMs는 페이지 불러오기 제한. 브라우저 띄우기는 부하가 있을 때를 위해 최소 15초(T-087).
 */
export async function openScene({ html, assets, fonts = [], browserPath, scale = 1, opTimeoutMs = 10000, chromium, readFont }) {
  const pw = chromium ?? (await import('playwright-core')).chromium;
  const allow = new Map(assets);
  for (const f of fonts) allow.set(`/fonts/${f.file}`, { bytes: await readFont(f.path), type: fontType(f) });
  const pageHtml = injectHead(html, fonts);
  let browser;
  try {
    browser = await pw.launch({ executablePath: browserPath, headless: true, args: CHROME_ARGS, timeout: Math.max(opTimeoutMs, 15000), env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: process.env.LANG || 'en_US.UTF-8' } });
  } catch { throw new PromoError('RENDER_FAILED'); }
  const log = { errors: [], blocked: [], navigations: 0, popups: 0 };
  try {
    const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: scale, serviceWorkers: 'block', acceptDownloads: false, permissions: [], javaScriptEnabled: true, reducedMotion: 'no-preference', locale: 'en-US', timezoneId: 'UTC' });
    await context.route('**/*', route => {
      const req = route.request();
      let url;
      try { url = new URL(req.url()); } catch { log.blocked.push('invalid'); return route.abort('blockedbyclient'); }
      if (url.origin === ORIGIN && (req.method() === 'GET' || req.method() === 'HEAD')) {
        if (url.pathname === '/' && req.isNavigationRequest()) {
          log.navigations++;
          if (log.navigations > 1) { log.blocked.push('navigation'); return route.abort('blockedbyclient'); }
          return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store' }, body: pageHtml });
        }
        if (url.pathname === '/favicon.ico') return route.fulfill({ status: 404, body: '' });
        const asset = allow.get(decodeURIComponent(url.pathname));
        if (asset && !url.search) return route.fulfill({ status: 200, headers: { 'content-type': asset.type, 'cache-control': 'no-store' }, body: asset.bytes });
      }
      log.blocked.push(url.origin === ORIGIN ? url.pathname.slice(0, 80) : `${url.protocol}//${url.host}`.slice(0, 80));
      return route.abort('blockedbyclient');
    });
    let first = null;
    context.on('page', p => { if (!first) { first = p; return; } log.popups++; log.blocked.push('popup'); p.close().catch(() => {}); });
    await context.addInitScript({ content: INIT_SCRIPT });
    const page = await context.newPage();
    page.setDefaultTimeout(opTimeoutMs);
    page.on('pageerror', err => { if (log.errors.length < 50) log.errors.push(`pageerror: ${String(err?.message || err).slice(0, 160)}`); });
    page.on('console', msg => { if (msg.type() === 'error' && log.errors.length < 50) log.errors.push(`console: ${msg.text().slice(0, 160)}`); });
    page.on('download', d => d.cancel().catch(() => {}));
    page.on('dialog', d => d.dismiss().catch(() => {}));
    const kill = () => { browser.close().catch(() => {}); };
    const op = (promise, ms = opTimeoutMs) => withTimeout(promise, ms, kill);
    try {
      await op(page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: opTimeoutMs }));
      await op(page.evaluate(() => document.fonts.ready.then(() => true)));
    } catch (err) {
      const code = err instanceof PromoError && err.code === 'TIMEOUT' ? 'TIMEOUT' : 'LOAD_FAILED';
      await closeQuietly(browser);
      return { ok: false, code, log };
    }
    return {
      ok: true, page, log,
      /** __onFrame(t)를 부른 뒤 모든 애니메이션을 멈추고 currentTime = t×1000. */
      seek: (t, ms = 500) => op(page.evaluate(time => {
        if (typeof window.__onFrame === 'function') window.__onFrame(time);
        for (const a of document.getAnimations()) { a.pause(); a.currentTime = time * 1000; }
        return true;
      }, t), Math.max(ms, 50)),
      evaluate: (fn, arg, ms) => op(page.evaluate(fn, arg), ms),
      screenshot: (ms = 2000) => op(page.screenshot({ type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1080, height: 1920 }, animations: 'allow', caret: 'initial', scale: 'device' }), ms),
      forbidden: () => page.evaluate(() => (typeof window.__navisForbidden === 'function' ? window.__navisForbidden() : ['__navisForbidden removed'])).catch(() => []),
      close: () => closeQuietly(browser),
    };
  } catch (err) {
    await closeQuietly(browser);
    if (err instanceof PromoError) throw err;
    throw new PromoError('RENDER_FAILED');
  }
}

async function closeQuietly(browser) {
  try { await withTimeout(browser.close(), 5000); } catch {}
}

/** 작업의 허용 목록: 장면 구성에 나온 사진(고른 사진)·외관. 사진 주소는 assets/photos/<photoId>.jpg. */
export async function photoAssets(photoSource, photoIds) {
  const map = new Map();
  for (const id of new Set(photoIds)) {
    const photo = await photoSource.readPhoto(id);
    if (photo) map.set(`/assets/photos/${id}.jpg`, { bytes: photo.bytes, type: photo.mediaType });
  }
  return map;
}
