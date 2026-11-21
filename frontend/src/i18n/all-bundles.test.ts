/**
 * T-055: every message bundle of the app at once (common, widget names, kit, screens, Navis, data, marketing and the
 * seven widget folders). Discovered from bundle modules and reviewed against the explicit id list below.
 */
import { describe, expect, it } from 'vitest';
import { locales } from '../contracts';
import type { MessageBundle } from './types';
import { findDuplicateKeys, findKoGaps } from './bundles';
import { createTranslator } from './translator';
import { formatMessage } from './icu';

const modules = import.meta.glob(
  ['/src/**/messages.ts', '/src/**/messages/*.ts', '/src/**/*-messages.ts', '!/src/**/*.test.ts', '!/src/**/dev/**'],
  { eager: true },
) as Record<string, Record<string, unknown>>;
const isBundle = (v: unknown): v is MessageBundle<string> => {
  const o = v as Partial<MessageBundle<string>> | null;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && locales.every(l => !!o[l] && typeof o[l] === 'object');
};
function collect(): readonly MessageBundle<string>[] {
  const seen = new Set<unknown>(); const out: MessageBundle<string>[] = [];
  const visit = (v: unknown, depth: number) => {
    if (seen.has(v) || depth > 3) return;
    if (isBundle(v)) { seen.add(v); out.push(v); return; }
    if (Array.isArray(v)) { seen.add(v); v.forEach(x => visit(x, depth + 1)); }
  };
  for (const mod of Object.values(modules)) for (const v of Object.values(mod)) visit(v, 0);
  return out;
}
const bundles = collect();
const iteration5Ids = ['run', 'data.management', 'ui-management', 'closing', 'arrival', 't207'] as const;
const iteration6M3Ids = ['pos-payment-tools', 'pos-receipt', 'pos-table-transfer', 'widget.menu.pos'] as const;
const expectedIds = [
  'common', 'widget-names', 'ui', 'dashboard', 'shell', 'detail', 'briefing', 'navis', 'data', 'preview.variant',
  'data-pos', // API-251: POS facts and briefing copy belong to data, not a widget.
  'mgmt-customers', 'mgmt-money', 'mgmt-store', 'widget.mgmt-supply', 'widget-mkt-local', 'mkt-coupon', 'mkt-promo',
  ...iteration5Ids,
  'cctv',
  // D-242 / ARCHITECTURE 16.2: POS screens do not add a widget folder.
  'ui-pos', 'pos-shell', 'pos-order-status',
  ...iteration6M3Ids,
  'widget.menu.photo',
] as const;
const KEY_TEXT = /\b(?:app|common|group|page|help|format|unit|language|preview|ui|dashboard|settings|shell|detail|briefing|navis|data|marketing|widget|onboarding|placeholder|closing|arrival|run|step|table|tables|payment|start|session|promo)\.[a-z][\w-]*(?:\.[\w.-]+)?\b/u;

