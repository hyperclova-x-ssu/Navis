/** Sample states of the 7 marketing widgets (DATA_MODEL 10.15.5, SCR-43·8.8, AC-287·291·294·298·301·304·307·322). */
import { describe, expect, it } from 'vitest';
import type { FeatureId, PreviewSelection } from '../../contracts';
import { ALL_DATA_WIDGET_IDS, createWidgetDataStore, MARKETING_WIDGET_IDS, previewVariants, readModel, resolveVariant, selectWidget, widgetFacts } from '../widget-data';

const snapshot = createWidgetDataStore().getSnapshot();
const marketing = snapshot.tables.marketing;
const photos = Array.from({ length: 10 }, (_, order) => ({ photoId: `test-photo-${order}`, menuId: 'm-cafe-latte', url: `/test/photo/${order}`, width: 900, height: 900, order }));
const withPhotos = createWidgetDataStore({ marketing: { ...marketing, promoPhoto: photos } }).getSnapshot();
const view = <F extends FeatureId>(id: F, variant: string) => selectWidget(snapshot, id, { kind: 'default' }, variant);
const preview = (family: PreviewSelection['family'], overrides: PreviewSelection['overrides'] = {}): PreviewSelection => ({ family, overrides });
const M2_WIDGET_IDS = ['notice-send', 'store-environment', 'custom-order'] as const;

describe('variant lists', () => {
  it('all 30 have empty and exactly one error; plan-2 and M2 keep their specified variant order', () => {
    expect(MARKETING_WIDGET_IDS).toHaveLength(7);
    // PRD §12.4 F-278/280/281 and DATA_MODEL §19.1 add these three to M1's 26.
    expect(ALL_DATA_WIDGET_IDS).toHaveLength(30);
    for (const id of ALL_DATA_WIDGET_IDS) {
      const variants = previewVariants(id);
      expect(variants.filter((v) => v.family === 'empty').length, id).toBeGreaterThanOrEqual(1);
      expect(variants.filter((v) => v.family === 'error'), id).toEqual([{ id: 'error', family: 'error', labelKey: `preview.variant.${id}.error` }]);
    }
    for (const id of MARKETING_WIDGET_IDS) {
      expect(previewVariants(id).filter((v) => v.family === 'special'), id).toHaveLength(id === 'promo-video' ? 0 : 1); // D-80: promo-video keeps only few-photos and error (10.16.10)
    }
    // DATA_MODEL §10.15.5 order is retained; API-273/279 add M2 preview states.
    expect(Object.fromEntries([...MARKETING_WIDGET_IDS, ...M2_WIDGET_IDS].map((id) => [id, previewVariants(id).map((v) => `${v.family}:${v.id}`)]))).toEqual({
      'marketing-today': ['empty:none', 'special:partial', 'error:error'],
      'slot-coupon': ['empty:no-slots', 'special:consent-mixed', 'empty:no-regulars', 'error:error'],
      'expiry-coupon': ['empty:none', 'special:partial', 'error:error'],
      'promo-video': ['empty:few-photos', 'error:error'],
      'coupon-status': ['empty:none', 'special:partial', 'error:error'],
      'customer-groups': ['empty:no-history', 'special:partial', 'error:error'],
      'marketing-performance': ['empty:no-redemptions', 'special:partial', 'error:error'],
      'notice-send': ['empty:empty', 'error:error'],
      'store-environment': ['empty:empty', 'special:out_of_range', 'special:sensor_disconnected', 'error:error'],
      'custom-order': ['empty:empty', 'error:error'],
    });
  });
  it('resolveVariant: family first, overrides for the extra no-regulars', () => {
    expect(resolveVariant('slot-coupon', preview('empty'))).toBe('no-slots');
    expect(resolveVariant('slot-coupon', preview('special'))).toBe('consent-mixed');
    expect(resolveVariant('slot-coupon', preview('normal', { 'slot-coupon': 'no-regulars' }))).toBe('no-regulars');
    expect(resolveVariant('promo-video', preview('error'))).toBe('error');
    expect(resolveVariant('notice-send', preview('empty'))).toBe('empty');
    expect(resolveVariant('notice-send', preview('error'))).toBe('error');
    expect(resolveVariant('store-environment', preview('special'))).toBe('out_of_range');
  });
});

describe('empty and error views (plan-2 wording, AC-322)', () => {
  it('empty: plan-2 sentence (+ the button action where SCREENS 8.8 has one); error: widget message with retry', () => {
    expect(view('marketing-today', 'none')).toEqual({ status: 'empty', featureId: 'marketing-today', variant: 'none', messageKey: 'data.state.marketing-today.none', actionKey: 'data.marketing.action.viewActiveCoupons' });
    expect(view('coupon-status', 'none')).toMatchObject({ status: 'empty', messageKey: 'data.state.coupon-status.none', actionKey: 'data.marketing.action.viewTodayPromotions' });
    expect(view('slot-coupon', 'no-slots')).toEqual({ status: 'empty', featureId: 'slot-coupon', variant: 'no-slots', messageKey: 'data.state.slot-coupon.no-slots' });
    expect(view('expiry-coupon', 'none')).toMatchObject({ status: 'empty', messageKey: 'data.state.expiry-coupon.none' });
    expect(view('promo-video', 'few-photos')).toMatchObject({ status: 'empty', messageKey: 'data.state.promo-video.few-photos' });
    expect(view('customer-groups', 'no-history')).toMatchObject({ status: 'empty', messageKey: 'data.state.customer-groups.no-history' });
    expect(view('marketing-performance', 'no-redemptions')).toMatchObject({ status: 'empty', messageKey: 'data.state.marketing-performance.no-redemptions' });
    for (const id of M2_WIDGET_IDS) expect(view(id, 'empty')).toMatchObject({ status: 'empty', featureId: id, variant: 'empty' });
    for (const id of [...MARKETING_WIDGET_IDS, ...M2_WIDGET_IDS]) expect(view(id, 'error')).toEqual({ status: 'error', featureId: id, variant: 'error', messageKey: `data.state.${id}.error` });
  });
});

