/** T-043 bundles: every key the data module emits exists in 4 languages, renders, and LOCALES 8 is copied verbatim. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAST_MONTH_END, LAST_MONTH_START, NOW, TODAY, TOMORROW, YESTERDAY } from './db/time';
import { seedCatalog } from './db/generated/catalog';
import { createSeedTables } from './db/seed';
import type { Reservation } from './db/types';
import { describe, expect, it } from 'vitest';
import { createTranslator, findDuplicateKeys, findKoGaps, baseBundles, type MessageBundle } from '../i18n';
import { createWidgetDataStore, DATA_WIDGET_IDS, previewVariants, selectWidget, widgetFacts, readInternalModel, type DataCommand } from './widget-data';
import { dataBundle, dataBundles, previewVariantBundle, r2Review } from './messages';
import { managementBundle, managementKoreanOverrides, managementVariantLabels } from './messages/management';
import { posDataBundle } from './messages/pos';
import { iteration7DataKorean, iteration7VariantKorean } from './messages/iteration7';
import { sourcedRows } from './messages/sourced';

const here = dirname(fileURLToPath(import.meta.url));
const keysOf = (b: { ko: Readonly<Record<string, string>> }) => Object.keys(b.ko);
const allKo = Object.assign({}, ...dataBundles.map((b) => b.ko)) as Record<string, string>;
const allKeys = new Set(Object.keys(allKo));
// D-209 / PRD 12.6: iteration7DataKorean includes all M3 money facts and errors in koOnly.
// D-209: iteration 6 data copy uses the same Korean fallback as iteration 5.
const koOnly = new Set([...Object.keys(iteration7DataKorean),...Object.keys(iteration7VariantKorean),...Object.keys(managementBundle.ko), ...Object.keys(managementKoreanOverrides), ...Object.keys(managementVariantLabels), ...Object.keys(posDataBundle.ko), ...Object.keys(allKo).filter(key => /^(?:data\.(?:staff\.|state\.staff-schedule\.|fact\.staff\.)|preview\.variant\.staff-schedule\.)/.test(key))]);

/** Walks a model/view and collects message keys (`…Key`, `…Keys`, DataText `key`/`keyParams`, `messageKey`). */
function collect(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) collect(v, out); return; }
  if (!value || typeof value !== 'object') return;
  for (const [name, v] of Object.entries(value)) {
    if (typeof v === 'string' && (name === 'key' || name.endsWith('Key')) && /^(data|preview)\./.test(v)) out.add(v);
    else if (Array.isArray(v) && name.endsWith('Keys')) for (const s of v) if (typeof s === 'string' && /^(data|preview)\./.test(s)) out.add(s);
    else if (name === 'keyParams' && v && typeof v === 'object') for (const s of Object.values(v)) out.add(s as string);
    else collect(v, out);
  }
}

