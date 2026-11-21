import { randomBytes } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { dbPool, type Service } from '../packages/db/index.ts';

type Probe = () => Promise<void>;
const healthSchema = {
  type: 'object',
  required: ['service', 'status'],
  properties: {
    service: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'ready', 'unavailable'] },
  },
} as const;

export function createApp(name: Service | 'api-gateway', checkReady: Probe, logging = true): FastifyInstance {
  const app = Fastify({
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (req) => {
      const id = req.headers['x-request-id'];
      return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? id : randomBytes(16).toString('hex');
    },
    ajv: { customOptions: { removeAdditional: false } },
    logger: logging ? {
      base: { service: name },
      redact: ['req.headers', 'res.headers', 'headers', 'authorization', 'cookie', '["set-cookie"]'],
      serializers: {
        req: (request: FastifyRequest) => ({ method: request.method }),
      },
    } : false,
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'NOT_FOUND' }));
  app.setErrorHandler((error, req, reply) => {
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ code: 'INVALID_REQUEST' });
    }
    req.log.error('Request handler failed');
    return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE' });
  });

  const liveOptions = { schema: { response: { 200: healthSchema } } };
  const liveHandler = async () => ({ service: name, status: 'ok' });
  app.get('/healthz', liveOptions, liveHandler);
  const readyHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await checkReady();
      return { service: name, status: 'ready' };
    } catch {
      return reply.code(503).send({ service: name, status: 'unavailable' });
    }
  };
  const readyOptions = { schema: { response: { 200: healthSchema, 503: healthSchema } } };
  app.get('/readyz', readyOptions, readyHandler);
  if (name === 'api-gateway') {
    app.get('/api/healthz', liveOptions, liveHandler);
    app.get('/api/readyz', readyOptions, readyHandler);
  }
  return app;
}

export async function listen(app: FastifyInstance): Promise<void> {
  const close = () => {
    void app.close().catch(() => {
      app.log.error('Server shutdown failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  try {
    await app.listen({ host: '0.0.0.0', port: 3000 });
  } catch {
    app.log.error('Server startup failed');
    await app.close();
    process.exitCode = 1;
  }
}

export async function startHealthService(service: Service): Promise<void> {
  const pool = dbPool(service);
  const app = createApp(service, async () => { await pool.query('SELECT 1'); });
  pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
  app.addHook('onClose', async () => pool.end());
  await listen(app);
}
