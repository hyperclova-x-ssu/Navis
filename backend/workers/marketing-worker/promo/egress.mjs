import { createServer } from 'node:http';
import { connect } from 'node:net';

const providers = new Map([
  ['clovastudio.stream.ntruss.com:443', 'clovastudio.stream.ntruss.com'],
]);
if (process.env.NAVIS_PROMO_CLAUDE_API_APPROVED === 'true') providers.set('api.anthropic.com:443', 'api.anthropic.com');

createServer((_request, response) => response.writeHead(403).end())
  .on('connect', (request, client, head) => {
    const host = providers.get(request.url);
    client.on('error', () => client.destroy());
    if (!host) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect({ host, port: 443 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    upstream.setTimeout(240_000, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  })
  .listen(3128, '0.0.0.0');
