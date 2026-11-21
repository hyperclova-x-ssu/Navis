import { cafeWeek as week, cafeFacts } from './__fixtures__/cafe';
import { TODAY } from '../../data/db/time';
import { seedCatalog } from '../../data/db/generated/catalog';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeText, isAnalysisRequest } from './analysis';
import { navisTranslator } from './messages';
import { storeFactSource, type WidgetFactSource } from './snapshot';
import { createWidgetDataStore, widgetFacts } from '../../data/widget-data';
import type { Locale } from '../../contracts';

const LOCALES: readonly Locale[] = ['ko', 'en', 'zh-Hans', 'zh-Hant'];
const ASK: Record<Locale, { ledger: string; inventory: string; customer: string }> = {
  ko: { ledger: '최근 7일 매출 분석해줘', inventory: '재고 부족한 거 알려줘', customer: '손님 많은 시간 알려줘' },
  en: { ledger: 'Analyze the last 7 days of sales', inventory: 'What stock is running low?', customer: 'When are customers busiest?' },
  'zh-Hans': { ledger: '分析最近 7 天的销售额', inventory: '哪些库存不足？', customer: '客人多的时间是什么时候？' },
  'zh-Hant': { ledger: '分析最近 7 天的營業額', inventory: '哪些庫存不足？', customer: '客人多的時間是什麼時候？' },
};
const store = createWidgetDataStore();
const source = storeFactSource(store);
const factsOf = (id: 'ledger' | 'inventory-booking' | 'customer-analysis', condition: Parameters<typeof source.view>[1]) => widgetFacts(source.view(id, condition) as never) as readonly { key: string; value: number | string; date?: string; labelText?: { key?: string } }[];
const trKo = navisTranslator('ko');
const weekLabel = trKo.format.dateRange(week.start, week.end);
const ingredientNames = ['i-milk', 'i-bean-house'].map(id => seedCatalog.items.find(item => item.itemId === id)!.name);
const inventory = cafeFacts('inventory-booking');
const ingredientStocks = ingredientNames.map(name => inventory.find(fact => fact.key === 'inventory.stock' && fact.labelText && 'raw' in fact.labelText && fact.labelText.raw === name)!);
const restock = Number(inventory.find(fact => fact.key === 'inventory.restock.count')!.value);
const visits = cafeFacts('customer-analysis');
const cctv = (key: string) => Number(visits.find(fact => fact.key === key)!.value);

