/**
 * T-072 server address (API 공통 약속 v5, ARCHITECTURE 14.6). The address comes only from `VITE_CNN_SERVER_URL`
 * (`04_app/.env.local`); there is no default address in code. Empty or missing = not configured.
 */

/** Normalised base address (no trailing `/`), or null when not configured or not an http(s) URL. */
export function parseBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(s)) return null;
  return s;
}

/** The configured base address of the CNN server, read from the Vite env. */
export function cnnBaseUrl(): string | null {
  return parseBaseUrl(import.meta.env.VITE_CNN_SERVER_URL);
}

/** Socket address for a path: same address with `https:` → `wss:` (`http:` → `ws:`). */
export function socketUrl(base: string, path: string): string {
  return base.replace(/^http/i, 'ws') + path;
}
