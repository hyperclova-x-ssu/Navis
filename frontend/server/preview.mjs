import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBridge } from './bridge.mjs';
import { createMediaService } from './media/middleware.mjs';
import { parseAllowedOrigins } from './private-origin.mjs';
import { createPromoService } from './promo/service.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export async function startPreview({ root = 'dist', port = 4173, bridgeOptions = {}, promoOptions, mediaOptions } = {}) {
  const base = await realpath(resolve(root));
  const allowedOrigins = parseAllowedOrigins(bridgeOptions.allowedOrigins);
  const bridge = createBridge(bridgeOptions);
  const media = createMediaService({ ...mediaOptions, allowedOrigins });
  const promo = createPromoService({ ...promoOptions, allowedOrigins });
  const close = () => { bridge.close(); promo.close(); media.close(); };
  const server = createServer((req, res) => {
    media(req, res, () => promo(req, res, () => bridge(req, res, async () => {
      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || req.socket.localAddress !== '127.0.0.1') { res.writeHead(403).end(); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      let path;
      try { path = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400).end(); return; }
      if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..') || path.startsWith('/api')) { res.writeHead(404).end(); return; }
      try {
        let file = resolve(base, `.${path === '/' ? '/index.html' : path}`);
        if (file !== base && !file.startsWith(base + sep)) throw new Error('invalid path');
        try { file = await realpath(file); } catch { if (extname(path)) throw new Error('not found'); file = await realpath(resolve(base, 'index.html')); }
        if (!file.startsWith(base + sep)) throw new Error('invalid path');
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : data);
      } catch { res.writeHead(404).end(); }
    })));
  });
  server.once('close', close);
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  server.stop = () => { close(); server.close(); server.closeAllConnections(); };
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { readBridgeEnv } = await import('./vite-plugin.mjs');
  const root = process.argv[2] || 'dist';
  const port = process.env.PORT ? Number(process.env.PORT) : 4173;
  const bridgeOptions = readBridgeEnv({ root: process.cwd(), mode: 'production' });
  const server = await startPreview({ root, port, bridgeOptions });
  process.stdout.write(`Navis preview: http://127.0.0.1:${server.address().port}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.stop());
}
