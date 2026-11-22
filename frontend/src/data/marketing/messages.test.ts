/** `data.marketing.*` and marketing state/fact/variant messages: complete in 4 languages, LOCALES 10 verbatim, every emitted key exists. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAST_MONTH_END, LAST_MONTH_START, TODAY } from '../db/time';
import { createSeedTables } from '../db/seed';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n';
import { createWidgetDataStore, readModel, MARKETING_WIDGET_IDS, previewVariants, resolveDataText, selectWidget, widgetFacts, type DataCommand } from '../widget-data';
import { dataBundle, dataBundles, marketingR2Review, marketingRowKeys, previewVariantBundle } from '../messages';
import { sourcedRows } from '../messages/sourced';
import { writtenRows } from '../messages/written';
import { marketingSourcedRows, marketingVariantLabelRows, marketingWidgetNames, marketingWrittenRows } from './messages';
import { CONCEPTS, MOODS, routeNameKey, ROUTES } from './derive';

const here = dirname(fileURLToPath(import.meta.url));
const allKeys = new Set([...Object.keys(dataBundle.ko), ...Object.keys(previewVariantBundle.ko)]);
const LOCALES = ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const;

function collect(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) collect(v, out); return; }
  if (!value || typeof value !== 'object') return;
  for (const [name, v] of Object.entries(value)) {
    if (typeof v === 'string' && (name === 'key' || name.endsWith('Key')) && /^(data|preview)\./.test(v)) out.add(v);
    else if (name === 'keyParams' && v && typeof v === 'object') {
      for (const key of Object.values(v)) if (typeof key === 'string' && key.startsWith('data.')) out.add(key);
    }
    else collect(v, out);
  }
}

describe('coverage', () => {
  it('views of every marketing widget and variant, their facts and variant labels — before and after every command', () => {
    const used = new Set<string>();
    const scan = (store: ReturnType<typeof createWidgetDataStore>) => {
      for (const id of MARKETING_WIDGET_IDS) for (const v of ['normal', ...previewVariants(id).map((x) => x.id)]) {
        const view = selectWidget(store.getSnapshot(), id, { kind: 'default' }, v);
        collect(view, used);
        collect(widgetFacts(view), used);
      }
      collect(selectWidget(store.getSnapshot(), 'marketing-performance', { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END }, 'normal'), used);
    };
    const seed = createSeedTables();
    const menuId = 'm-cafe-latte';
    const photos = Array.from({ length: 6 }, (_, order) => ({ photoId: `test-photo-${order}`, menuId, url: `/test/photo/${order}`, width: 900, height: 900, order }));
    const store = createWidgetDataStore({ marketing: { ...seed.marketing, promoPhoto: photos } });
    const active = seed.marketing.coupon.find(row => row.status === 'active')!;
    const ended = seed.marketing.coupon.find(row => row.status === 'ended')!;
    const smsCode = seed.marketing.couponCode.find(row => row.couponId === active.couponId && row.route === 'sms')!;
    const consenting = seed.marketing.mktCustomer.find(row => row.consentSms)!;
    const nonConsenting = seed.marketing.mktCustomer.find(row => !row.consentSms)!;
    const churn = readModel(store.getSnapshot(), 'customer-groups').reachOut.recipientIds[0];
    scan(store);
    const run = (c: DataCommand) => { const r = store.dispatch(c); if (r.ok) { if (r.noticeKey) used.add(r.noticeKey); collect(r.value, used); } else used.add(r.messageKey); return r; };
    const slot = selectWidget(store.getSnapshot(), 'slot-coupon', { kind: 'default' }, 'normal');
    if (slot.status !== 'ready') throw new Error('not ready');
    for (const b of ['free-shot', 'percent-10', 'amount-500'] as const) run({ type: 'coupon.sendSlot', slotIds: [slot.model.slots[0].slotId], recipientIds: [], benefit: b, idempotencyKey: `x${b}` });
    run({ type: 'coupon.sendSlot', slotIds: [slot.model.slots[0].slotId], recipientIds: [nonConsenting.customerId], benefit: 'free-shot', idempotencyKey: 'v' });
    run({ type: 'coupon.sendSlot', slotIds: [slot.model.slots[0].slotId], recipientIds: [consenting.customerId], benefit: 'free-shot', sendAt: `${TODAY}T22:00`, idempotencyKey: 'n' });
    run({ type: 'coupon.sendSlot', slotIds: [slot.model.slots[0].slotId], recipientIds: [consenting.customerId], benefit: 'free-shot', sendAt: `${TODAY}T10:00`, idempotencyKey: 'p' });
    run({ type: 'coupon.sendSlot', slotIds: [], recipientIds: [consenting.customerId], benefit: 'free-shot', idempotencyKey: 's' });
    run({ type: 'coupon.sendSlot', slotIds: [slot.model.slots[0].slotId], recipientIds: [consenting.customerId], benefit: 'x' as never, idempotencyKey: 'b' });
    run({ type: 'coupon.sendSlot', slotIds: [slot.model.slots[1].slotId], recipientIds: [consenting.customerId], benefit: 'percent-10', idempotencyKey: 'ok1' });
    run({ type: 'coupon.sendSlot', slotIds: [slot.model.slots[2].slotId], recipientIds: [consenting.customerId], benefit: 'amount-500', idempotencyKey: 'ok2' });
    run({ type: 'coupon.createExpiry', itemId: 'i-basque-cake', benefit: { kind: 'percent', value: 70 }, route: 'sms', idempotencyKey: 'e1' });
    for (const [i, benefit] of ([{ kind: 'percent', value: 0 }, { kind: 'amount', value: 0 }, { kind: 'setPrice', value: 0 }, { kind: 'amount', value: 5_201 }, { kind: 'x', value: 1 }, { kind: 'amount', value: 2_683 }] as const).entries()) run({ type: 'coupon.createExpiry', itemId: 'i-basque-cake', benefit: benefit as never, route: 'sms', idempotencyKey: `eb${i}` });
    run({ type: 'coupon.createExpiry', itemId: 'i-milk', benefit: { kind: 'percent', value: 10 }, route: 'sms', idempotencyKey: 'e2' });
    run({ type: 'coupon.createExpiry', itemId: 'i-basque-cake', benefit: { kind: 'percent', value: 10 }, route: 'x' as never, idempotencyKey: 'e3' });
    const placed = run({ type: 'coupon.createExpiry', itemId: 'i-basque-cake', benefit: { kind: 'percent', value: 40 }, route: 'place_news', idempotencyKey: 'e4' });
    run({ type: 'coupon.createExpiry', itemId: 'i-basque-cake', benefit: { kind: 'setPrice', value: 2_800 }, route: 'sms', idempotencyKey: 'e5' });
    // the amount and set-price families (name, text, post) come from their own fresh stores, one coupon per item per day
    for (const [i, benefit] of ([{ kind: 'amount', value: 700 }, { kind: 'setPrice', value: 2_800 }] as const).entries()) {
      const other = createWidgetDataStore();
      for (const route of ['sms', 'place_news'] as const) {
        const again = i === 0 && route === 'sms' ? other : createWidgetDataStore();
        const r = again.dispatch({ type: 'coupon.createExpiry', itemId: 'i-basque-cake', benefit, route, idempotencyKey: `f${i}${route}` });
        if (r.ok) collect(r.value, used);
        scan(again);
        for (const t of again.getSnapshot().tables.marketing.messageSend) collect({ body: t.body }, used);
        collect(again.getSnapshot().tables.marketing.coupon, used);
      }
    }
    run({ type: 'coupon.markPosted', codeId: smsCode.codeId, idempotencyKey: 'm1' });
    scan(store);
    expect(placed.ok).toBe(true);
    run({ type: 'coupon.markPosted', codeId: (placed as { value: { codeId: string } }).value.codeId, idempotencyKey: 'm2' });
    run({ type: 'coupon.markPosted', codeId: 'nope', idempotencyKey: 'm3' });
    run({ type: 'coupon.sendReachOut', recipientIds: [consenting.customerId], idempotencyKey: 'r1' });
    const sent = run({ type: 'coupon.sendReachOut', recipientIds: [churn], idempotencyKey: 'r2' });
    expect(sent.ok).toBe(true);
    if (sent.ok) run({ type: 'coupon.notifyEnding', couponId: (sent.value as { couponId: string }).couponId, idempotencyKey: 'n3' });
    run({ type: 'coupon.notifyEnding', couponId: ended.couponId, idempotencyKey: 'n1' });
    run({ type: 'coupon.notifyEnding', couponId: active.couponId, idempotencyKey: 'n2' });
    for (const type of ['coupon.pause', 'coupon.resume', 'coupon.extend'] as const) run({ type, couponId: active.couponId });
    run({ type: 'coupon.extend', couponId: ended.couponId });
    const input = (n: number, extra: Record<string, unknown> = {}) => ({ menuIds: [menuId], photoIds: store.getSnapshot().tables.marketing.promoPhoto.slice(0, n).map((p) => p.photoId), moods: ['warm'], concepts: ['review-roundup'], memo: '', referenceId: 'ref-1', lengthSec: 15, locale: 'ko', ...extra }) as never;
    run({ type: 'promo.syncCatalog', catalog: {} as never });
    run({ type: 'video.make', input: input(4), idempotencyKey: 'v1' });
    run({ type: 'video.make', input: input(5, { menuIds: [] }), idempotencyKey: 'v2' });
    run({ type: 'video.make', input: input(5, { photoIds: 'x' }), idempotencyKey: 'v3' });
    run({ type: 'video.make', input: input(5, { menuIds: ['m-saltbread'] }), idempotencyKey: 'v4' });
    run({ type: 'video.make', input: input(5, { concepts: ['x'] }), idempotencyKey: 'v5' });
    run({ type: 'video.make', input: input(5, { moods: [] }), idempotencyKey: 'v6' });
    run({ type: 'video.make', input: input(5, { memo: 'a'.repeat(101) }), idempotencyKey: 'v7' });
    run({ type: 'video.make', input: input(5, { referenceId: 'ref-9' }), idempotencyKey: 'v8' });
    run({ type: 'video.make', input: input(5, { lengthSec: 20 }), idempotencyKey: 'v9' });
    run({ type: 'video.make', input: input(5, { locale: 'ja' }), idempotencyKey: 'v10' });
    run({ type: 'video.make', input: undefined as never, idempotencyKey: 'v11' });
    const made = run({ type: 'video.make', input: input(5), idempotencyKey: 'v12' });
    expect(made.ok).toBe(true);
    const videoId = (made as { value: { videoId: string } }).value.videoId;
    run({ type: 'video.make', input: input(5), idempotencyKey: 'v13' });
    run({ type: 'video.attachJob', videoId, jobId: 'bad' });
    run({ type: 'video.attachJob', videoId, jobId: 'pj-0123456789ab' });
    run({ type: 'video.progress', videoId, stage: 'scenes', stageState: 'active' });
    run({ type: 'video.progress', videoId, stage: 'look', stageState: 'done' });
    run({ type: 'video.progress', videoId, stage: 'x' as never, stageState: 'active' });
    run({ type: 'video.settle', videoId, outcome: { kind: 'failed', reason: 'x' as never } });
    run({ type: 'video.save', videoId });
    run({ type: 'video.markPosted', videoId, route: 'clip', idempotencyKey: 'vp0' });
    run({ type: 'video.settle', videoId, outcome: { kind: 'failed', reason: 'AI_TIMEOUT' } });
    run({ type: 'video.retry', videoId, idempotencyKey: 'vr1' });
    run({ type: 'video.settle', videoId, outcome: { kind: 'done', result: { durationSec: 15, music: { trackId: 't', title: 't', artist: 'a', licenseLabel: 'CC0' }, fileUrl: '/api/promo/jobs/pj-0123456789ab/video.mp4', sizeBytes: 10, madeAt: `${TODAY}T10:00` } } });
    run({ type: 'video.save', videoId });
    run({ type: 'video.markPosted', videoId, route: 'x' as never, idempotencyKey: 'vp1' });
    run({ type: 'video.markPosted', videoId, route: 'clip', idempotencyKey: 'vp2' });
    scan(store);
    for (const t of store.getSnapshot().tables.marketing.messageSend) collect({ body: t.body }, used);
    // dynamic families the widgets look up by id
    for (const m of MOODS) used.add(`data.marketing.mood.${m}`);
    for (const c of CONCEPTS) used.add(`data.marketing.concept.${c}`);
    for (const r of ROUTES) used.add(routeNameKey(r));
    for (const r of ['clip', 'reels', 'shorts', 'blogDraft']) used.add(`data.marketing.postTo.${r}`);
    for (const id of ['financier', 'croissant', 'americano']) used.add(`data.marketing.promoMenu.${id}`);
    for (const id of MARKETING_WIDGET_IDS) for (const v of previewVariants(id)) used.add(v.labelKey);
    expect([...used].filter((k) => !allKeys.has(k))).toEqual([]);
    expect(used.size).toBeGreaterThan(120);
  });
});

describe('bundle', () => {
  it('every T-058 row has four languages, renders with sample params and never shows a key', () => {
    const rows = { ...marketingSourcedRows, ...marketingWrittenRows };
    for (const locale of LOCALES) {
      const t = createTranslator(locale, ...dataBundles);
      for (const key of marketingRowKeys) {
        const ko = (dataBundle.ko as Record<string, string>)[key];
        const params = Object.fromEntries([...ko.matchAll(/\{(\w+)/g)].map(([, n]) => [n, n === 'item' || n === 'code' ? 'X' : 2]));
        const text = t.t(key, params);
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(text).not.toContain(key);
        expect(text, `${locale} ${key}: ${text}`).not.toMatch(/[{}]/);
      }
    }
    for (const [key, row] of Object.entries(rows)) for (let i = 0; i < 4; i++) expect((dataBundle[LOCALES[i]] as Record<string, string>)[key], key).toBe(row[i]);
    for (const [short, row] of Object.entries(marketingVariantLabelRows)) expect((previewVariantBundle.ko as Record<string, string>)[`preview.variant.${short}`]).toBe(row[0]);
    expect((previewVariantBundle.en as Record<string, string>)['preview.variant.coupon-status.partial']).toBe('Partial data');
    expect((previewVariantBundle['zh-Hant'] as Record<string, string>)['preview.variant.slot-coupon.error']).toBe('載入失敗');
  });
  it('no T-058 key overlaps a T-043 row', () => {
    const t043 = new Set([...Object.keys(sourcedRows), ...Object.keys(writtenRows)]);
    expect(marketingRowKeys.filter((k) => t043.has(k))).toEqual([]);
    expect(new Set(marketingRowKeys).size).toBe(marketingRowKeys.length);
  });
  it('per-widget errors use the LOCALES 4.1 names with the right particle', () => {
    const ko = createTranslator('ko', ...dataBundles), en = createTranslator('en', ...dataBundles), hans = createTranslator('zh-Hans', ...dataBundles);
    expect(ko.t('data.state.marketing-today.error')).toBe('오늘 할 홍보를 불러오지 못했어요');
    expect(ko.t('data.state.slot-coupon.error')).toBe('빈 시간 단골 쿠폰을 불러오지 못했어요');
    expect(ko.t('data.state.promo-video.error')).toBe('AI 홍보 영상을 불러오지 못했어요');
    expect(en.t('data.state.coupon-status.error')).toBe("Couldn't load Active coupons");
    expect(en.t('data.state.marketing-performance.error')).toBe(en.t('data.real.error'));
    expect(hans.t('data.state.customer-groups.error')).toBe('无法加载顾客分组');
  });
  it('coupon names and texts resolve with their item / percent (sell-today 40%, slot benefits)', () => {
    const ko = createTranslator('ko', ...dataBundles), en = createTranslator('en', ...dataBundles);
    const text = { key: 'data.marketing.coupon.expiryToday', params: { p: 40 }, keyParams: { item: 'data.item.croissant' } } as const;
    expect(resolveDataText(ko.t, text)).toBe('크루아상 오늘만 40%');
    expect(resolveDataText(en.t, text)).toBe('Croissant 40% off today only');
    expect(resolveDataText(ko.t, { key: 'data.marketing.sms.expiry', params: { p: 40 }, keyParams: { item: 'data.item.croissant' } })).toBe('크루아상을 오늘만 40% 할인해요. 오늘 마감 전까지 쓸 수 있어요.');
    expect(resolveDataText(ko.t, { key: 'data.marketing.benefit.amount', params: { amount: 500 } })).toBe('500원 할인');
  });
  it('reports the R2 review count (en + zh-Hans + zh-Hant strings written by T-058)', () => {
    expect(marketingR2Review.generatedErrorRows).toBe(6);
    expect(marketingR2Review.strings).toBe((marketingR2Review.writtenRows + marketingR2Review.variantLabelRows + marketingR2Review.generatedErrorRows) * 3);
  });
});

/**
 * The current coupon copy names the amount benefit without tying it to an option.
 * Older examples included a day-range prefix or an extra-shot benefit that requires a recipe cost.
 */
