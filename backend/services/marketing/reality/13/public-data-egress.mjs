import { createServer } from 'node:http';
import { connect } from 'node:net';

const destinations = new Map([
  ['bizinfo', { host: 'www.bizinfo.go.kr', port: 443 }],
  ['seoul', { host: 'openapi.seoul.go.kr', port: 8088 }],
]);
const destination = destinations.get(process.env.NAVIS_PUBLIC_DATA_EGRESS);
if (!destination) throw new Error('Unknown public data egress workload');

createServer((_request, response) => response.writeHead(403).end())
  .on('connect', (request, client, head) => {
    client.on('error', () => client.destroy());
    if (request.url !== `${destination.host}:${destination.port}`) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(destination, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    upstream.setTimeout(20_000, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  })
  .listen(3128, '0.0.0.0');
