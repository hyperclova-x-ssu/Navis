import { describe, expect, it } from 'vitest';
import { createApp } from './http.ts';

describe('health endpoints', () => {
  it('separates liveness from dependency readiness', async () => {
    const app = createApp('inventory', async () => { throw new Error('dependency down'); }, false);
    try {
      const live = await app.inject('/healthz');
      expect(live.json()).toEqual({ service: 'inventory', status: 'ok' });
      expect(live.statusCode).toBe(200);
      const ready = await app.inject('/readyz');
      expect(ready.json()).toEqual({ service: 'inventory', status: 'unavailable' });
      expect(ready.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('returns the ready state and preserves the edge request ID', async () => {
    const app = createApp('api-gateway', async () => {}, false);
    try {
      const requestId = 'a'.repeat(32);
      const res = await app.inject({ url: '/api/readyz', headers: { 'x-request-id': requestId } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ service: 'api-gateway', status: 'ready' });
      expect(res.headers['x-request-id']).toBe(requestId);
      expect((await app.inject('/internal/readyz')).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