describe('bundle shape', () => {
  it('한국어가 완전하고 기존 번역과 반복5 한국어 fallback을 보존한다', () => {
    expect(findKoGaps(...dataBundles)).toEqual([]);
    for (const b of dataBundles) for (const key of keysOf(b)) {
      for (const lang of ['en', 'zh-Hans', 'zh-Hant'] as const) {
        if (koOnly.has(key)) expect(createTranslator(lang, ...dataBundles).t(key, { menu: '메뉴', count: 2, total: 5, done: 3 })).toBe(createTranslator('ko', ...dataBundles).t(key, { menu: '메뉴', count: 2, total: 5, done: 3 }));
        else expect((b[lang] as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy();
      }
    }
    for (const key of keysOf(dataBundle)) expect(key.startsWith('data.')).toBe(true);
    for (const key of keysOf(previewVariantBundle)) expect(key.startsWith('preview.variant.')).toBe(true);
  });
  it('no key collides with the common bundles (T-041) or across T-043 bundles', () => {
    expect(findDuplicateKeys(...(baseBundles as readonly MessageBundle<string>[]), ...dataBundles)).toEqual([]);
  });
  it('every message renders in all four languages with sample params and never shows a key name', () => {
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const t = createTranslator(locale, ...dataBundles);
      for (const key of allKeys) {
        const params = Object.fromEntries([...allKo[key].matchAll(/\{(\w+)/g)].map(([, n]) => [n, ['item', 'supplier', 'title', 'name', 'request', 'time'].includes(n) ? 'X' : 2]));
        const text = t.t(key, params);
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(text).not.toContain(key);
        expect(text, `${locale} ${key}: ${text}`).not.toMatch(/[{}]/);
      }
    }
  });
  it('per-widget error messages use the LOCALES 4 names and the right Korean particle', () => {
    const ko = createTranslator('ko', ...dataBundles), en = createTranslator('en', ...dataBundles), hant = createTranslator('zh-Hant', ...dataBundles);
    expect(ko.t('data.state.ledger.error')).toBe('손익을 불러오지 못했어요');
    expect(ko.t('data.state.margin.error')).toBe('마진을 불러오지 못했어요');
    expect(en.t('data.state.customer-analysis.error')).toBe("CCTV 현황을 불러오지 못했어요");
    expect(hant.t('data.state.calendar.error')).toBe('無法載入行事曆');
    expect(ko.t('data.state.inventory-booking.error')).toBe('재고를 불러오지 못했어요');
  });
  it('reports the R2 review count (en + zh-Hans + zh-Hant strings written here)', () => {
    expect(r2Review.strings).toBe((r2Review.writtenRows + r2Review.variantLabelRows + r2Review.generatedErrorRows) * 3);
    expect(r2Review.generatedErrorRows).toBe(15);
  });
});

describe('coverage: every key the data module can emit exists', () => {
  it('views of every widget and variant, facts and variant labels', () => {
    const used = new Set<string>();
    const store = createWidgetDataStore();
    const snap = store.getSnapshot();
    for (const id of DATA_WIDGET_IDS) {
      const conditions = [{ kind: 'default' as const }];
      for (const v of ['normal', ...previewVariants(id).map((x) => x.id)]) for (const c of conditions) {
        const view = selectWidget(snap, id, c, v);
        collect(view, used);
        collect(widgetFacts(view), used);
      }
      for (const v of previewVariants(id)) used.add(v.labelKey);
    }
    for (const c of [{ kind: 'dateRange', start: 'x', end: 'y' }, { kind: 'dateRange', start: '2026-01-01', end: '2026-01-02' }] as const) collect(selectWidget(snap, 'ledger', c, 'normal'), used);
    collect(selectWidget(snap, 'stock-sync' as never, { kind: 'default' }, 'normal'), used);
    // dynamic families
    for (const c of ['ingredients', 'operations', 'supplies', 'labor', 'rent', 'other']) used.add(`data.expenseCategory.${c}`);
    for (const e of ['receipt', 'tax-invoice', 'card', 'none']) used.add(`data.evidence.${e}`);
    for (const c of ['opening', 'closing', 'recipe', 'cleaning', 'new-staff']) used.add(`data.manualCategory.${c}`);
    for (const k of ['opening', 'closing', 'event', 'construction', 'traffic']) used.add(`data.localChangeKind.${k}`);
    for (const r of ['refund', 'complaint', 'privacy', 'no-ground']) used.add(`data.needsPerson.${r}`);
    for (const s of ['sales', 'expenses', 'evidence']) used.add(`data.tax.source.${s}`);
    for (const s of ['connected', 'partial', 'missing']) used.add(`data.tax.connection.${s}`);
    for (const ch of ['store', 'online']) used.add(`data.error.moveOverStock.${ch}`);
    const missing = [...used].filter((k) => !allKeys.has(k));
    expect(missing).toEqual([]);
  });
  it('every notice/error key returned by commands (success and failure paths)', () => {
    const used = new Set<string>();
    const run = (store: ReturnType<typeof createWidgetDataStore>, cmds: readonly DataCommand[]) => {
      for (const c of cmds) {
        const r = store.dispatch(c);
        if (r.ok) { if (r.noticeKey) used.add(r.noticeKey); } else used.add(r.messageKey);
        if (r.ok && r.undoToken && c.type === 'grants.markReviewed') { const u = store.undo(r.undoToken); if (u.ok && u.noticeKey) used.add(u.noticeKey); used.add((store.undo(r.undoToken) as { messageKey: string }).messageKey); }
      }
    };
    const seed = createSeedTables();
    const milk = seed.purchaseItem.find(row => row.itemId === 'i-milk')!;
    const direct = seed.partnershipOffer[0];
    const completed = seed.reservation.find((row): row is Reservation => row.kind === 'visit' && row.status === 'completed')!;
    const s = createWidgetDataStore({
      purchaseOrder: [...seed.purchaseOrder, ...[TODAY, TOMORROW, YESTERDAY].map((dueDate, i) => ({
        poId: `test-order-${i}`, dueDate, supplierId: milk.supplierId, expectedTime: null, status: 'scheduled' as const, variant: null,
      }))],
      purchaseOrderLine: [...seed.purchaseOrderLine, ...[0, 1, 2].map(i => ({
        poId: `test-order-${i}`, polId: `test-line-${i}`, itemId: milk.itemId, qtyOrdered: 12, unitPrice: milk.unitPrice, unitSnapshot: milk.purchaseUnit, basePerUnit: milk.basePerUnit,
      }))],
      reservation: seed.reservation.map(row => row === completed ? { ...completed, status: 'confirmed' } : row),
      partnershipOffer: [direct, { ...direct, offerId: 'test-direct' }, { ...direct, offerId: 'test-public', visibility: 'public' }],
      inventoryItem: [...seed.inventoryItem, {
        itemId: 'test-retail', kind: 'retail', nameKey: 'data.item.beans200', unit: 'pcs', updatedAt: NOW,
        restockThreshold: null, trackRestock: false, lowStockPerChannel: 30, sales7d: null, trackExpiry: false, expiresOn: null,
      }],
      inventoryStock: [...seed.inventoryStock, { itemId: 'test-retail', channel: 'store', qty: 30 }, { itemId: 'test-retail', channel: 'online', qty: 5 }],
    });
    const s2 = createWidgetDataStore();
    const expense = seed.expense.find(row => row.businessDate === TODAY)!;
    const closedCalendar = seed.calendarEvent.find(row => row.date < TODAY)!;
    const opening = seed.manual.find(row => row.category === 'opening')!;
    const [message, otherMessage] = seed.inquiryThread.filter(row => row.type === 'message' && row.status === 'waiting');
    const review = seed.inquiryThread.find(row => row.type === 'review' && row.isPublic && row.status === 'waiting')!;
    const suggestion = readInternalModel(s.getSnapshot(), 'hiring').suggestion;
    if (!suggestion) throw new Error('hiring not ready');
    run(s, [
      { type: 'ledger.recordExpense', date: TODAY, category: 'other', amount: 1 }, { type: 'ledger.recordExpense', date: 'x', category: 'other', amount: 1 },
      { type: 'ledger.recordExpense', date: TODAY, category: 'x' as never, amount: 1 }, { type: 'ledger.recordExpense', date: TODAY, category: 'other', amount: 0 },
      { type: 'ledger.recordExpense', date: TODAY, category: 'other', amount: 1, evidence: 'x' as never },
      { type: 'suppliers.recordReceipt', polId: 'test-line-0', qty: 2, idempotencyKey: 'a' },
      { type: 'ledger.confirmCandidate', expenseId: 'nope' }, { type: 'tax.markChecked', refId: expense.expenseId }, { type: 'tax.markChecked', refId: expense.expenseId },
      { type: 'tax.export', period: { start: LAST_MONTH_START, end: LAST_MONTH_END } }, { type: 'tax.export', period: { start: '2026-01-01', end: '2026-01-02' } },
      { type: 'grants.markReviewed', noticeId: 'sample-grant-1' }, { type: 'cctv.markPeakForReview', date: TODAY, hour: 14 },
      { type: 'memberships.useOnce', membershipId: 'sample-pass-2', idempotencyKey: 'm1' }, { type: 'memberships.useOnce', membershipId: 'sample-pass-2', idempotencyKey: 'm2' },
      { type: 'memberships.useOnce', membershipId: 'missing-pass', idempotencyKey: 'm3' }, { type: 'memberships.useOnce', membershipId: 'sample-pass-1', idempotencyKey: 'm4' }, { type: 'memberships.useOnce', membershipId: 'sample-pass-1', idempotencyKey: 'm5' },
      { type: 'memberships.cancelUse', useId: 'mu-01' }, { type: 'memberships.cancelUse', useId: 'mu-404' },
      { type: 'booking.confirm', reservationId: 'sample-booking-over-capacity' }, { type: 'booking.propose', reservationId: 'sample-booking-over-capacity', time: '99' }, { type: 'booking.markNoShow', reservationId: 'sample-booking-1' }, { type: 'booking.markNoShow', reservationId: completed.reservationId },
      { type: 'calendar.addEvent', title: 'A', date: TODAY, time: '10:00' }, { type: 'calendar.addEvent', title: '', date: TODAY }, { type: 'calendar.addTodo', title: 'B', date: 'x' },
      { type: 'calendar.updateEvent', eventId: 'sample-calendar-1', time: '25:00' }, { type: 'calendar.updateEvent', eventId: 'sample-calendar-1', title: 'C' }, { type: 'calendar.deleteEvent', eventId: closedCalendar.eventId },
      { type: 'calendar.setSourceVisible', source: 'x' as never, visible: true },
      { type: 'inventory.moveChannel', itemId: 'test-retail', from: 'store', to: 'online', qty: 1 }, { type: 'inventory.moveChannel', itemId: 'i-milk', from: 'store', to: 'online', qty: 1 },
      { type: 'inventory.moveChannel', itemId: 'test-retail', from: 'store', to: 'store', qty: 1 }, { type: 'inventory.moveChannel', itemId: 'test-retail', from: 'store', to: 'online', qty: 0 },
      { type: 'inventory.moveChannel', itemId: 'test-retail', from: 'store', to: 'online', qty: 999 }, { type: 'inventory.moveChannel', itemId: 'test-retail', from: 'online', to: 'store', qty: 999 },
      { type: 'inventory.updateItem', itemId: 'i-milk', stock: 3 }, { type: 'inventory.updateItem', itemId: 'test-retail', stock: 3 }, { type: 'inventory.updateItem', itemId: 'i-milk', stock: -1 },
      { type: 'suppliers.recordReceipt', polId: 'test-line-0', qty: 99, idempotencyKey: 'b' }, { type: 'suppliers.recordReceipt', polId: 'test-line-0', qty: 1, idempotencyKey: '' },
      { type: 'suppliers.changeDueDate', poId: 'test-order-1', date: TOMORROW }, { type: 'suppliers.changeDueDate', poId: 'test-order-2', date: TOMORROW },
      { type: 'hiring.markCopied' }, { type: 'hiring.saveDraft', ...suggestion, days: [] }, { type: 'hiring.saveDraft', ...suggestion, start: '18:00' }, { type: 'hiring.saveDraft', ...suggestion, hourlyWage: 1 },
      { type: 'hiring.saveDraft', ...suggestion, tasks: [] }, { type: 'hiring.saveDraft', ...suggestion, contact: null as never }, { type: 'hiring.saveDraft', ...suggestion }, { type: 'hiring.markCopied' },
      { type: 'manuals.toggleStep', manualId: opening.manualId, stepNo: 1 }, { type: 'manuals.toggleStep', manualId: opening.manualId, stepNo: 1 }, { type: 'manuals.createDraftFromMemo', memo: '' },
      { type: 'manuals.createDraftFromMemo', memo: 'x' }, { type: 'manuals.saveDraft', draftId: 'md-x' },
      { type: 'interior.select', mood: 'calm-gray', materials: [] }, { type: 'interior.select', mood: 'x' as never, materials: ['wood'] }, { type: 'interior.select', mood: 'calm-gray', materials: ['wood'] }, { type: 'interior.saveMemo', memo: 'm' },
      { type: 'floorPlan.saveDraftLayout', tables: [], aisleCm: 90 }, { type: 'floorPlan.saveDraftLayout', tables: [{ zone: 'bar', seats: 2 }], aisleCm: -1 }, { type: 'floorPlan.saveDraftLayout', tables: [{ zone: 'bar', seats: 2 }], aisleCm: 90 },
      { type: 'floorPlan.applyLayout', layoutId: s.getSnapshot().tables.floorLayout[0].layoutId }, { type: 'floorPlan.generateFromPhotos' },
      { type: 'localChanges.acknowledge', changeId: 'sample-local-1' },
      { type: 'inquiry.send', threadId: message.threadId, idempotencyKey: 'i1' }, { type: 'inquiry.post', threadId: review.threadId, idempotencyKey: 'i2' }, { type: 'inquiry.send', threadId: review.threadId, idempotencyKey: 'i3' },
      { type: 'inquiry.send', threadId: otherMessage.threadId, idempotencyKey: 'i4', previewVariant: 'send-failure' },
      { type: 'community.accept', offerId: direct.offerId }, { type: 'community.decline', offerId: 'test-direct' }, { type: 'community.sendInterest', offerId: 'test-public' }, { type: 'community.sendInterest', offerId: direct.offerId },
      { type: 'nope' } as never,
      { type: 'cctv.markPeakForReview', date: YESTERDAY, hour: 9 },
      { type: 'cctv.markPeakForReview', date: TODAY, hour: 2 },
      { type: 'booking.propose', reservationId: 'sample-booking-3', time: '99' },
      { type: 'booking.propose', reservationId: 'sample-booking-3', time: '20:00' },
      { type: 'calendar.addEvent', title: '지난 일정', date: YESTERDAY },
      { type: 'inventory.updateItem', itemId: 'i-milk', threshold: -1 },
      { type: 'manuals.toggleStep', manualId: 'cafe-store-guide', stepNo: 1 },
      { type: 'suppliers.changeDueDate', poId: 'test-order-1', date: YESTERDAY },
    ]);
    const draft = s2.dispatch({ type: 'manuals.createDraftFromMemo', memo: 'x' });
    run(s2, [
      { type: 'manuals.saveDraft', draftId: (draft as { value: { draftId: string } }).value.draftId, title: ' ' },
      { type: 'manuals.saveDraft', draftId: (draft as { value: { draftId: string } }).value.draftId, steps: [] },
      { type: 'manuals.saveDraft', draftId: (draft as { value: { draftId: string } }).value.draftId },
    ]);
    const missing = [...used].filter((k) => !allKeys.has(k));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(50);
  });
  it('static `data.*` literals in the data sources all exist', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) { if (f !== 'messages' && f !== 'dev') walk(p); } else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'index.ts') files.push(p); } };
    walk(here);
    const literals = new Set<string>();
    for (const f of files) for (const [, k] of readFileSync(f, 'utf8').matchAll(/'((?:data|preview\.variant)\.[A-Za-z0-9.-]+)'/g)) if (!k.endsWith('.')) literals.add(k);
    expect([...literals].filter((k) => !allKeys.has(k))).toEqual([]);
  });
});