describe('analysis from store facts', () => {
  it('computes total, average and the earliest maximum from the same daily facts the ledger shows', async () => {
    const daily = factsOf('ledger', week).filter((f) => f.key === 'ledger.sales.daily').map((f) => ({ date: f.date!, value: f.value as number }));
    const total = daily.reduce((a, b) => a + b.value, 0);
    const result = await analyzeText(ASK.ko.ledger, { source });
    expect(result).toMatchObject({ ok: true, answer: { sourceKey: 'widget:ledger', condition: week, periodLabel: weekLabel, metrics: [{ value: total }, { value: Math.round(total / 7) }, { value: Math.max(...daily.map((d) => d.value)) }] } });
    const net = factsOf('ledger', week).find((f) => f.key === 'ledger.sales.net')!.value;
    expect(total).toBe(net);
    const changed: WidgetFactSource = { view: source.view, facts: (v) => widgetFacts(v).map((f) => (f.key === 'ledger.sales.daily' ? { ...f, value: 1000000 } : f)) };
    const again = await analyzeText(ASK.ko.ledger, { source: changed });
    expect(again).toMatchObject({ ok: true, answer: { metrics: [{ value: 7000000 }, { value: 1000000 }, { value: 1000000 }], interpretation: expect.stringContaining(trKo.format.date(week.start, 'monthDay')) } });
  });
  it('returns inventory and busy-hour facts without inventing shortages', async () => {
    const date = trKo.format.date(TODAY, 'monthDay');
    const inv = await analyzeText(ASK.ko.inventory, { source });
    expect(inv).toMatchObject({ ok: true, answer: {
      periodLabel: trKo.t('navis.analysis.asOf', { date }), condition: { kind: 'snapshot', asOf: TODAY },
      metrics: [restock, ...ingredientStocks.map(fact => fact.value)].map(value => ({ value })),
    } });
    const cus = await analyzeText(ASK.ko.customer, { source });
    expect(cus).toMatchObject({ ok: true, answer: {
      periodLabel: trKo.t('navis.analysis.today', { date }),
      metrics: ['cctv.visits.total', 'cctv.peak.hour', 'cctv.peak.staff'].map(key => ({ value: cctv(key) })),
    } });
  });
  it.each(LOCALES)('answers in %s with that language\'s formatter outputs, and the numbers do not change', async (locale) => {
    const t = navisTranslator(locale); const f = t.format;
    const days = factsOf('ledger', week).filter((x) => x.key === 'ledger.sales.daily');
    const daily = days.map(x => Number(x.value));
    const peakDate = days[daily.indexOf(Math.max(...daily))].date!;
    const total = daily.reduce((a, b) => a + b, 0);
    const result = await analyzeText(ASK[locale].ledger, { locale, source });
    if (!result.ok) throw new Error(result.code);
    const a = result.answer;
    expect(a.periodLabel).toBe(f.dateRange(week.start, week.end));
    expect(a.metrics.map((m) => m.label)).toEqual([t.t('navis.analysis.total'), t.t('navis.analysis.average'), t.t('navis.analysis.peakDay', { date: f.date(peakDate, 'monthDay') })]);
    expect(a.metrics.map((m) => m.display)).toEqual([f.money(total, 'compact'), f.money(Math.round(total / 7), 'compact'), f.money(Math.max(...daily), 'compact')]);
    expect(a.interpretation).toBe(t.t('navis.analysis.ledgerNote', { date: f.date(peakDate, 'monthDay') }));
    expect(a.metrics.map((m) => m.value)).toEqual([total, Math.round(total / 7), Math.max(...daily)]);
    const inv = await analyzeText(ASK[locale].inventory, { locale, source });
    if (!inv.ok) throw new Error(inv.code);
    expect(inv.answer.periodLabel).toBe(t.t('navis.analysis.asOf', { date: f.date(TODAY, 'monthDay') }));
    expect(inv.answer.metrics[0]).toMatchObject({ label: t.t('navis.analysis.restock'), display: f.count(restock, 'item') });
    expect(inv.answer.metrics.slice(1).map(metric => metric.display)).toEqual(ingredientStocks.map(fact => {
      if (!fact.unit) throw new Error('Missing ingredient unit');
      return f.quantity(Number(fact.value), fact.unit);
    }));
    const cus = await analyzeText(ASK[locale].customer, { locale, source });
    if (!cus.ok) throw new Error(cus.code);
    const peakHour = cctv('cctv.peak.hour');
    expect(cus.answer.metrics.map((m) => m.display)).toEqual([f.count(cctv('cctv.visits.total'), 'visit'), f.hourRange(peakHour, peakHour + 1), f.count(cctv('cctv.peak.staff'), 'person')]);
    for (const text of [a.periodLabel, a.interpretation, ...a.metrics.map((m) => m.label + m.display), inv.answer.interpretation, cus.answer.interpretation]) {
      if (locale !== 'ko') expect(text).not.toMatch(/[가-힣]/u);
      expect(text).not.toMatch(/navis\.|data\.|common\./u);
    }
  });
  it('differs between languages (not just a copy of Korean)', async () => {
    const [ko, en] = await Promise.all([analyzeText(ASK.ko.ledger, { locale: 'ko', source }), analyzeText(ASK.en.ledger, { locale: 'en', source })]);
    expect(ko.ok && en.ok && ko.answer.metrics[0].display !== en.answer.metrics[0].display).toBe(true);
  });
  it('distinguishes unavailable data, unsupported periods and unrecognized requests', async () => {
    const empty: WidgetFactSource = { view: source.view, facts: () => [] };
    expect(await analyzeText(ASK.ko.ledger, { source: empty })).toMatchObject({ ok: false, code: 'DATA_UNAVAILABLE', periodLabel: weekLabel });
    expect(await analyzeText(ASK.ko.inventory, { source: empty })).toMatchObject({ ok: false, code: 'DATA_UNAVAILABLE' });
    expect(await analyzeText('이번 주 매출 분석해줘', { source })).toMatchObject({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(await analyzeText('Analyze this week\'s sales', { source })).toMatchObject({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(await analyzeText('지난주 재고 부족한 거', { source })).toMatchObject({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(await analyzeText('모르는 질문', { source })).toMatchObject({ ok: false, code: 'UNRECOGNIZED' });
    expect(await analyzeText('2026-02-30 매출 분석해줘', { source })).toMatchObject({ ok: false, code: 'INVALID_CONDITION' });
    expect(isAnalysisRequest('hello')).toBe(false);
    for (const locale of LOCALES) for (const text of Object.values(ASK[locale])) expect(isAnalysisRequest(text)).toBe(true);
  });
});

describe('no legacy data service in the assistant', () => {
  it('imports nothing from src/data/index.ts (only data/widget-data)', () => {
    const dir = __dirname;
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/u.test(f));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((m) => m[1]);
      const bad = imports.filter((spec) => /(^|\/)data$|(^|\/)data\/index$/u.test(spec));
      expect(bad, file).toEqual([]);
      if (file !== 'analysis.test.ts') expect(text, file).not.toMatch(/widgetDataService|normalizeWidgetQuery|readLocalWidget/u);
    }
  });
});
