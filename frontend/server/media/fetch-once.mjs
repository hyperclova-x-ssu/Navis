import { request } from 'node:https';
import { Readable } from 'node:stream';

export async function fetchMediaOnce(url, init) {
  // Serialize the multipart boundary before opening a single HTTPS request.
  const wire = new Request(url, init);
  const body = Buffer.from(await wire.arrayBuffer());
  init.signal.throwIfAborted();
  wire.headers.set('Content-Length', String(body.length));
  const response = await new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: wire.method, headers: Object.fromEntries(wire.headers), signal: init.signal, agent: false,
    }, resolve);
    outgoing.once('error', reject);
    outgoing.end(body);
  });
  const { statusCode: status, headers } = response;
  const withoutBody = status === 204 || status === 205 || status === 304;
  if (withoutBody) response.resume();
  return new Response(withoutBody ? null : Readable.toWeb(response), { status, headers });
}