it('describes the same-day work rule in the invalid shift data message', () => {
  const ko = createTranslator('ko', ...dataBundles);
  expect(ko.t('data.staff.error.INVALID_SHIFT')).toBe('근무는 같은 날 안에서만 정할 수 있어요');
});

// LOCALES.md is the product copy table kept outside this repository; skip when it is absent.
describe.skipIf(!existsSync(join(here, '../../../01_product/LOCALES.md')))('LOCALES 8 is copied verbatim (D-55, Q-26)', () => {
  it('every row of LOCALES.md section 8 appears with identical ko/en/zh-Hans/zh-Hant', () => {
    const doc = readFileSync(join(here, '../../../01_product/LOCALES.md'), 'utf8');
    const start = doc.indexOf('## 8. 가짜 데이터 이름');
    const section = doc.slice(start, doc.indexOf('\n## ', start + 5));
    const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 구분') && !l.startsWith('| :---')).map((l) => l.split('|').slice(2, 6).map((c) => c.trim()));
    expect(rows.length).toBe(31);
    const values = Object.values(sourcedRows).map((r) => r.join('|'));
    const t = (locale: 'ko' | 'en' | 'zh-Hans' | 'zh-Hant') => createTranslator(locale, ...dataBundles);
    const delivery = (['ko', 'en', 'zh-Hans', 'zh-Hant'] as const).map((l) => t(l).t('data.calendar.delivery', { item: t(l).t('data.item.milk'), supplier: t(l).t('data.supplier.a') })).join('|');
    const dairy = seedCatalog.suppliers.find(row => row.supplierId === 's-dairy')!;
    const importedNames = new Set([
      ...seedCatalog.items.map(row => row.name), ...seedCatalog.menu.map(row => row.name),
      ...seedCatalog.suppliers.map(row => row.name), `우유 입고 · ${dairy.name}`,
    ]);
    for (const row of rows) {
      const cafeName = row.every(name => name === row[0]) && importedNames.has(row[0]);
      expect(values.includes(row.join('|')) || delivery === row.join('|') || cafeName, row.join(' / ')).toBe(true);
      if (cafeName) for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) expect(t(locale).t(`seed:${row[0]}`)).toBe(row[0]);
    }
  });
});
