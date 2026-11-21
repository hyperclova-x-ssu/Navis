import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseBundles, createTranslator, findDuplicateKeys, findKoGaps, type MessageBundle } from '../../../i18n';
import { dataBundle, previewVariantBundle } from '../../../data/widget-data';
import { uiBundle } from '../../../ui/messages';
import { mgmtSupplyBundle, mgmtSupplyR2Review, mgmtSupplyRows } from './messages';
import { widgets } from './index';

const LANGS = ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const;

/** plan-1 widget key tables (team/plan-1/widgets/*.md), `| \`key\` | ko | en | zh-Hans | zh-Hant |`. */
function planRows(file: string): Map<string, string[]> {
  const md = fs.readFileSync(path.resolve(process.cwd(), '..', 'team', 'plan-1', 'widgets', file), 'utf8');
  const out = new Map<string, string[]>();
  for (const line of md.split('\n')) {
    const m = /^\|\s*`(widget\.[^`]+)`\s*\|(.+)\|\s*$/.exec(line);
    if (!m) continue;
    const cells = m[2]!.split('|').map((c) => c.trim());
    if (cells.length >= 4) out.set(m[1]!, cells.slice(0, 4));
  }
  return out;
}

describe('mgmt-supply bundle (ARCHITECTURE 11.6, API-12)', () => {
  it('exports the three modules of the group', () => {
    expect(widgets.map((w) => w.id)).toEqual(['calendar', 'inventory-booking', 'suppliers']);
    for (const w of widgets) { expect(w.Detail).not.toBeNull(); expect(typeof w.useSummary).toBe('function'); }
  });
  it('owns only widget.{calendar|inventory-booking|suppliers}.* without title / coach / aliases', () => {
    for (const [key] of mgmtSupplyRows) {
      expect(key).toMatch(/^widget\.(calendar|inventory-booking|suppliers)\./);
      expect(key).not.toMatch(/^widget\.[^.]+\.(title|coach|aliases)$/);
    }
  });
  it('has all four languages, a full ko and no key in two bundles', () => {
    for (const lang of LANGS) for (const [key] of mgmtSupplyRows) expect((mgmtSupplyBundle[lang] as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy();
    expect(findKoGaps(mgmtSupplyBundle)).toEqual([]);
    expect(findDuplicateKeys(mgmtSupplyBundle, dataBundle as MessageBundle<string>, previewVariantBundle as MessageBundle<string>, uiBundle as MessageBundle<string>, ...(baseBundles as readonly MessageBundle<string>[]))).toEqual([]);
  });
  // The plan-1 key tables live in the planning notes outside this repository.
  it.skipIf(!fs.existsSync(path.resolve(process.cwd(), '..', 'team', 'plan-1', 'widgets')))('plan-1 rows are copied as the plan-1 key tables give them (stock-sync rows renamed under inventory)', () => {
    const plan = new Map([...planRows('calendar.md'), ...planRows('inventory.md'), ...planRows('suppliers.md'), ...planRows('stock-sync.md')]);
    const renamed: Record<string, string> = { 'widget.inventory-booking.productsTotal': 'widget.stock-sync.total', 'widget.inventory-booking.lowInChannel': 'widget.stock-sync.lowInChannel' };
    const fromPlan = mgmtSupplyRows.filter((r) => r[5] === 'plan1');
    expect(fromPlan.length).toBe(mgmtSupplyR2Review.plan1Rows);
    for (const row of fromPlan) {
      const source = plan.get(renamed[row[0]] ?? row[0]);
      expect(source, row[0]).toBeDefined();
      const koAmendments: Record<string, string> = { 'widget.inventory-booking.empty': '아직 등록한 품목이 없어요', 'widget.inventory-booking.registerItem': '품목 추가하기', 'widget.inventory-booking.registerProduct': '상품 추가하기', 'widget.suppliers.registerSupplier': '발주사 추가하기' };
      expect([row[1], row[2], row[3], row[4]].map((cell) => cell.replace(/\u00A0/g, ' ')), row[0]).toEqual([koAmendments[row[0]] ?? source![0], ...source!.slice(1)]);
    }
  });
  it('formats the plural and particle templates in every language', () => {
    const t = (lang: (typeof LANGS)[number]) => createTranslator(lang, mgmtSupplyBundle, ...(baseBundles as readonly MessageBundle<string>[]));
    expect(t('ko').t('widget.inventory-booking.summary', { count: 3 })).toBe('보충 필요 3개 품목');
    expect(t('en').t('widget.inventory-booking.summary', { count: 1 })).toBe('Needs restocking: 1 item');
    expect(t('en').t('widget.suppliers.incomingUnit', { count: 1 })).toBe('order');
    expect(t('en').t('widget.calendar.countUnit', { count: 3 })).toBe('events');
    expect(t('zh-Hans').t('widget.suppliers.summary', { count: 3 })).toBe('未来 7 天预计到货 3 笔订单');
    expect(t('zh-Hant').t('widget.calendar.summary', { count: 3, date: '10月26日 週一' })).toBe('今日行程 3 項，10月26日 週一');
  });
  it('reports the R2 review count (en + zh-Hans + zh-Hant of the written rows)', () => {
    expect(mgmtSupplyR2Review.strings).toBe(mgmtSupplyR2Review.writtenRows * 3);
    expect(mgmtSupplyR2Review.writtenRows + mgmtSupplyR2Review.plan1Rows).toBe(mgmtSupplyRows.length);
  });
});