const SLOT_COUPON_COPY = new Map([
  ['내일부터 7일 빈 시간 샷 추가 500원 할인', '빈 시간 500원 할인'], ['Quiet-hour extra shot ₩500 off (next 7 days)', 'Quiet-hour ₩500 off'],
  ['未来 7 天空闲时段加浓缩立减 500 韩元', '空闲时段减 500韩元'], ['未來 7 天空閒時段加濃縮立減 500 韓元', '空閒時段減 500韓元'],
  ['샷 추가 500원 할인(금액 할인, 대상 옵션 샷 추가)', '500원 할인'], ['Extra shot ₩500 off', '₩500 off'],
  ['加浓缩立减 500 韩元', '减 500韩元'], ['加濃縮立減 500 韓元', '減 500韓元'],
  ['내일부터 7일 빈 시간 샷 추가 무료', '빈 시간 샷 추가 무료'], ['Quiet-hour free extra shot (next 7 days)', 'Quiet-hour free extra shot'],
  ['未来 7 天空闲时段免费加浓缩', '空闲时段免费加浓缩'], ['未來 7 天空閒時段免費加濃縮', '空閒時段免費加濃縮'],
  ['다음 주 빈 시간 샷 추가 무료', '빈 시간 샷 추가 무료'], ["Next week's quiet-hour free extra shot", 'Quiet-hour free extra shot'],
  ['下周空闲时段免费加浓缩', '空闲时段免费加浓缩'], ['下週空閒時段免費加濃縮', '空閒時段免費加濃縮'],
]);