describe('partial/special views keep what exists and say what is missing', () => {
  it('today: the reply cell is missing with a note', () => {
    const v = selectWidget(withPhotos, 'marketing-today', { kind: 'default' }, 'partial');
    expect(v.status === 'ready' && v.model.cells.map((c) => c.slot)).toEqual(['now', 'week']);
    expect(v).toMatchObject({ notes: [{ messageKey: 'data.state.marketing-today.partial' }] });
  });
  it('slot: consent-mixed lists 2 more customers who cannot be selected (reason); no-regulars cannot send', () => {
    const v = view('slot-coupon', 'consent-mixed');
    if (v.status !== 'ready') throw new Error('not ready');
    expect([v.model.recipients.length, v.model.regularsCount]).toEqual([3, 1]);
    const blocked = v.model.recipients.filter(r => !r.selectable);
    expect(blocked.map(row => row.customerId).sort()).toEqual(marketing.slotConsentSampleVisits!.map(row => row.customerId).sort());
    expect(blocked.every(row => row.reasonKey === 'data.marketing.error.noConsent')).toBe(true);
    expect(v.notes).toEqual([{ messageKey: 'data.state.slot-coupon.consent-mixed' }]);
    const none = view('slot-coupon', 'no-regulars');
    expect(none.status === 'ready' && [none.model.slotCount, none.model.regularsCount, none.model.recipients, none.model.canSend, none.model.slots.map((x) => x.regularIds.length)]).toEqual([9, 0, [], false, Array(9).fill(0)]);
    expect(none).toMatchObject({ notes: [{ messageKey: 'data.state.slot-coupon.no-regulars' }] });
  });
  it('expiry: cost needs checking → no limit, no creation', () => {
    const v = view('expiry-coupon', 'partial');
    expect(v.status === 'ready' && [v.model.target?.qty, v.model.target?.unitCost, v.model.target?.maxSliderRate, v.model.target?.atRecommended, v.model.canCreate]).toEqual([6, null, null, null, false]);
  });
  it('video: few-photos shows 4 photos on this widget only and cannot make; the other tables and the 10 stay', () => {
    const v = selectWidget(withPhotos, 'promo-video', { kind: 'default' }, 'few-photos');
    expect(v.status).toBe('empty');
    expect(readModel(withPhotos, 'promo-video').photoCount).toBe(10);
    expect(readModel(withPhotos, 'marketing-today').cells.find((c) => c.slot === 'week')?.params).toEqual({ photos: 10 });
  });
  it('coupons: ended usage partly missing → no month total', () => {
    const v = view('coupon-status', 'partial');
    const normal = readModel(snapshot, 'coupon-status');
    expect(v.status === 'ready' && [v.model.activeCount, v.model.runningUsed, v.model.endedUsed, v.model.monthUsed, v.model.ended.map(r => [r.couponId, r.used])]).toEqual([
      1, 223, null, null, normal.ended.map((row, index) => [row.couponId, index === 0 ? null : row.used]),
    ]);
  });
  it('results: blog route missing → the other routes only', () => {
    const v = view('marketing-performance', 'partial');
    expect(v.status === 'ready' && [v.model.missingRoutes, v.model.routes.map((r) => r.route), v.model.issued, v.model.used]).toEqual([['blog'], ['place_news', 'clip', 'sms'], 299, 223]);
  });
  it('groups: same groups with the card-basis note', () => {
    const v = view('customer-groups', 'partial');
    expect(v).toMatchObject({ status: 'ready', notes: [{ messageKey: 'data.state.customer-groups.partial' }] });
  });
});

describe('a sample state never changes other widgets or Navis facts (SCR-29)', () => {
  it('all 30 widgets keep their normal facts while marketing and M2 variants are viewed', () => {
    const facts = () => ALL_DATA_WIDGET_IDS.flatMap((id) => widgetFacts(view(id, 'normal')));
    const before = facts();
    for (const id of [...MARKETING_WIDGET_IDS, ...M2_WIDGET_IDS]) for (const v of previewVariants(id)) view(id, v.id);
    expect(facts()).toEqual(before);
    expect(readModel(snapshot, 'slot-coupon').regularsCount).toBe(1);
    const photoCount = marketing.promoPhoto.length;
    expect(readModel(snapshot, 'promo-video').photoCount).toBe(photoCount);
    expect(readModel(snapshot, 'marketing-today').cells).toHaveLength(photoCount >= 5 ? 3 : 2);
  });
  it('determinism and memo for every plan-2 and M2 widget and variant', () => {
    const other = createWidgetDataStore().getSnapshot();
    for (const id of [...MARKETING_WIDGET_IDS, ...M2_WIDGET_IDS]) for (const v of ['normal', ...previewVariants(id).map((x) => x.id)]) {
      expect(JSON.stringify(view(id, v))).toBe(JSON.stringify(selectWidget(other, id, { kind: 'default' }, v)));
      expect(view(id, v)).toBe(view(id, v));
    }
  });
});
