import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { expect, it } from 'vitest';
import { allowWorkloadReads } from './workload-read.ts';

it('accepts the distinct credential only for configured GET routes and retains scope validation', async () => {
  const app = Fastify();
  const root = '/internal/v1/customer/stores/:storeId';
  const gateway = 'gateway-test-fixture';
  const reader = 'insight-test-fixture';
  allowWorkloadReads(app, gateway, reader, root, ['/calendar/events'], []);
  const handle = async (req: FastifyRequest<{ Params: { storeId: string } }>, reply: FastifyReply) => {
    if (req.headers.authorization !== `Bearer ${gateway}`) return reply.code(401).send();
    if (req.headers['x-navis-store-id'] !== req.params.storeId) return reply.code(403).send();
    return { items: [] };
  };
  app.get(root + '/calendar/events', handle);
  app.post(root + '/calendar/events', handle);
  app.get(root + '/calendar/events/:id', handle);
  const base = '/internal/v1/customer/stores/synthetic/calendar/events';
  const headers = { authorization: `Bearer ${reader}`, 'x-navis-store-id': 'synthetic' };
  try {
    expect((await app.inject({ method: 'GET', url: base, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: base, headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: base + '/unlisted', headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: base,
      headers: { ...headers, 'x-navis-store-id': 'other' } })).statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
