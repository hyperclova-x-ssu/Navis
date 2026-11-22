import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { FastifyInstance, HTTPMethods } from 'fastify';

type BrowserRoute = { method: HTTPMethods[]; url: string; bodyLimit: number };
type MiddlewareRequest = Readable & { url: string; method: string; headers: IncomingHttpHeaders; aborted: boolean };
type Middleware = {
  (req: MiddlewareRequest, res: ServerResponse, next: () => void): Promise<void>;
  close(): void | Promise<void>;
};

export const navisChatPath = '/api/navis/chat';
// Let Navis return its existing method errors for known paths.
const navisMethods: HTTPMethods[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
export const navisBrowserRoutes: BrowserRoute[] = [
  { url: navisChatPath, bodyLimit: 256 * 1024 },
  { url: '/api/navis/widget-drafts', bodyLimit: 2048 },
  { url: '/api/navis/reply-test-targets', bodyLimit: 2048 },
  { url: '/api/navis/reply-test-send', bodyLimit: 2048 },
  { url: '/api/navis/media/receipt-ocr', bodyLimit: 5_000_000 },
  { url: '/api/navis/media/transcription', bodyLimit: 10_000_000 },
].map(route => ({ ...route, method: navisMethods }));
export const promoBrowserRoutes: BrowserRoute[] = [
  { method: ['GET', 'HEAD', 'POST'], url: '/api/promo/*', bodyLimit: 16 * 1024 },
];

// Keep byte-for-byte bodies for the mounted middleware to validate, including binary uploads.
export function parseBrowserBodies(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const code = 'PAYLOAD_TOO_LARGE';
      return reply.code(413).send(req.url.startsWith('/api/navis/media/')
        ? { error: code, requestId: req.id }
        : { code });
    }
    throw error;
  });
}

export function mountBrowserMiddleware(app: FastifyInstance, token: string, routes: BrowserRoute[], middleware: Middleware) {
  const credential = Buffer.from(`Bearer ${token}`);
  app.register(async scope => {
    parseBrowserBodies(scope);
    scope.addHook('preClose', async () => middleware.close());
    scope.addHook('onRequest', async (req, reply) => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) {
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      }
    });
    for (const route of routes) {
      scope.route<{ Body?: Buffer }>({
        ...route, exposeHeadRoute: false,
        async handler(req, reply) {
          const input = Object.assign(Readable.from(req.body?.length ? [req.body] : []), {
            url: req.url, method: req.method, headers: req.headers,
          }) as MiddlewareRequest;
          Object.defineProperty(input, 'aborted', { get: () => req.raw.aborted || reply.raw.destroyed });
          reply.hijack();
          reply.raw.setHeader('x-request-id', req.id);
          try {
            await middleware(input, reply.raw, () => {
              reply.raw.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
                .end('{"code":"NOT_FOUND"}');
            });
          } catch {
            req.log.error('Browser API middleware failed');
            if (reply.raw.destroyed || reply.raw.writableEnded) return;
            if (reply.raw.headersSent) reply.raw.destroy();
            else reply.raw.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              .end('{"code":"SERVICE_UNAVAILABLE"}');
          }
        },
      });
    }
  });
}
