import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { expect, it } from 'vitest';
import { createGateway } from './app.ts';

it('delivers a browser chat heartbeat before the Navis upstream completes', async () => {
  const comment = ': keep-alive\n\n';
  const doneFrame = 'event: done\ndata: {}\n\n';
  const origin = 'https://demo.example';
  const { promise: finish, resolve: finishUpstream } = Promise.withResolvers<void>();
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-navis-protocol': 'agent-v1' });
    res.write(comment);
    void finish.then(() => res.end(doneFrame));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing Navis test port');

  const app = createGateway({
    accountUrl: 'http://account.invalid', inventoryUrl: 'http://inventory.invalid',
    accountToken: 'test-account', inventoryToken: 'test-inventory', logging: false,
    browserApis: { origin, navisUrl: `http://127.0.0.1:${address.port}`,
      marketingUrl: 'http://marketing.invalid', marketingToken: 'test-marketing' },
  });
  try {
    const gateway = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = request(`${gateway}/api/navis/chat`, {
      method: 'POST', headers: { host: 'demo.example', origin, 'content-type': 'application/json', 'content-length': '2' },
      signal: AbortSignal.timeout(5_000),
    });
    const receiving = once(client, 'response');
    client.end('{}');
    const [reply] = await receiving;
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['content-type']).toBe('text/event-stream');
    expect(reply.headers['x-accel-buffering']).toBe('no');

    let raw = '';
    for await (const chunk of reply) {
      raw += chunk.toString();
      if (raw === comment) finishUpstream();
    }
    expect(raw).toBe(comment + doneFrame);
  } finally {
    finishUpstream();
    upstream.close();
    upstream.closeAllConnections();
    app.server.closeAllConnections();
    await app.close();
  }
});