// LOCALES.md is the product copy table kept outside this repository; skip when it is absent.
const hasLocalesDoc = existsSync(join(here, '../../../../01_product/LOCALES.md'));
describe.skipIf(!hasLocalesDoc)('LOCALES 10 terms and current coupon copy (D-64)', () => {
  it('every value of LOCALES.md section 10 appears in all four languages (`/`-lists split; formatted weekday/time row left to the formatters)', () => {
    const doc = readFileSync(join(here, '../../../../01_product/LOCALES.md'), 'utf8');
    const start = doc.indexOf('## 10. 마케팅 가짜 데이터 이름');
    const section = doc.slice(start, doc.indexOf('\n## ', start + 5) === -1 ? undefined : doc.indexOf('\n## ', start + 5));
    const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 구분') && !l.startsWith('| :---')).map((l) => l.split('|').slice(1, 6).map((c) => c.trim()));
    expect(rows.length).toBe(23);
    const translators = LOCALES.map((l) => createTranslator(l, ...dataBundles));
    const money = ['500원', '₩500', '500韩元', '500韓元'];
    const rendered = LOCALES.map((_, i) => new Set(Object.keys(dataBundle.ko).flatMap((key) => {
      const t = translators[i];
      const item = t.t('data.item.croissant');
      return [t.t(key, { p: '{p}', item, amount: 500 }), t.t(key)];
    })));
    for (const set of rendered) {
      for (const coupon of createSeedTables().marketing.coupon) if ('raw' in coupon.name) set.add(coupon.name.raw);
    }
    let checked = 0;
    for (const [kind, ...cells] of rows) {
      if (kind === '요일·시간' || kind.includes('이력')) continue; // history rows replaced by D-80 are deleted from the bundle
      const parts = cells.map((c) => c.split(' / '));
      for (let i = 0; i < 4; i++) for (const raw of parts[i]) {
        const value = SLOT_COUPON_COPY.get(raw) ?? raw
          .replace('{금액}', money[i])
          .replace(/\{(?:품목|品目)\}/g, translators[i].t('data.item.croissant'));
        expect(rendered[i].has(value), `${LOCALES[i]}: ${kind} “${value}”`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });
});

describe.skipIf(!hasLocalesDoc)('LOCALES 4.1 widget names (used in the error sentences)', () => {
  it('match the document row by row', () => {
    const doc = readFileSync(join(here, '../../../../01_product/LOCALES.md'), 'utf8');
    const [, section] = doc.split(/^### 4\.[12] /mu);
    const rows = section.split('\n').filter((line) => /^\| .* \| `[a-z-]+` \|/.test(line))
      .map((line) => line.split('|').slice(2, 7).map((cell) => cell.trim()));
    expect(rows).toHaveLength(6);
    expect(Object.fromEntries(rows.map(([id, ...names]) => [id.slice(1, -1), names]))).toEqual(marketingWidgetNames);
  });
});
