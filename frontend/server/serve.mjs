import console from 'node:console';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL, URL } from 'node:url';
import { bridgeOptionsFromEnv } from './bridge-env.mjs';
import { createBridge } from './bridge.mjs';
import { readMediaCredentials } from './media/config.mjs';
import { createMediaService } from './media/middleware.mjs';
import { createPromoService } from './promo/service.mjs';

const SECRET_FILES = [
  'CLOVASTUDIO_API_KEY', 'NCP_APIGW_KEY_ID', 'NCP_APIGW_KEY',
  'SENS_SMS_SERVICE_ID', 'SENS_SMS_SENDER_NUMBER', 'NAVIS_REPLY_TEST_TARGETS',
];

export function readServiceEnv(env = process.env, secretsDir = '/run/secrets') {
  const settings = { ...env };
  for (const name of SECRET_FILES) {
    delete settings[name];
    try {
      settings[name] = readFileSync(join(secretsDir, name), 'utf8').trim() || undefined;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read Navis secret file ${name}`, { cause: error });
    }
  }
  delete settings.NAVIS_CLOVASPEECH_INVOKE_URL;
  delete settings.NAVIS_CLOVASPEECH_SECRET;
  if (settings.NAVIS_CLOVASPEECH_PROVIDER === 'live') Object.assign(settings, readMediaCredentials('speech', secretsDir));
  if (settings.NAVIS_CLOVA_OCR_PROVIDER === 'live') Object.assign(settings, readMediaCredentials('receipt', secretsDir));
  return settings;
}

function createOriginCheck(value = '') {
  const origins = new Map();
  for (const item of value.split(',')) {
    const origin = item.trim();
    try {
      const url = new URL(origin);
      if (origin !== url.origin || origin.includes('*')) continue;
      const loopbackHttp = url.protocol === 'http:' && url.hostname === '127.0.0.1';
      if (url.protocol === 'https:' || loopbackHttp) origins.set(origin, url.host);
    } catch { /* Invalid configuration adds no access. */ }
  }

  return req => {
    const { host, origin, 'sec-fetch-site': site } = req.headers;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (!host || site && site !== 'same-origin') return false;
    // Direct loopback is for local operation. Proxied requests must match a configured origin.
    const loopback = req.socket.remoteAddress === '127.0.0.1' && host === `127.0.0.1:${req.socket.localPort}`;
    if (origin !== undefined) return origins.get(origin) === host || loopback && origin === `http://${host}`;
    return read && (loopback || site === 'same-origin' && [...origins.values()].includes(host));
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }).end(JSON.stringify(payload));
}

export function createNavisServer({ env = process.env, secretsDir, mediaFetch } = {}) {
  const settings = readServiceEnv(env, secretsDir);
  const portSetting = settings.NAVIS_PORT ?? '8787';
  const port = Number(portSetting);
  if (!/^\d+$/.test(portSetting) || port > 65535) throw new Error('Invalid NAVIS_PORT');

  const options = bridgeOptionsFromEnv(settings);
  const originAllowed = createOriginCheck(options.allowedOrigins);
  const liveAgent = settings.NAVIS_AGENT_PROVIDER === 'live' && Boolean(options.apiKey);
  const liveWidgets = options.widgets.mode === 'moa';
  const livePromo = settings.NAVIS_PROMO_HCX_PILOT === 'true' || settings.NAVIS_PROMO_SCENE_PROVIDER === 'naver';
  const media = createMediaService({ originAllowed, env: settings, liveFetch: mediaFetch });
  const promo = createPromoService({
    originAllowed,
    env: { ...settings, CLOVASTUDIO_API_KEY: livePromo ? settings.CLOVASTUDIO_API_KEY : undefined },
    lazyTools: true,
    // The hosted demo serves the bundled catalog and previews without running video jobs.
    ...(!livePromo && { tools: {} }),
  });
  const bridge = createBridge({
    ...options, originAllowed,
    apiKey: undefined,
    agentMode: liveAgent ? 'live' : 'fixture',
    agentApiKey: liveAgent ? options.apiKey : undefined,
    widgetApiKey: liveWidgets ? options.apiKey : null,
    widgets: liveWidgets ? options.widgets : { mode: options.widgets.mode },
  });
  const middlewares = [media, promo, bridge];

  let ready = false;
  let closing;
  promo.ready.then(() => { ready = true; }, () => console.error('Navis promo state failed to initialize'));
  const server = createServer((req, res) => {
    const path = req.url?.split('?', 1)[0];
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/healthz' || path === '/readyz')) {
      const healthy = path === '/healthz' || ready && !closing;
      return sendJson(res, healthy ? 200 : 503, { service: 'navis', status: healthy ? 'ok' : 'unavailable' });
    }
    const notFound = () => sendJson(res, 404, { code: 'NOT_FOUND' });
    if (!path?.startsWith('/api/navis/') && !path?.startsWith('/api/promo/')) return notFound();
    const dispatch = async index => {
      const middleware = middlewares[index];
      return middleware ? middleware(req, res, () => dispatch(index + 1)) : notFound();
    };
    dispatch(0).catch(() => {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) res.destroy();
      else sendJson(res, 503, { code: 'UNAVAILABLE' });
    });
  });

  return {
    ready: promo.ready,
    async listen() {
      server.listen(port, '0.0.0.0');
      await once(server, 'listening');
      return server.address();
    },
    close() {
      if (closing) return closing;
      const drained = new Promise(resolve => { server.close(() => resolve()); });
      const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
      deadline.unref();
      const cleanup = async () => {
        const settled = await Promise.allSettled([bridge, promo, media].map(async middleware => middleware.close()));
        await drained;
        clearTimeout(deadline);
        if (settled.some(result => result.status === 'rejected')) throw new Error('Navis middleware shutdown failed');
      };
      closing = cleanup();
      return closing;
    },
  };
}

async function main() {
  const service = createNavisServer();
  const shutdown = () => {
    service.close().catch(() => {
      console.error('Navis shutdown failed');
      process.exitCode = 1;
    });
  };
  try {
    const { port } = await service.listen();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    console.info(`Navis listening on port ${port}`);
  } catch (error) {
    await service.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Navis startup failed');
    process.exitCode = 1;
  });
}
