export function parseAllowedOrigins(value) {
  const origins = new Map();
  if (typeof value !== 'string') return origins;
  for (const item of value.split(',')) {
    const origin = item.trim();
    try {
      const url = new URL(origin);
      // Accept serialized HTTPS origins only: no credentials, paths or wildcards.
      if (url.protocol !== 'https:' || url.origin !== origin || origin.includes('*')) continue;
      origins.set(origin, new Set([url.host, url.hostname]));
    } catch { /* Invalid configuration adds no access. */ }
  }
  return origins;
}

export function sameOrigin(req, allowedOrigins) {
  if (req.socket.localAddress !== '127.0.0.1') return false;
  const host = req.headers.host;
  if (host === `127.0.0.1:${req.socket.localPort}` && (!req.headers.origin || req.headers.origin === `http://${host}`)) return true;
  return allowedOrigins.get(req.headers.origin)?.has(host) ?? false;
}

export function privateOriginAllowed(req, origins) {
  if (req.socket.remoteAddress !== '127.0.0.1') return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  if (sameOrigin(req, origins)) return true;
  // Same-origin browser GETs omit Origin. Accept Fetch Metadata only on
  // an explicitly configured host behind the loopback private ingress.
  return req.socket.localAddress === '127.0.0.1' && req.method === 'GET' && !req.headers.origin
    && site === 'same-origin' && [...origins.values()].some(hosts => hosts.has(req.headers.host));
}