describe('all message bundles (T-055 ③, API-12)', () => {
  it('finds the app bundles, including the seven widget folders and the data bundles', () => {
    const ids = new Set(bundles.map(b => b.id));
    expect(ids.size).toBe(bundles.length);
    for (const id of expectedIds) expect(ids, `Missing bundle: ${id}`).toContain(id);
    for (const id of ids) expect(expectedIds, `Unexpected bundle: ${id}`).toContain(id);
    // One bundle per widget folder (seven folders: mgmt-money, mgmt-customers, mgmt-supply, mgmt-store, mkt-local, mkt-coupon, mkt-promo).
    expect([...ids].filter(id => /(mgmt|mkt)-/u.test(id))).toHaveLength(7);
  });
  it('has no key in two bundles', () => {
    expect(findDuplicateKeys(...bundles)).toEqual([]);
  });
  it('has every Korean value, and no other language has a key Korean lacks', () => {
    expect(findKoGaps(...bundles)).toEqual([]);
    for (const b of bundles) {
      expect(Object.keys(b.ko).length, `${b.id} has an empty ko side`).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(b.ko)) expect(value.trim(), `${b.id} ko ${key}`).not.toBe('');
    }
  });
  it('keeps Korean-only rounds untranslated and falls back to Korean in every other locale', () => {
    // D-209 / T-244c: archived order-status copy first ships with the POS screen.
    for (const id of [...iteration5Ids, 'ui-pos', 'pos-shell', 'pos-order-status', 'data-pos', ...iteration6M3Ids]) {
      const b = bundles.find(bundle => bundle.id === id);
      expect(b, `Missing bundle: ${id}`).toBeDefined();
      if (!b) continue;
      for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
        expect(b[locale], `${id} ${locale}`).toEqual({});
        const t = createTranslator<string>(locale, b);
        for (const [key, value] of Object.entries(b.ko)) {
          expect(t.t(key), `${id} ${locale} ${key}`).toBe(formatMessage(value, 'ko'));
        }
      }
    }
  });
  it('preserves existing common and marketing translations in all four languages', () => {
    for (const id of ['common', 'widget-names', 'widget-mkt-local', 'mkt-coupon', 'mkt-promo']) {
      const b = bundles.find(bundle => bundle.id === id);
      expect(b, `Missing bundle: ${id}`).toBeDefined();
      if (!b) continue;
      const translatedKeys = new Set(['en', 'zh-Hans', 'zh-Hant'].flatMap(locale => Object.keys(b[locale as 'en' | 'zh-Hans' | 'zh-Hant'])));
      for (const key of translatedKeys) for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
        expect(b[locale][key]?.trim(), `${id} ${locale} ${key}`).toBeTruthy();
      }
    }
    const samples = [
      ['common', 'common.undo', ['되돌리기', 'Undo', '撤销', '復原']],
      ['widget-mkt-local', 'widget.local-changes.thisWeek', ['이번 주 동네 변화', 'Neighborhood changes this week', '本周周边动态', '本週周邊動態']],
      ['mkt-coupon', 'widget.slot-coupon.panelQ', ['내일부터 7일 빈 시간', 'Quiet hours, next 7 days', '未来 7 天空闲时段', '未來 7 天空閒時段']],
      ['mkt-promo', 'widget.marketing-today.slot.now', ['지금', 'Now', '现在', '現在']],
    ] as const;
    for (const [id, key, values] of samples) {
      const b = bundles.find(bundle => bundle.id === id);
      expect(b, `Missing bundle: ${id}`).toBeDefined();
      if (!b) continue;
      locales.forEach((locale, index) => expect(createTranslator<string>(locale, b).t(key), `${id} ${locale} ${key}`).toBe(values[index]));
    }
  });
  it('uses the selected translation when present and Korean fallback otherwise', () => {
    const params = { n: 2, count: 2, name: '이름', current: 1, total: 2, value: 2 };
    for (const b of bundles) for (const locale of locales) {
      const t = createTranslator<string>(locale, b);
      for (const [key, ko] of Object.entries(b.ko)) {
        const translated = (b[locale] as Record<string, string | undefined>)[key];
        const effectiveLocale = translated ? locale : 'ko';
        expect(t.has(key), `${b.id} ${locale} ${key}`).toBe(true);
        expect(t.t(key, params), `${b.id} ${locale} ${key}`).toBe(formatMessage(translated || ko, effectiveLocale, params));
      }
    }
  });
  it('never shows a message key as text (a value that looks like a key)', () => {
    const keys = new Set(bundles.flatMap(b => Object.keys(b.ko)));
    const hits = bundles.flatMap(b => locales.flatMap(l => Object.entries(b[l] as Record<string, string>).filter(([, v]) => typeof v === 'string' && (KEY_TEXT.test(v) || keys.has(v.trim()))).map(([k, v]) => `${b.id} ${l} ${k}: ${v}`)));
    expect(hits).toEqual([]);
  });
});
