/**
 * T-056 character collector (dev/test only; the app never imports this file).
 * It imports every message module under src/ (messages.ts, messages/*.ts, written/sourced rows ...) and walks all
 * exports looking for MessageBundle-shaped objects ({ 'zh-Hans': {...}, 'zh-Hant': {...} }), so later bundles are
 * picked up without editing this file. Plain arrays of bundles are walked too.
 */
export type Script = 'zh-Hans' | 'zh-Hant';

// Eager glob: bundles are plain data modules. Test files and dev hosts are excluded.
const modules = import.meta.glob(
  [
    '/src/**/messages.ts',
    '/src/**/messages/*.ts',
    '/src/**/*-messages.ts',
    '/src/i18n/messages/*.ts',
    '!/src/**/*.test.ts',
    '!/src/**/dev/**',
  ],
  { eager: true },
) as Record<string, Record<string, unknown>>;

function isBundle(v: unknown): v is Record<string, Record<string, unknown>> {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['zh-Hans'] === 'object' && o['zh-Hans'] !== null && typeof o['zh-Hant'] === 'object' && o['zh-Hant'] !== null;
}

/** All bundles found, as [module path, export name, bundle]. Bundles reachable from several modules are de-duplicated by identity. */
export function findBundles(): { path: string; name: string; bundle: Record<string, Record<string, unknown>> }[] {
  const seen = new Set<unknown>();
  const out: { path: string; name: string; bundle: Record<string, Record<string, unknown>> }[] = [];
  const visit = (path: string, name: string, v: unknown, depth: number) => {
    if (seen.has(v) || depth > 3) return;
    if (isBundle(v)) { seen.add(v); out.push({ path, name, bundle: v }); return; }
    if (Array.isArray(v)) { seen.add(v); v.forEach((x, i) => visit(path, `${name}[${i}]`, x, depth + 1)); }
  };
  for (const [path, mod] of Object.entries(modules)) for (const [name, v] of Object.entries(mod)) visit(path, name, v, 0);
  return out;
}

/**
 * Characters the Chinese subset must hold: Han, CJK/full-width punctuation and the general punctuation CJK fonts
 * draw full width (curly quotes, dashes, ellipsis, middle dot). Latin, digits, Hangul, ₩ and % stay in NanumSquareNeo.
 */
export const NEEDED = /[·‐-‧⺀-⿟　-〿㐀-䶿一-鿿豈-﫿！-｠￠-￦]|[\u{20000}-\u{2FA1F}]/u;

export function charsOf(script: Script): Set<number> {
  const set = new Set<number>();
  for (const { bundle } of findBundles()) {
    for (const value of Object.values(bundle[script] as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      for (const ch of value) if (NEEDED.test(ch)) set.add(ch.codePointAt(0)!);
    }
  }
  return set;
}
