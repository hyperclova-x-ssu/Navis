import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { DetailRef, FeatureId, Locale, WidgetHost, WidgetModule } from '../../../contracts';
import { baseBundles, findDuplicateKeys, findKoGaps, type MessageBundle } from '../../../i18n';
import { benefitMax, createWidgetDataStore, dataBundles, expiryDiscount, selectMembers, selectWidget, TODAY, TOMORROW, type CouponStatusModel, type CustomerGroupsModel, type DataCommand, type ExpiryCouponModel, type SlotCouponModel, type WidgetDataStore } from '../../../data/widget-data';
import { useWidgetView } from '../../../data/react';
import { panelShape, uiBundle } from '../../../ui';
import { renderWithKit, type KitRenderOptions } from '../../../ui/test-utils';
import { widgets, mktCouponBundle, r2Review } from './index';

const sms = vi.hoisted(() => ({ configured: true }));
// Exercise FAKE send and confirmation flows with the setup gate satisfied.
vi.mock('../../../data/reality/14/sms', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/reality/14/sms')>(),
  get smsSenderConfigured() { return sms.configured; },
}));


afterEach(() => { sms.configured = true; cleanup(); vi.useRealTimers(); });

const module = (id: FeatureId): WidgetModule => widgets.find((w) => w.id === id)!;
type MockHost = { -readonly [K in keyof WidgetHost]: WidgetHost[K] } & { resetPreview: Mock; openLinked: Mock; openDetail: Mock; notify: Mock; acknowledgeBriefing: Mock };
const host = (): MockHost => ({
  layer: 'marketing', openClosing: vi.fn(() => true), openSettings: vi.fn(() => true), resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(),
});
function panel(id: FeatureId, width: 1 | 2 | 3 | 4, height: 1 | 2 | 3 | 4, options: KitRenderOptions = {}, h = host(), editing = false) {
  const Panel = module(id).Panel;
  const ui = renderWithKit(<div data-testid="frame"><Panel featureId={id} condition={{ kind: 'default' }} width={width} height={height} shape={panelShape(width, height)} presetId="A" editing={editing} host={h} /></div>, options);
  return { ...ui, host: h };
}
function detail(id: FeatureId, ref: DetailRef = { featureId: id }, options: KitRenderOptions = {}, h = host()) {
  const Detail = module(id).Detail!;
  return { ...renderWithKit(<Detail featureId={id} condition={{ kind: 'default' }} detailRef={ref} host={h} />, options), host: h };
}

/* ── Cafe seed (D-312 · D-313): every expectation below is read from the same selectors the widgets use, not typed in. ── */
const addDays = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const modelOf = <T,>(id: FeatureId, store: WidgetDataStore = createWidgetDataStore(), variant = 'normal'): T => {
  const view = selectWidget(store.getSnapshot(), id, { kind: 'default' }, variant);
  if (view.status !== 'ready') throw new Error(`${id} is ${view.status}`);
  return view.model as T;
};
const slotModel = (store?: WidgetDataStore, variant?: string) => modelOf<SlotCouponModel>('slot-coupon', store, variant);
const statusModel = (store?: WidgetDataStore) => modelOf<CouponStatusModel>('coupon-status', store);
const groupsModel = (store?: WidgetDataStore) => modelOf<CustomerGroupsModel>('customer-groups', store);
const expiryModel = (store?: WidgetDataStore) => modelOf<ExpiryCouponModel>('expiry-coupon', store);
const WEEKDAY_KO = ['', '월', '화', '수', '목', '금', '토', '일'] as const;
const slotLabelKo = (s: { weekday: number; startHour: number; endHour: number }) => `${WEEKDAY_KO[s.weekday]} ${s.startHour}~${s.endHour}시`;
const won = (n: number) => `${n.toLocaleString('en-US')}원`;
const itemNameKo = (nameKey: string) => nameKey.replace(/^seed:/, '');
const rawName = (name: unknown): string => (name && typeof name === 'object' && 'raw' in name ? String((name as { raw: unknown }).raw) : '');
const krw = (n: number) => n.toLocaleString('en-US');
/** Money lines of the sell-today form for one rate, from the same discount function the form uses. */
const expiryAt = (t: NonNullable<ExpiryCouponModel['target']>, rate: number) => expiryDiscount(t.price, t.unitCost ?? 0, rate, t.qty);
const shortKo = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${'일월화수목금토'[d.getUTCDay()]})`; };
const shortEn = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]}, ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCDate()}`; };
/** The identity line is written only while it adds up; otherwise the page shows the month's count alone (same rule as the widget). */
const monthLineKo = (m: CouponStatusModel, paused: boolean): string => (m.monthUsed !== null && m.endedUsed !== null && m.monthUsed === m.runningUsed + m.endedUsed
  ? `이번 달 사용 ${m.monthUsed}장 = ${paused ? '진행·중지 중' : '진행 중'} ${m.runningUsed}장 + 끝난 쿠폰 ${m.endedUsed}장` : `이번 달 사용 ${m.monthUsed ?? m.runningUsed}장`);
const benefitNameKo = (o: { type: string; value: number }) => (o.type === 'percent' ? `${o.value}% 할인` : o.type === 'amount' ? `${won(o.value)} 할인` : '샷 추가 무료');
const regulars5 = (): WidgetDataStore => storeWithRegulars([true, true, true, true, true]);
const pickTime = async (time: string) => { await userEvent.click(screen.getByRole('button', { name: /^예약 시각/ })); await userEvent.click(await screen.findByRole('option', { name: time })); };
const perfText = (store: WidgetDataStore): string => { const v = selectWidget(store.getSnapshot(), 'marketing-performance', { kind: 'default' }, 'normal'); return v.status === 'ready' ? `${v.model.issued}|${v.model.used}|${v.model.rate}|${v.model.rateDelta?.value}` : v.status; };
/** The first customer-visible slot of the cafe seed that has a consenting regular, as the detail opens on it. */
const firstSlotWithRegulars = (m: SlotCouponModel) => m.openSlots.find((s) => m.recipients.some((r) => r.selectable && r.slotIds.includes(s.slotId))) ?? m.openSlots[0]!;

/** The cafe seed plus extra regulars of its first quiet slot (they came twice on that weekday and hour): `consents[i] === false` = no text consent. `variant` ties them to a sample state. */
function storeWithRegulars(consents: readonly boolean[], variant: string | null = null): WidgetDataStore {
  const base = createWidgetDataStore();
  const marketing = base.getSnapshot().tables.marketing;
  const slot = slotModel(base).openSlots[0]!;
  const days = [addDays(slot.date, -7), addDays(slot.date, -14)];
  const customers = consents.map((consentSms, i) => ({ customerId: `zz-reg-${i + 1}`, maskKey: `zz-reg-${i + 1}`, maskedName: `테○${i + 1}`, consentSms, consentNight: false, variant }));
  const visits = customers.flatMap((c) => days.map((businessDate) => ({ customerId: c.customerId, businessDate, hour: slot.startHour })));
  return createWidgetDataStore({ marketing: { ...marketing, mktCustomer: [...marketing.mktCustomer, ...customers], mktVisit: [...marketing.mktVisit, ...visits] } });
}
/** The cafe seed with its running coupon ending in two days (the ending-soon line, reminder and 곧 끝나요 badge need one). */
function storeWithEndingCoupon(): WidgetDataStore {
  const base = createWidgetDataStore();
  const marketing = base.getSnapshot().tables.marketing;
  return createWidgetDataStore({ marketing: { ...marketing, coupon: marketing.coupon.map((c) => (c.status === 'active' ? { ...c, endsOn: addDays(TODAY, 2) } : c)) } });
}
const sales = (key: string, m: SlotCouponModel = slotModel()): DataCommand => {
  const slot = firstSlotWithRegulars(m);
  return { type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: m.recipients.filter((r) => r.selectable && r.slotIds.includes(slot.slotId)).map((r) => r.customerId), benefit: m.benefits.recommendedId, idempotencyKey: key };
};

describe('module shape (API-13) and bundle', () => {
  it('exports the four widgets with Panel, Detail and useSummary', () => {
    expect(widgets.map((w) => w.id)).toEqual(['slot-coupon', 'expiry-coupon', 'coupon-status', 'customer-groups']);
    for (const w of widgets) { expect(typeof w.Panel).toBe('function'); expect(typeof w.Detail).toBe('function'); expect(typeof w.useSummary).toBe('function'); }
  });
  it('preserves existing translations and keeps only the LOCALES 11.13 new keys Korean-only', () => {
    expect(findDuplicateKeys(mktCouponBundle, uiBundle as MessageBundle<string>, ...(baseBundles as unknown as MessageBundle<string>[]), ...dataBundles)).toEqual([]);
    expect(findKoGaps(mktCouponBundle)).toEqual([]);
    for (const loc of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      const newKeys = ['widget.coupon.state.error.short', 'widget.coupon-status.state.none.short', 'widget.customer-groups.state.no-history.short', 'widget.expiry-coupon.moneySummary', 'widget.slot-coupon.sentResult', 'widget.slot-coupon.label', 'widget.coupon-status.label'];
      expect(Object.keys(mktCouponBundle[loc]).sort()).toEqual(Object.keys(mktCouponBundle.ko).filter(key => !newKeys.includes(key)).sort());
      for (const key of newKeys) expect(mktCouponBundle[loc]).not.toHaveProperty(key);
      for (const [key, value] of Object.entries(mktCouponBundle[loc])) expect(value, `${loc} ${key}`).not.toBe('');
    }
    expect(r2Review.strings).toBeGreaterThan(0);
  });
});

describe('panels (AC-288 · 292 · 299 · 302)', () => {
  it('slot-coupon: 3칸 and the short action in 1x1, matching regulars and the long action in 2x1', () => {
    const m = slotModel();
    const q = panel('slot-coupon', 1, 1);
    expect(q.container.querySelector('[data-slot="slot-coupon.metric.value"]')).toHaveTextContent(`${m.slotCount}개`);
    expect(screen.getByText('내일부터 7일 빈 시간')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '쿠폰 보내기, 빈 시간 단골 쿠폰' })).toBeInTheDocument();
    cleanup();
    const w = panel('slot-coupon', 2, 1);
    expect(w.container.querySelector('[data-slot="slot-coupon.metric.label"]')).toHaveTextContent('내일부터 7일 빈 시간');
    const primary = w.container.querySelector('.ui-panel-primary')!;
    expect(primary.lastElementChild).toHaveTextContent(`맞춤 단골 ${m.regularsCount}명`);
    expect(screen.getByRole('button', { name: '쿠폰 보내기, 빈 시간 단골 쿠폰' })).toBeInTheDocument();
  });
  it('slot-coupon 1x2 lists the three slots', () => {
    const ui = panel('slot-coupon', 1, 2);
    expect([...ui.container.querySelectorAll('[data-slot="slot-coupon.rows"] li')].map((li) => li.textContent)).toEqual(
      slotModel().openSlots.slice(0, 3).map((slot) => expect.stringContaining(slotLabelKo(slot))),
    );
  });
  it.each([2, 3, 4] as const)('aligns the zero matching-regulars row below the slot count at %sx1', (width) => {
    const w = panel('slot-coupon', width, 1, { preview: { family: 'normal', overrides: { 'slot-coupon': 'no-regulars' } } });
    expect(w.container.querySelector('.ui-panel-primary')?.lastElementChild).toHaveTextContent('맞춤 단골 0명');
    expect(screen.getByRole('button', { name: '쿠폰 보내기, 빈 시간 단골 쿠폰' })).toBeInTheDocument();
  });
  it('expiry-coupon: counts today’s expiring item types on 1x1 and 2x1 panels', () => {
    const items = expiryModel().items;
    const q = panel('expiry-coupon', 1, 1);
    const figure = q.container.querySelector('[data-slot="expiry-coupon.metric.value"]');
    expect(figure).toHaveTextContent(`${items.length}개`);
    expect(screen.getByText('오늘 팔 품목').compareDocumentPosition(figure!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: '쿠폰 만들기, 당일 소진 쿠폰' })).toBeInTheDocument();
    cleanup();
    panel('expiry-coupon', 2, 1);
    expect(screen.getByText('오늘 팔 품목')).toBeInTheDocument();
    expect(screen.getByText('오늘 안에 팔아야 해요')).toBeInTheDocument();
  });
  it('coupon-status: the running count and ending soon in 2x1; one row per coupon (up to three) in 1x2', () => {
    // the cafe seed has one running coupon with 13 days left; the ending-soon line and its button need a coupon that ends soon
    const store = storeWithEndingCoupon();
    const m = statusModel(store);
    expect(m.endingSoonCount).toBeGreaterThan(0);
    panel('coupon-status', 2, 1, { store });
    expect(screen.getByText(`곧 끝나는 쿠폰 ${m.endingSoonCount}개`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '끝나기 전 알림 보내기, 진행 중인 쿠폰' })).toBeInTheDocument();
    cleanup();
    const t = panel('coupon-status', 1, 2, { store });
    expect(t.container.querySelectorAll('[data-slot="coupon-status.rows"] li[data-row-id]')).toHaveLength(Math.min(3, m.rows.length));
    expect(screen.getByRole('button', { name: '알림 보내기, 진행 중인 쿠폰' })).toBeInTheDocument();
  });
  it('customer-groups: the leaving count and the first-visit and regular counts', () => {
    const { counts } = groupsModel();
    const q = panel('customer-groups', 1, 1);
    expect(q.container.querySelector('[data-slot="customer-groups.metric.value"]')).toHaveTextContent(`${counts['churn-risk']}명`);
    expect(screen.getByText('떠날 수 있는 손님')).toBeInTheDocument();
    cleanup();
    const w = panel('customer-groups', 2, 1);
    expect(w.container.querySelector('[data-slot="customer-groups.metric.label"]')).toHaveTextContent('떠날 수 있는 손님');
    expect(screen.getByText(`첫 방문 ${counts['first-visit']}명 · 단골 ${counts.regular}명`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '쿠폰 보내기, 손님 그룹' })).toBeInTheDocument();
  });
  it('shows the same numbers in English, 简体中文 and 繁體中文', () => {
    const regulars = slotModel().regularsCount;
    const ending = storeWithEndingCoupon();
    const status = statusModel(ending);
    const { counts } = groupsModel();
    panel('slot-coupon', 2, 1, { locale: 'en' });
    expect(screen.getByText(`${regulars} matching regulars`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send coupon, Quiet-hour coupons' })).toBeInTheDocument();
    cleanup();
    panel('coupon-status', 2, 1, { locale: 'zh-Hans', store: ending });
    expect(screen.getByText(`即将到期 ${status.endingSoonCount} 种`)).toBeInTheDocument();
    cleanup();
    panel('customer-groups', 2, 1, { locale: 'zh-Hant' });
    expect(screen.getByText(`首次到店 ${counts['first-visit']} · 熟客 ${counts.regular}`)).toBeInTheDocument();
    cleanup();
    const q = panel('expiry-coupon', 1, 1, { locale: 'en' });
    expect(q.container.querySelector('[data-slot="expiry-coupon.metric.value"]')).toHaveTextContent(`${expiryModel().items.length}items`);
  });
  it('places the Q number/action line above the subtitle at 125%', () => {
    const q = panel('slot-coupon', 1, 1, { textScale: 125 });
    expect(q.container.querySelector('.mkt-label')).toHaveTextContent('내일부터 7일 빈 시간');
    expect(q.container.querySelector('.mkt-number-row .ui-metric-fit')).toBeInTheDocument();
    expect(q.container.querySelector('.mkt-number-row .ui-panel-action')).toBeInTheDocument();
    const number=q.container.querySelector('[data-slot="slot-coupon.metric.value"]')!;
    const label=q.container.querySelector('.mkt-label')!;
    expect(number.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('PanelAction opens the widget detail with focus action and does not reach the panel press', async () => {
    const h = host();
    const parent = vi.fn();
    const Panel = module('slot-coupon').Panel;
    renderWithKit(<div onClick={parent} onPointerDown={parent}><Panel featureId="slot-coupon" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={h} /></div>);
    await userEvent.click(screen.getByRole('button', { name: /쿠폰 보내기/ }));
    expect(h.openDetail).toHaveBeenCalledWith({ featureId: 'slot-coupon', view: 'send', focus: 'action' });
    expect(parent).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it('each widget action opens its own detail with focus action', async () => {
    for (const [id, name, expected] of [
      ['expiry-coupon', /쿠폰 만들기/, { featureId: 'expiry-coupon', focus: 'action' }],
      ['coupon-status', /알림 보내기/, { featureId: 'coupon-status', focus: 'action' }],
      ['customer-groups', /쿠폰 보내기/, { featureId: 'customer-groups', view: 'reach-out', focus: 'action' }],
    ] as const) {
      // the reminder button only exists while a coupon is about to end
      const ui = panel(id, 1, 1, id === 'coupon-status' ? { store: storeWithEndingCoupon() } : {});
      await userEvent.click(screen.getByRole('button', { name }));
      expect(ui.host.openDetail).toHaveBeenCalledWith(expected);
      cleanup();
    }
  });
  it('hides the action but keeps its slot while editing', () => {
    panel('slot-coupon', 1, 1, {}, host(), true);
    const slot = document.querySelector('.ui-panel-action-slot');
    expect(slot).toHaveAttribute('data-hidden', 'true');
  });
});

describe('example states (AC-291 · 294 · 301 · 304 · 322)', () => {
  const preview = (id: FeatureId, variant: string) => ({ family: 'normal' as const, overrides: { [id]: variant } });
  it('empty and error panels show the sentence; retry only through resetPreview', async () => {
    for (const [id, variant, text] of [
      ['slot-coupon', 'no-slots', '내일부터 7일은 한산한 시간이 없어요'], ['expiry-coupon', 'none', '기한이 다가오는 재고가 없어요'],
      ['coupon-status', 'none', '진행 중인 쿠폰이 없어요. 빈 시간 단골 쿠폰을 만들어 보세요'], ['customer-groups', 'no-history', '방문 기록이 쌓이면 손님을 나눠 드릴게요'],
    ] as const) {
      panel(id, 1, 1, { preview: preview(id, variant) });
      expect(screen.getByText(text)).toBeInTheDocument();
      cleanup();
      const err = panel(id, 1, 1, { preview: preview(id, 'error') });
      await userEvent.click(screen.getByRole('button', { name: /다시 시도/ }));
      expect(err.host.resetPreview).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
  it('empty coupon status offers the today-promotions path', async () => {
    const ui = panel('coupon-status', 1, 1, { preview: preview('coupon-status', 'none') });
    await userEvent.click(screen.getByRole('button', { name: /빈 시간 단골 쿠폰 열기/ }));
    expect(ui.host.openDetail).toHaveBeenCalledTimes(1);
  });
  it('no regulars and no stock disable the action; partial data shows the 확인 필요 note', () => {
    panel('slot-coupon', 1, 1, { preview: preview('slot-coupon', 'no-regulars') });
    expect(screen.getByRole('button', { name: /쿠폰 보내기/ })).toBeEnabled();
    expect(screen.getByText('보낼 단골이 없어요')).toBeInTheDocument();
    cleanup();
    panel('expiry-coupon', 2, 1, { preview: preview('expiry-coupon', 'partial') });
    expect(screen.queryByRole('button', { name: /쿠폰 만들기/ })).toBeNull();
    expect(screen.getByText('원가\u2060·기한이 빠진 품목이 있어요')).toBeInTheDocument();
  });
  it('detail shows the sentence and retry for an error state', async () => {
    const ui = detail('expiry-coupon', { featureId: 'expiry-coupon' }, { preview: preview('expiry-coupon', 'error') });
    await userEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    expect(ui.host.resetPreview).toHaveBeenCalledTimes(1);
  });
});

describe('marketing review regressions', () => {
  it.each(['slot-coupon', 'customer-groups'] as const)('blocks unconfigured SMS in %s', id => {
    sms.configured = false;
    const store = createWidgetDataStore();
    const dispatch = vi.spyOn(store, 'dispatch');
    detail(id, { featureId: id }, { store });
    if (id === 'slot-coupon') expect(screen.getByText(/문자를 보내려면 발신 번호와 무료수신거부 번호/)).toBeVisible();
    else {
      expect(screen.getByText('설정에서 문자 발신 번호와 무료 수신 거부 번호를 등록해 주세요')).toBeVisible();
    }
    const send = screen.getByRole('button', { name: /명에게 쿠폰 보내기/ });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('selects another expiry item in step one and keeps the write behind confirmation', async () => {
    const store = createWidgetDataStore();
    const model = expiryModel(store);
    const second = model.items.find(item => item.itemId !== model.target?.itemId)!;
    const name = itemNameKo(second.nameKey);
    const dispatch = vi.spyOn(store, 'dispatch');
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { store });
    const choice = screen.getByRole('radio', { name: label => label.includes(name) });
    await userEvent.click(choice);
    expect(screen.getByRole('radio', { name: label => label.includes(name) })).toBeChecked();
    expect(document.querySelector('.mkt-sms-fixed__body')).toHaveTextContent(name);
    await userEvent.click(screen.getByRole('button', { name: '쿠폰 만들기' }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeInTheDocument();
  });
});

describe('빈 시간 단골 쿠폰 detail (AC-289 · 290)', () => {
  it.each([
    { locale: 'ko', label: '문구 내용', help: /발신 번호와 무료수신거부 번호/, settings: '설정에서 등록하기' },
    { locale: 'en', label: 'Message text', help: /Register a sender number and a free opt-out number/, settings: 'Register in settings' },
  ] as const)('keeps sender setup by the send action in $locale', ({ locale, label, help, settings }) => {
    sms.configured = false;
    const rendered = detail('slot-coupon', { featureId: 'slot-coupon', view: 'send' }, { locale });
    const editor = screen.getByRole('textbox', { name: label });
    const preview = editor.closest('.ui-sms-preview') as HTMLElement;
    expect(preview.querySelector('[data-fixed="ad"]')).toHaveTextContent('(광고) 안숭잘부 카페');
    expect(preview.querySelector('[data-fixed="optout"]')).toHaveTextContent('무료수신거부');
    expect(preview).not.toHaveTextContent(/테스트|스토어사스/);
    expect(within(preview).queryByText(help)).toBeNull();
    expect(screen.getByText(help).closest('.mkt-slot-footer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: settings }));
    expect(rendered.host.openSettings).toHaveBeenCalledOnce();
  });

  it.each([100, 125] as const)('keeps the send summary beside the action at %i percent', textScale => {
    const { container } = detail('slot-coupon', { featureId: 'slot-coupon' }, { textScale });
    const style = document.createElement('style');
    style.textContent = ['src/ui/mastermanage.css', 'src/features/widgets/mkt-coupon/widget.css']
      .map(path => readFileSync(path, 'utf8')).join('\n');
    container.prepend(style);
    const time = screen.getByRole('group', { name: '발송 시각' });
    const summary = screen.getByRole('region', { name: '보내기 전 요약' });
    const send = screen.getByRole('button', { name: /쿠폰 보내기/ });
    expect(summary.parentElement).toBe(send.closest('.mkt-slot-footer'));
    expect(time.closest('.mkt-slot-footer')).toBeNull();
    const rows = Array.from(summary.querySelectorAll('dl > div'));
    expect(rows).toHaveLength(3);
  });

  it('lists the slots, five masked recipients, the benefit amounts and a fixed preview', async () => {
    const store = regulars5();
    const m = slotModel(store);
    const first = firstSlotWithRegulars(m);
    const recipients = m.recipients.filter((r) => r.slotIds.includes(first.slotId));
    expect(recipients).toHaveLength(5);
    detail('slot-coupon', { featureId: 'slot-coupon' }, { store });
    // the form opens on the first slot that has someone to send to (a slot nobody matches only says 받는 사람이 없어요)
    expect(screen.getByRole('radio', { name: slotLabelKo(first) })).toBeChecked();
    for (const slot of m.openSlots) expect(screen.getByRole('radio', { name: slotLabelKo(slot) })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    // the recipient shows the one customer name the 회원 views show (masked), not a separate sample alias
    expect(screen.getAllByRole('checkbox').every(box => box.getAttribute('aria-labelledby')?.startsWith('rcp-'))).toBe(true);
    expect(screen.getAllByText(/^테○○$/)).toHaveLength(recipients.length);
    expect(screen.getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'true' || (c as HTMLInputElement).checked || c.hasAttribute('data-checked'))).toBe(true);
    for (const option of m.benefits.options) expect(screen.getByText(`쿠폰 1장당 남는 돈 ${won(option.marginPerCoupon)}`)).toBeInTheDocument();
    expect(screen.getByText(`${won(m.benefits.differenceVsNext)} 더 남아요`)).toBeInTheDocument();
    expect(screen.queryByText(/할인보다 남는 돈이 많아요/)).toBeNull();
    expect(screen.getByText('(광고)')).toBeInTheDocument();
    expect(screen.getByText('무료수신거부')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5명에게 쿠폰 보내기' })).toBeEnabled();
  });
  it('opens on the one regular of the cafe seed, not on a quiet slot nobody matches', () => {
    const m = slotModel();
    const first = firstSlotWithRegulars(m);
    expect(first.slotId).not.toBe(m.openSlots[0]!.slotId);
    detail('slot-coupon');
    expect(screen.getByRole('radio', { name: slotLabelKo(first) })).toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(m.recipients.filter((r) => r.slotIds.includes(first.slotId)).length);
    expect(screen.getByRole('button', { name: '1명에게 쿠폰 보내기' })).toBeEnabled();
  });
  it('refreshes the customer message when switching the selected slot', () => {
    const model = slotModel();
    const first = firstSlotWithRegulars(model);
    const other = model.openSlots.find(slot => slot.slotId !== first.slotId)!;
    detail('slot-coupon');
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.value).toContain(shortKo(first.date));
    fireEvent.change(input, { target: { value: '기존 시간의 문구' } });
    fireEvent.click(screen.getByRole('radio', { name: slotLabelKo(other) }));
    expect(input.value).toContain(`${shortKo(other.date)} ${other.startHour}~${other.endHour}시`);
  });
  it('deselecting and reselecting a recipient is immediate; zero recipients disables sending with the reason', async () => {
    detail('slot-coupon', { featureId: 'slot-coupon' }, { store: regulars5() });
    const boxes = () => screen.getAllByRole('checkbox');
    await userEvent.click(boxes()[0]!);
    expect(screen.getByRole('button', { name: '4명에게 쿠폰 보내기' })).toBeEnabled();
    await userEvent.click(boxes()[0]!);
    expect(screen.getByRole('button', { name: '5명에게 쿠폰 보내기' })).toBeEnabled();
    for (const box of boxes()) await userEvent.click(box);
    const send = screen.getByRole('button', { name: '쿠폰 보내기' });
    expect(send).toBeDisabled();
    expect(screen.getByText('문자 수신에 동의한 단골을 골라야 보낼 수 있어요')).toBeInTheDocument();
  });
  it.each(['22:00', '03:30'])('blocks %s delivery before the coupon confirmation', async (time) => {
    const store = regulars5(), dispatch = vi.spyOn(store, 'dispatch');
    detail('slot-coupon', { featureId: 'slot-coupon' }, { store });
    await userEvent.click(screen.getByRole('radio', { name: '예약' }));
    await pickTime(time);
    expect(screen.getByRole('button', { name: /명에게 쿠폰 보내기/ })).toBeDisabled();
    expect(screen.getByText('밤 9시부터 아침 8시 전에는 문자를 보낼 수 없어요')).toBeVisible();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(['10:30'])('a scheduled send at %s reaches the data layer', async (time) => {
    const store = regulars5();
    const dispatch = vi.spyOn(store, 'dispatch');
    detail('slot-coupon', { featureId: 'slot-coupon' }, { store });
    await userEvent.click(screen.getByRole('radio', { name: '예약' }));
    await pickTime(time);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: new RegExp(`^예약 시각 ${time}`) })).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(/밤 9시/)).toBeNull();
    const send = screen.getByRole('button', { name: /명에게 쿠폰 보내기/ });
    expect(send).toBeEnabled();
    await userEvent.click(send);
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'coupon.sendSlot', sendAt: `${TOMORROW}T${time}` }));
    expect(store.getSnapshot().tables.marketing.messageSend.every((m) => m.scheduledAt === `${TOMORROW}T${time}`)).toBe(true);
    expect(store.getSnapshot().tables.marketing.messageSend.length).toBeGreaterThan(0);
  });
  it('the schedule time is chosen from the kit time list (no browser time input); a picked time is shown and sendable', async () => {
    detail('slot-coupon');
    await userEvent.click(screen.getByRole('radio', { name: '예약' }));
    expect(screen.getByRole('button', { name: /^예약 시각 09:00/ })).toBeInTheDocument();
    expect(document.querySelector('input[type="time"]')).toBeNull();
    expect(screen.getByRole('button', { name: /명에게 쿠폰 보내기/ })).toBeEnabled();
    await pickTime('20:30');
    expect(screen.getByRole('button', { name: /^예약 시각 20:30/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /명에게 쿠폰 보내기/ })).toBeEnabled();
    expect(screen.getByText(new RegExp(`${TOMORROW.slice(5).replace('-', '/')}\\([월화수목금토일]\\) 20:30 예약`))).toBeInTheDocument();
  });
  it('recipients without consent are disabled with the reason (sample state with mixed consent)', () => {
    // the cafe seed has no customer that belongs to this sample state, so the test brings its own: one who agreed, two who did not
    const store = storeWithRegulars([true, false, false], 'consent-mixed');
    const m = slotModel(store, 'consent-mixed');
    const slot = firstSlotWithRegulars(m);
    const shown = m.recipients.filter((r) => r.slotIds.includes(slot.slotId));
    detail('slot-coupon', { featureId: 'slot-coupon' }, { store, preview: { family: 'normal', overrides: { 'slot-coupon': 'consent-mixed' } } });
    const disabled = screen.getAllByRole('checkbox').filter((c) => c.hasAttribute('disabled') || c.getAttribute('aria-disabled') === 'true');
    expect(disabled).toHaveLength(shown.filter((r) => !r.selectable).length);
    expect(disabled).toHaveLength(2);
    expect(screen.getAllByText('문자를 보낼 수 없어요(문자 동의 안 함)')).toHaveLength(2);
    expect(screen.getByRole('button', { name: `${shown.filter((r) => r.selectable).length}명에게 쿠폰 보내기` })).toBeEnabled();
  });
  it('focus:action opens with the first control focused', () => {
    detail('slot-coupon', { featureId: 'slot-coupon', view: 'send', focus: 'action' });
    expect(screen.getByRole('radio', { name: slotLabelKo(firstSlotWithRegulars(slotModel())) })).toHaveFocus();
  });

  it('queues one send on the confirmation and updates all visible counts together', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = regulars5();
    const before = statusModel(store);
    const perfBefore = perfText(store);
    const couponRows = store.getSnapshot().tables.marketing.coupon.length;
    // the numbers after the send come from a twin store that took the same command, read through the same selectors
    const twin = regulars5();
    twin.dispatch(sales('twin', slotModel(twin)));
    const sentRow = slotModel(twin).sent[0]!;
    const after = statusModel(twin);
    const h = host();
    const Detail = module('slot-coupon').Detail!;
    const Status = module('coupon-status').Panel;
    const Perf = () => { const v = useWidgetView('marketing-performance'); return <p data-testid="perf">{v.status === 'ready' ? `${v.model.issued}|${v.model.used}|${v.model.rate}|${v.model.rateDelta?.value}` : v.status}</p>; };
    renderWithKit(<><Status featureId="coupon-status" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={h} />
      <Detail featureId="slot-coupon" condition={{ kind: 'default' }} detailRef={{ featureId: 'slot-coupon' }} host={h} /><Perf /></>, { store });
    const statusValue = () => document.querySelector('[data-slot="coupon-status.metric.value"]')!;
    expect(statusValue()).toHaveTextContent(new RegExp(`^${before.activeCount}(?:개|장)$`));
    expect(screen.getByTestId('perf')).toHaveTextContent(perfBefore);
    await userEvent.click(screen.getByRole('button', { name: '5명에게 쿠폰 보내기' }));
    expect(screen.getByRole('heading', { name: '5명에게 쿠폰을 보낼까요?' })).toHaveFocus();
    expect(store.getSnapshot().tables.marketing.coupon).toHaveLength(couponRows);
    const confirm = screen.getByRole('button', { name: '보내기' });
    await userEvent.dblClick(confirm);
    expect(confirm).toBeDisabled();
    // same frame: the status panel, the results and the highlight changed at once
    expect(statusValue()).toHaveTextContent(new RegExp(`^${after.activeCount}(?:개|장)$`));
    expect(after.activeCount).toBe(before.activeCount + 1);
    expect(statusValue().closest('.mkt-live')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('perf')).toHaveTextContent(perfText(twin));
    expect(perfText(twin)).not.toBe(perfBefore);
    expect(store.getSnapshot().tables.marketing.coupon).toHaveLength(couponRows + 1);
    expect(screen.getByText('보내고 있어요')).toBeInTheDocument();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatchObject({ kind: 'success', messageKey: 'data.notices.notice.scheduled', params: { count: 5 } });
    expect(h.notify.mock.calls[0]![0].undoToken).toBeUndefined();
    act(() => { vi.advanceTimersByTime(700); });
    expect(screen.getByText(/발송을 예약했어요/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /에게 쿠폰을 보낼까요/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /되돌리기|Undo/ })).toBeNull();
    // the new line, no usage invented (Q-35)
    const benefit = slotModel(store).benefits.options.find((o) => o.id === slotModel(store).benefits.recommendedId)!;
    expect(screen.getByText(`빈 시간 ${benefitNameKo(benefit)} · ${sentRow.issued}장 중 0장 사용 · ${sentRow.daysLeft}일 남음`)).toBeInTheDocument();
    expect(sentRow.issued).toBe(5);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(statusValue().closest('.mkt-live')).not.toHaveAttribute('data-changed', 'true');
  });
  it('the sent coupon is the only one created and today-promotion cell for the slot is handled (one source)', async () => {
    const store = regulars5();
    const m = slotModel(store);
    const sent = firstSlotWithRegulars(m);
    store.dispatch(sales('pre', m));
    detail('slot-coupon', { featureId: 'slot-coupon' }, { store });
    expect(screen.queryByRole('radio', { name: slotLabelKo(sent) })).toBeNull();
    const others = m.openSlots.filter((s) => s.slotId !== sent.slotId);
    expect(others.length).toBeGreaterThan(0);
    for (const slot of others) expect(screen.getByRole('radio', { name: slotLabelKo(slot) })).toBeInTheDocument();
  });
  it('a failed command shows the sentence and does not report success', async () => {
    const store = regulars5();
    const dispatch = vi.spyOn(store, 'dispatch').mockReturnValue({ ok: false, code: 'VALIDATION', messageKey: 'data.marketing.error.sendAtPast' });
    const ui = detail('slot-coupon', { featureId: 'slot-coupon' }, { store });
    await userEvent.click(screen.getByRole('button', { name: '5명에게 쿠폰 보내기' }));
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ui.host.notify).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('지난 시각에는 보낼 수 없어요');
  });
  it('an edited message is sent as the owner text', async () => {
    const store = regulars5();
    detail('slot-coupon', { featureId: 'slot-coupon' }, { store });
    const area = screen.getByRole('textbox');
    fireEvent.change(area, { target: { value: '화요일에 오시면 샷을 드려요' } });
    await userEvent.click(screen.getByRole('button', { name: '5명에게 쿠폰 보내기' }));
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    const sends = store.getSnapshot().tables.marketing.messageSend;
    expect(sends.some((s) => 'raw' in s.body && s.body.raw === '화요일에 오시면 샷을 드려요')).toBe(true);
  });
});

describe('당일 소진 쿠폰 detail (AC-292 · 293 · 294)', () => {
  it.each([
    { textScale: 100, price: null },
    { textScale: 125, price: 3000 },
  ] as const)('starts at the recommended rate in one value field with its limit line at $textScale% text (price $price)', ({ textScale, price }) => {
    const store = createWidgetDataStore();
    // a lower price moves the recommended rate and the limit; both are read back from the model, never typed here
    if (price !== null) expect(store.dispatch({ type: 'menu.update', menuId: expiryModel(store).target!.menuId!, patch: { price } }).ok).toBe(true);
    const target = expiryModel(store).target!;
    if (price !== null) expect(target.price).toBe(price);
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { store, textScale });
    const field = screen.getByRole('spinbutton', { name: '할인율' });
    expect(field).toHaveValue(target.recommendedRate);
    expect(screen.getByText('%')).toBeInTheDocument();
    expect(screen.getByText(`${target.maxSliderRate}%까지 할인하면 원가 이상으로 팔아요`)).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('keeps the expiry preview to the customer-facing message', () => {
    sms.configured = false;
    detail('expiry-coupon');
    const preview = screen.getByRole('group', { name: '문구 미리보기' });
    for (const labelText of ['(광고)', '무료수신거부']) {
      const label = within(preview).getByText(labelText);
      expect(label.tagName).toBe('STRONG');
    }
    expect(within(preview).queryByText(/발신 번호/)).toBeNull();
    expect(screen.getByRole('button', { name: '설정에서 등록하기' }).closest('.mkt-expiry-action')).toBeInTheDocument();
    expect(within(preview).queryByRole('textbox')).toBeNull();
  });

  it('lists the items that expire today, the limit line, the recommended amounts and no set offer', () => {
    const m = expiryModel();
    const t = m.target!;
    const at = expiryAt(t, t.recommendedRate!);
    detail('expiry-coupon');
    // one row per item that ends today (the cafe seed has two); an item that ends later is not listed
    expect(m.items.every((item) => item.expiresOn === TODAY)).toBe(true);
    for (const item of m.items) expect(screen.getByText(`${itemNameKo(item.nameKey)} ${item.qty}개 · 오늘까지`)).toBeInTheDocument();
    expect(within(screen.getByRole('radiogroup', { name: '품목' })).getAllByRole('radio')).toHaveLength(m.items.length);
    expect(screen.getByRole('spinbutton', { name: '할인율' })).toHaveValue(t.recommendedRate);
    expect(screen.getByRole('radio', { name: '% 할인' })).toBeChecked();
    expect(screen.getByText(new RegExp(`할인가 ${krw(at.discountedPrice)}원 · 개당 남는 돈 ${krw(at.marginEach)}원 · 모두 팔면 남는 돈 ${krw(at.ifAllSold)}원`))).toBeInTheDocument();
    expect(screen.getByText(`못 팔면 원가 ${krw(at.lossIfDiscarded)}원을 버려요`)).toBeInTheDocument();
    expect(screen.getByText(`${t.maxSliderRate}%까지 할인하면 원가 이상으로 팔아요`)).toBeInTheDocument();
    expect(screen.queryByText(/최대 할인율/)).toBeNull();
    expect(screen.getByRole('button', { name: '계산 보기' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/아메리카노 세트/)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /세트/ })).toBeNull();
    expect(screen.queryByText(/2차 할인을 제안/)).toBeNull();
  });
  it('the percent field stops at the whole-percent limit and 1–100: wrong values say why and block creating', async () => {
    const t = expiryModel().target!;
    const limit = t.maxSliderRate!;
    const atLimit = expiryAt(t, limit);
    const atRecommended = expiryAt(t, t.recommendedRate!);
    detail('expiry-coupon');
    const field = screen.getByRole('spinbutton', { name: '할인율' });
    const create = screen.getByRole('button', { name: '쿠폰 만들기' });
    await userEvent.clear(field); await userEvent.type(field, String(limit));
    expect(screen.getByText(new RegExp(`할인가 ${krw(atLimit.discountedPrice)}원 · 개당 남는 돈 ${krw(atLimit.marginEach)}원`))).toBeInTheDocument();
    expect(atLimit.marginEach).toBeGreaterThan(0);
    expect(create).toBeEnabled();
    await userEvent.clear(field); await userEvent.type(field, String(limit + 1));
    expect(field).toHaveAccessibleDescription(/원가보다 싸게 팔아요$/);
    expect(screen.queryByRole('group', { name: '문구 미리보기' })).toBeNull();
    expect(create).toBeDisabled();
    await userEvent.clear(field); await userEvent.type(field, '101');
    expect(field).toHaveAccessibleDescription(/할인율은 1%부터 100%까지 넣을 수 있어요$/);
    await userEvent.clear(field);
    expect(field).toHaveAccessibleDescription(/할인율은 1%부터 100%까지 넣을 수 있어요$/);
    expect(create).toBeDisabled();
    await userEvent.type(field, String(t.recommendedRate));
    expect(screen.getByText(new RegExp(`할인가 ${krw(atRecommended.discountedPrice)}원 · 개당 남는 돈 ${krw(atRecommended.marginEach)}원`))).toBeInTheDocument();
    expect(create).toBeEnabled();
  });
  it('amount and set price are chosen with the same control; the unit, limit and wording follow the kind', async () => {
    const t = expiryModel().target!;
    const cost = t.unitCost!;
    const startAmount = Math.round((t.price - expiryAt(t, t.recommendedRate!).discountedPrice) / 100) * 100;
    const startSet = Math.round(expiryAt(t, t.recommendedRate!).discountedPrice / 100) * 100;
    const maxAmount = benefitMax('amount', t.price, cost);
    detail('expiry-coupon');
    await userEvent.click(screen.getByRole('radio', { name: '금액 할인' }));
    const amount = screen.getByRole('spinbutton', { name: '할인 금액' });
    expect(amount).toHaveValue(startAmount);
    expect(screen.getByText('원')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`할인가 ${krw(t.price - startAmount)}원 · 개당 남는 돈 ${krw(t.price - startAmount - cost)}원`))).toBeInTheDocument();
    expect(screen.getByText(`${krw(maxAmount)}원까지 할인하면 원가 이상으로 팔아요`)).toBeInTheDocument();
    await userEvent.clear(amount); await userEvent.type(amount, String(maxAmount + 100));
    expect(amount).toHaveAccessibleDescription(/여기부터는 손해예요$/);
    await userEvent.clear(amount); await userEvent.type(amount, String(t.price + 100));
    expect(amount).toHaveAccessibleDescription(/판매가보다 크게 넣을 수 없어요$/);
    await userEvent.clear(amount); await userEvent.type(amount, '0');
    expect(amount).toHaveAccessibleDescription(/할인 금액은 1원 이상으로 넣어 주세요$/);
    expect(screen.getByRole('button', { name: '쿠폰 만들기' })).toBeDisabled();
    await userEvent.clear(amount); await userEvent.type(amount, '500');
    expect(screen.getByText(new RegExp(`할인가 ${krw(t.price - 500)}원 · 개당 남는 돈 ${krw(t.price - 500 - cost)}원`))).toBeInTheDocument();
    expect(screen.getByText(/500원 할인해요/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: '가격 지정' }));
    const set = screen.getByRole('spinbutton', { name: '지정 가격' });
    expect(set).toHaveValue(startSet);
    expect(screen.getByText(`${krw(cost)}원 이상이면 원가 이상으로 팔아요`)).toBeInTheDocument();
    await userEvent.clear(set); await userEvent.type(set, String(cost - 100));
    expect(set).toHaveAccessibleDescription(/여기부터는 손해예요$/);
    await userEvent.clear(set); await userEvent.type(set, '2800');
    expect(screen.getByText(new RegExp(`할인가 2,800원 · 개당 남는 돈 ${krw(2800 - cost)}원 · 모두 팔면 남는 돈 ${krw((2800 - cost) * t.qty)}원`))).toBeInTheDocument();
    expect(screen.getByText(/오늘만 2,800원에 드려요/)).toBeInTheDocument();
    expect(screen.queryByText(/최대 할인율/)).toBeNull();
  });
  it.each([
    ['% 할인', '할인율', '40', '40% 할인', { benefitType: 'percent', benefitValue: 40 }, '오늘만 40%'],
    ['금액 할인', '할인 금액', '700', '700원 할인', { benefitType: 'amount', benefitValue: 700 }, '오늘만 700원 할인'],
    ['가격 지정', '지정 가격', '2800', '지정 가격 2,800원', { benefitType: 'set_price', benefitValue: 2_800 }, '오늘만 지정 가격 2,800원'],
  ] as const)('%s: the confirmation, the stored coupon and the coupon list name the same benefit', async (kindLabel, fieldLabel, typed, shown, stored, listSuffix) => {
    const listName = `${itemNameKo(expiryModel().target!.nameKey)} ${listSuffix}`;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createWidgetDataStore();
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { store });
    await userEvent.click(screen.getByRole('radio', { name: kindLabel }));
    const field = screen.getByRole('spinbutton', { name: fieldLabel });
    await userEvent.clear(field); await userEvent.type(field, typed);
    await userEvent.click(screen.getByRole('button', { name: '쿠폰 만들기' }));
    expect(screen.getByText(shown)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    const coupon = store.getSnapshot().tables.marketing.coupon.find((c) => c.origin === 'expiry')!;
    expect(coupon).toMatchObject(stored);
    expect(JSON.stringify(coupon)).not.toMatch(/setPrice/);
    act(() => { vi.advanceTimersByTime(700); });
    cleanup();
    detail('coupon-status', { featureId: 'coupon-status' }, { store });
    expect(screen.getByText(listName)).toBeInTheDocument();
  });
  it('when the item gets its coupon elsewhere the open form turns into the already-made sentence and cannot create a second one', () => {
    const store = createWidgetDataStore();
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { store });
    expect(screen.getByRole('button', { name: '쿠폰 만들기' })).toBeEnabled();
    act(() => { store.dispatch({ type: 'coupon.createExpiry', itemId: expiryModel(store).target!.itemId, benefit: { kind: 'percent', value: 30 }, route: 'sms', idempotencyKey: 'other-tab' }); });
    expect(screen.getByRole('button', { name: '쿠폰 만들기' })).toBeDisabled();
    expect(screen.getAllByText('오늘 쿠폰을 이미 만들었어요').length).toBeGreaterThan(0);
    expect(store.getSnapshot().tables.marketing.coupon.filter((c) => c.origin === 'expiry')).toHaveLength(1);
  });
  it('creates one text coupon for consenting regulars even when confirmation is pressed twice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createWidgetDataStore();
    const people = expiryModel(store).routes.sms.recipients;
    expect(people).toBeGreaterThan(0);
    const ui = detail('expiry-coupon', { featureId: 'expiry-coupon' }, { store });
    expect(screen.getByRole('radio', { name: `단골 문자(문자 동의 ${people}명)` })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '쿠폰 만들기' }));
    expect(screen.getByRole('heading', { name: `${people}명에게 쿠폰을 보낼까요?` })).toBeInTheDocument();
    await userEvent.dblClick(screen.getByRole('button', { name: '보내기' }));
    const created = store.getSnapshot().tables.marketing.coupon.filter((c) => c.origin === 'expiry');
    expect(created).toHaveLength(1);
    expect(store.getSnapshot().tables.marketing.couponCode.find((c) => c.couponId === created[0]!.couponId)?.issueCount).toBe(people);
    expect(ui.host.notify).toHaveBeenCalledTimes(1);
    expect(ui.host.notify.mock.calls[0]![0]).toMatchObject({ messageKey: 'data.marketing.notice.couponCreated' });
    act(() => { vi.advanceTimersByTime(700); });
    expect(screen.getByText('발송을 예약했어요')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /에게 쿠폰을 보낼까요/ })).toBeNull();
    expect(screen.getByText('오늘 쿠폰을 이미 만들었어요')).toBeInTheDocument();
  });
  it('place news: copy text first, nothing counts until 올렸어요', async () => {
    const store = createWidgetDataStore();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { store });
    await userEvent.click(screen.getByRole('radio', { name: '플레이스 소식(새 손님)' }));
    await userEvent.click(screen.getByRole('button', { name: '쿠폰 만들기' }));
    expect(screen.getByRole('heading', { name: '쿠폰을 만들까요?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '쿠폰 만들기' }));
    expect(screen.queryByRole('heading', { name: '쿠폰을 만들까요?' })).toBeNull();
    const code = store.getSnapshot().tables.marketing.couponCode.find((c) => c.route === 'place_news' && c.activatedAt === null && c.couponId.startsWith('c-') && c.couponId.length > 0 && !c.videoId);
    expect(code).toBeDefined();
    expect(screen.getByText(new RegExp(`오늘만! ${itemNameKo(expiryModel(store).target!.nameKey).replace(/[()]/g, '\\$&')} 40% 할인`))).toBeInTheDocument();
    const posted = screen.getByRole('button', { name: '올렸다고 표시하기' });
    await userEvent.click(screen.getByRole('button', { name: /복사/ }));
    expect(store.getSnapshot().tables.marketing.couponCode.find((c) => c.codeId === code!.codeId)?.activatedAt).toBeNull();
    await userEvent.click(posted);
    expect(store.getSnapshot().tables.marketing.couponCode.find((c) => c.codeId === code!.codeId)?.activatedAt).not.toBeNull();
    expect(screen.getByText('올렸다고 표시했어요. 이제 쿠폰 코드 사용을 집계해요')).toBeInTheDocument();
  });
  it('the item count follows the inventory model; partial data blocks creating', () => {
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { preview: { family: 'normal', overrides: { 'expiry-coupon': 'partial' } } });
    expect(screen.getByText('원가\u2060·기한이 빠진 품목이 있어요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '쿠폰 만들기' })).toBeDisabled();
  });
});

describe('진행 중인 쿠폰 detail (AC-299 · 300)', () => {
  it('lists every running coupon with usage and days left, the ending-soon line, the ended list and the month total', () => {
    // the ending-soon coupon: the cafe seed's running coupon, moved to end in two days
    const store = storeWithEndingCoupon();
    const m = statusModel(store);
    detail('coupon-status', { featureId: 'coupon-status' }, { store });
    const rows = within(screen.getByRole('table', { name: '진행 중인 쿠폰 목록' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(m.rows.length);
    m.rows.forEach((row, i) => {
      expect(rows[i]).toHaveTextContent(rawName(row.name));
      expect(rows[i]).toHaveTextContent(`${row.used}/${row.issued}`);
      expect(rows[i]).toHaveTextContent(`${row.daysLeft}일 남음`);
    });
    expect(m.endingSoonCount).toBe(1);
    expect(screen.getByText(`진행 중 ${m.activeCount}개`)).toBeInTheDocument();
    expect(screen.getByText(`곧 끝나는 쿠폰 ${m.endingSoonCount}개`)).toBeInTheDocument();
    expect(screen.getByText(monthLineKo(m, false))).toBeInTheDocument();
    expect(screen.queryByText(/리뷰 고마워요/)).toBeNull();
  });
  it('writes the month total sum only because it is true: DATA-FIX item 9 (877f99a) bounds the ended list to November, so 223 + 142 = 365 on the cafe seed', () => {
    const m = statusModel();
    expect(m).toMatchObject({ runningUsed: 223, endedUsed: 142, monthUsed: 365 });
    expect(m.ended).toHaveLength(1);
    expect(m.monthUsed).toBe(m.runningUsed + (m.endedUsed ?? 0));
    detail('coupon-status');
    expect(document.querySelector('[data-slot="coupon-status.total"]')).toHaveTextContent('이번 달 사용 365장 = 진행 중 223장 + 끝난 쿠폰 142장');
    expect(screen.getByText('이번 달 끝난 쿠폰 1개')).toBeInTheDocument();
  });
  it('pause moves a running coupon to paused with an undo token, undo brings it back; extend adds 7 days with an undo token; the month count never changes', async () => {
    const store = createWidgetDataStore();
    const m0 = statusModel(store);
    const row0 = m0.rows[0]!;
    const name = rawName(row0.name);
    const ui = detail('coupon-status', { featureId: 'coupon-status' }, { store });
    const total = () => document.querySelector('[data-slot="coupon-status.total"]')!.textContent;
    expect(total()).toContain(`${m0.monthUsed}장`);
    await userEvent.click(screen.getByRole('button', { name: `${name} 일시 중지하기` }));
    // GD-3 (U-03): the paused coupon stays listed but leaves the running count, and the header names it
    expect(screen.getByText(`진행 중 ${m0.activeCount - 1}개 · 중지 1개`)).toBeInTheDocument();
    const pauseNotice = ui.host.notify.mock.calls[0]![0];
    // DATA-FIX item 10 (877f99a): the paused coupon's name travels in the notice params, so the toast can name it.
    expect(name).toBe('오후 한산시간 디저트 1,000원 할인');
    expect(pauseNotice).toMatchObject({ messageKey: 'data.marketing.notice.paused', params: { name } });
    expect(pauseNotice.undoToken).toEqual(expect.any(String));
    expect(total()).toContain(`${m0.monthUsed}장`);
    act(() => { store.undo(pauseNotice.undoToken); });
    expect(screen.getByText(`진행 중 ${m0.activeCount}개`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: `${name} 7일 늘리기` }));
    const extend = ui.host.notify.mock.calls[1]![0];
    expect(extend).toMatchObject({ messageKey: 'data.marketing.notice.extended', params: { days: 7 } });
    expect(extend.undoToken).toEqual(expect.any(String));
    const row = within(screen.getByRole('table', { name: '진행 중인 쿠폰 목록' })).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent(`${row0.daysLeft + 7}일 남음`);
    expect(total()).toContain(`${m0.monthUsed}장`);
    expect(statusModel(store).monthUsed).toBe(m0.monthUsed);
  });
  it('a paused coupon shows the 중지 badge and a resume button', async () => {
    const store = createWidgetDataStore();
    const row = statusModel(store).rows[0]!;
    store.dispatch({ type: 'coupon.pause', couponId: row.couponId });
    detail('coupon-status', { featureId: 'coupon-status' }, { store });
    expect(screen.getByText('일시 중지됨')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${rawName(row.name)} 다시 시작하기` })).toBeInTheDocument();
  });
  it('the reminder with nobody to reach: the preview says so inline, sending is blocked, and nothing is recorded (GD-3)', async () => {
    const store = storeWithEndingCoupon();
    const model = (): CouponStatusModel => { const v = selectWidget(store.getSnapshot(), 'coupon-status', { kind: 'default' }, 'normal'); if (v.status !== 'ready') throw new Error('not ready'); return v.model as CouponStatusModel; };
    const target = model().rows.find((r) => r.endingSoon && r.canNotify)!;
    expect(target.reminderRecipients, 'the fixture needs an ending-soon coupon with no text targets').toBe(0);
    const ui = detail('coupon-status', { featureId: 'coupon-status', focus: 'action' }, { store });
    const send = screen.getByRole('button', { name: '알림 보내기(받는 사람 0명)' });
    expect(send).toBeDisabled();
    const reason = screen.getByRole('alert');
    expect(reason).toHaveTextContent('알림을 보낼 수 있는 손님이 없어요');
    expect(send).toHaveAccessibleDescription('알림을 보낼 수 있는 손님이 없어요');
    expect(store.getSnapshot().tables.marketing.couponReminder).toHaveLength(0);
    expect(ui.host.notify).not.toHaveBeenCalled();
  });
  it('queues the reminder for the previewed recipients with no undo and opens from focus:action', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createWidgetDataStore();
    // a sell-today text coupon ends today, so it is ending soon, and it has text targets that still consent
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: expiryModel(store).target!.itemId, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'rem-fixture' }).ok).toBe(true);
    const view = selectWidget(store.getSnapshot(), 'coupon-status', { kind: 'default' }, 'normal');
    const expected = view.status === 'ready' ? (view.model as CouponStatusModel).rows.find((r) => r.endingSoon && r.canNotify)!.reminderRecipients : -1;
    expect(expected).toBeGreaterThan(0);
    const ui = detail('coupon-status', { featureId: 'coupon-status', focus: 'action' }, { store });
    expect(screen.getByText('(광고)')).toBeInTheDocument();
    expect(screen.getByText('무료수신거부')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    const before = store.getSnapshot().tables.marketing.couponReminder.length;
    await userEvent.click(screen.getByRole('button', { name: `알림 보내기(받는 사람 ${expected}명)` }));
    await userEvent.dblClick(screen.getByRole('button', { name: '보내기' }));
    expect(store.getSnapshot().tables.marketing.couponReminder.length).toBe(before + 1);
    expect(store.getSnapshot().tables.marketing.couponReminder.at(-1)?.recipients).toBe(expected);
    expect(ui.host.notify).toHaveBeenCalledTimes(1);
    expect(ui.host.notify.mock.calls[0]![0].undoToken).toBeUndefined();
    act(() => { vi.advanceTimersByTime(700); });
    expect(screen.getByText('발송을 예약했어요')).toBeInTheDocument();
  });
  it('shows ended coupons on demand', async () => {
    const { ended } = statusModel();
    detail('coupon-status');
    await userEvent.click(screen.getByText(`이번 달 끝난 쿠폰 ${ended.length}개`));
    expect(screen.getAllByText(/종료$/).length).toBe(ended.length);
    // short dates with the weekday, never `10월 18일`
    for (const row of ended) expect(screen.getByText(new RegExp(`${shortKo(row.endsOn).replace(/[()]/g, '\\$&')} 종료$`))).toBeInTheDocument();
  });
});

describe('손님 그룹 detail (AC-302 · 303)', () => {
  it('tabs with the three group counts and the card-payment note; masked names with last visit and usual cycle', async () => {
    const { counts } = groupsModel();
    detail('customer-groups');
    expect(screen.getByRole('tab', { name: `떠날 수 있는 손님 ${counts['churn-risk']}` })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: `첫 방문 ${counts['first-visit']}` })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: `단골 ${counts.regular}` })).toBeInTheDocument();
    expect(screen.getByText('매장 결제 기준이에요')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: `첫 방문 ${counts['first-visit']}` }));
    expect(screen.getAllByText(/마지막 방문/).length).toBe(counts['first-visit']);
    await userEvent.click(screen.getByRole('tab', { name: `단골 ${counts.regular}` }));
    expect(screen.getAllByText(/마지막 방문/).length).toBe(counts.regular);
    // last visits are short dates with the weekday
    const lastVisit = groupsModel().groups.find((g) => g.id === 'regular')!.customers[0]!.lastVisit;
    expect(screen.getAllByText(new RegExp(`마지막 방문 ${shortKo(lastVisit).replace(/[()]/g, '\\$&')}`)).length).toBeGreaterThan(0);
  });
  it('a group without customers names its next step and jumps to the tab where coupons are sent (A10)', async () => {
    const base = createWidgetDataStore();
    const marketing = base.getSnapshot().tables.marketing;
    // nobody visited exactly once: remove the visits of the one-visit customers so the first-visit group is empty
    const first = groupsModel(base).groups.find((g) => g.id === 'first-visit')!.customers.map((c) => c.customerId);
    expect(first.length).toBeGreaterThan(0);
    const store = createWidgetDataStore({ marketing: { ...marketing, mktVisit: marketing.mktVisit.filter((v) => !first.includes(v.customerId)) } });
    expect(groupsModel(store).groups.find((g) => g.id === 'first-visit')!.customers).toHaveLength(0);
    detail('customer-groups', { featureId: 'customer-groups' }, { store });
    await userEvent.click(screen.getByRole('tab', { name: /^첫 방문 0/ }));
    expect(screen.getByText('이 그룹에는 손님이 없어요')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '떠날 수 있는 손님 보기' }));
    expect(screen.getByRole('tab', { name: /^떠날 수 있는 손님/ })).toHaveAttribute('aria-selected', 'true');
  });
  it('no visit history: the detail writes the next step and its button opens the member list; the panel offers the same button', async () => {
    const preview = { family: 'normal' as const, overrides: { 'customer-groups': 'no-history' } };
    const ui = detail('customer-groups', { featureId: 'customer-groups' }, { preview });
    expect(screen.getByText('방문 기록이 쌓이면 손님을 나눠 드릴게요')).toBeInTheDocument();
    expect(screen.getByText(/회원목록에서 연락처와 문자 동의를 확인해 두세요/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '회원목록 열기' }));
    expect(ui.host.openLinked).toHaveBeenCalledWith({ featureId: 'members' });
    cleanup();
    const p = panel('customer-groups', 1, 1, { preview });
    await userEvent.click(screen.getByRole('button', { name: /회원목록 열기/ }));
    expect(p.host.openDetail).toHaveBeenCalledWith({ featureId: 'members' });
  });
  it('unchecked customers stay unchecked after closing and reopening the detail (H5)', async () => {
    const store = createWidgetDataStore();
    const first = detail('customer-groups', { featureId: 'customer-groups' }, { store });
    const boxes = () => screen.getAllByRole('checkbox').filter((c) => !c.hasAttribute('disabled') && c.getAttribute('aria-disabled') !== 'true');
    const total = boxes().length;
    await userEvent.click(boxes()[0]!);
    expect(screen.getByRole('button', { name: `${total - 1}명에게 쿠폰 보내기` })).toBeEnabled();
    first.unmount();
    detail('customer-groups', { featureId: 'customer-groups' }, { store });
    expect(screen.getByRole('button', { name: `${total - 1}명에게 쿠폰 보내기` })).toBeEnabled();
    // a new run (a new store) starts clean
    cleanup();
    detail('customer-groups', { featureId: 'customer-groups' }, { store: createWidgetDataStore() });
    expect(screen.getByRole('button', { name: `${total}명에게 쿠폰 보내기` })).toBeEnabled();
  });
  it('the consenting customers are selected and the others are disabled with the reason; fixed ad lines', () => {
    const { churnRisk } = groupsModel();
    const consenting = churnRisk.filter((c) => c.selectable).length;
    const refusing = churnRisk.length - consenting;
    expect(consenting).toBeGreaterThan(0);
    expect(refusing).toBeGreaterThan(0);
    detail('customer-groups');
    expect(screen.getAllByRole('checkbox')).toHaveLength(churnRisk.length);
    expect(screen.getAllByRole('checkbox').filter((c) => c.hasAttribute('disabled') || c.getAttribute('aria-disabled') === 'true')).toHaveLength(refusing);
    expect(screen.getAllByText('동의 안 함')).toHaveLength(refusing);
    expect(screen.getByRole('button', { name: `${consenting}명에게 쿠폰 보내기` })).toBeEnabled();
    expect(screen.getByText('(광고)')).toBeInTheDocument();
    expect(screen.getByText('무료수신거부')).toBeInTheDocument();
  });
  it('identifies the coupon above the editable customer message and keeps the sender setup outside it', () => {
    sms.configured = false;
    const ui = detail('customer-groups');
    const preview = screen.getByRole('group', { name: '문구 미리보기' });
    expect(preview).toHaveTextContent('무료수신거부');
    expect(preview).not.toHaveTextContent('설정에서');
    const coupon = screen.getByText(/다시 와 주셔서 고마워요/);
    expect(coupon.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '설정 열기' }));
    expect(ui.host.openSettings).toHaveBeenCalledOnce();
  });
  it('shows the selected recipient count once in the send button', () => {
    detail('customer-groups');
    const consenting = groupsModel().churnRisk.filter(c => c.selectable).length;
    expect(screen.queryByText(`받는 사람 ${consenting}명`)).toBeNull();
    expect(screen.getByRole('button', { name: `${consenting}명에게 쿠폰 보내기` })).toBeEnabled();
  });
  it('sending reaches out to the consenting customers: coupons issued once, a new active line appears, no undo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createWidgetDataStore();
    const consenting = groupsModel(store).churnRisk.filter((c) => c.selectable).length;
    const running = statusModel(store).activeCount;
    const h = host();
    const Detail = module('customer-groups').Detail!;
    const Status = module('coupon-status').Panel;
    renderWithKit(<><Status featureId="coupon-status" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={h} />
      <Detail featureId="customer-groups" condition={{ kind: 'default' }} detailRef={{ featureId: 'customer-groups', view: 'reach-out', focus: 'action' }} host={h} /></>, { store });
    await userEvent.click(screen.getByRole('button', { name: `${consenting}명에게 쿠폰 보내기` }));
    expect(screen.getByRole('heading', { name: `${consenting}명에게 쿠폰을 보낼까요?` })).toBeInTheDocument();
    await userEvent.dblClick(screen.getByRole('button', { name: '보내기' }));
    const issued = store.getSnapshot().tables.marketing.coupon.filter((c) => c.origin === 'group');
    expect(issued).toHaveLength(1);
    expect(store.getSnapshot().tables.marketing.couponTarget.filter((t) => t.couponId === issued[0]!.couponId)).toHaveLength(consenting);
    expect(document.querySelector('[data-slot="coupon-status.metric.value"]')).toHaveTextContent(`${running + 1}개`);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0].undoToken).toBeUndefined();
    act(() => { vi.advanceTimersByTime(700); });
    expect(screen.getByText('발송을 예약했어요')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /에게 쿠폰을 보낼까요/ })).toBeNull();
  });
  it('disabled when no consenting customers: the send button is not offered in the panel', () => {
    panel('customer-groups', 1, 1, { preview: { family: 'normal', overrides: { 'customer-groups': 'partial' } } });
    expect(screen.getByText('일부 손님의 방문 기록이 부족해요')).toBeInTheDocument();
  });
});

describe('summaries and languages', () => {
  const Summary = ({ id }: { id: FeatureId }) => { const s = module(id).useSummary({ featureId: id, condition: { kind: 'default' } }); return <p data-testid="s">{s}</p>; };
  it('useSummary gives the key sentence in the current language and sample state', () => {
    const slot = slotModel(); const status = statusModel(); const { counts } = groupsModel();
    for (const [id, locale, text] of [
      ['slot-coupon', 'ko', `내일부터 7일 빈 시간 ${slot.slotCount}개, 맞춤 단골 ${slot.regularsCount}명`], ['coupon-status', 'ko', `진행 중인 Navis 코드 쿠폰 ${status.activeCount}개, 곧 끝나는 쿠폰 ${status.endingSoonCount}개`],
      ['customer-groups', 'ko', `떠날 수 있는 손님 ${counts['churn-risk']}명, 첫 방문 ${counts['first-visit']}명, 최근 방문 기준 단골 ${counts.regular}명`], ['expiry-coupon', 'ko', `오늘 팔 품목 ${expiryModel().items.length}개`],
      ['slot-coupon', 'en', `${slot.slotCount} quiet slots in the next 7 days, ${slot.regularsCount} matching regulars`],
    ] as [FeatureId, Locale, string][]) {
      renderWithKit(<Summary id={id} />, { locale });
      expect(screen.getByTestId('s')).toHaveTextContent(text);
      cleanup();
    }
    renderWithKit(<Summary id="coupon-status" />, { preview: { family: 'normal', overrides: { 'coupon-status': 'none' } } });
    expect(screen.getByTestId('s')).toHaveTextContent('진행 중인 쿠폰이 없어요. 빈 시간 단골 쿠폰을 만들어 보세요');
  });
  it('localizes details except store data and the fixed text of the outgoing SMS', () => {
    const owner = [...expiryModel().items.map((i) => itemNameKo(i.nameKey)), ...statusModel().rows.map((r) => rawName(r.name)), ...statusModel().ended.map((r) => rawName(r.name))];
    const sms = ['(광고) 안숭잘부 카페', '무료수신거부'];
    const strip = (text: string) => [...owner, ...sms].reduce((acc, name) => acc.split(name).join(''), text).replace(/[가-힣]○[가-힣\d○]*/g, '');
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      for (const id of ['slot-coupon', 'expiry-coupon', 'coupon-status', 'customer-groups'] as const) {
        const ui = detail(id, { featureId: id }, { locale });
        const localized = ui.container.cloneNode(true) as HTMLElement;
        if (id === 'coupon-status') localized.querySelectorAll('details[lang="ko"], section[lang="ko"][aria-label="네이버 쿠폰"]').forEach(el => el.remove());
        expect(strip(localized.textContent ?? ''), `${locale} ${id}`).not.toMatch(/[가-힣]/);
        cleanup();
        const p = panel(id, 2, 2, { locale });
        expect(strip(p.container.textContent ?? ''), `${locale} ${id} panel`).not.toMatch(/[가-힣]/);
        cleanup();
      }
    }
  });
  it('shows the English and 中文 sentences with the same numbers (AC-320)', async () => {
    const t = expiryModel().target!;
    const at = expiryAt(t, t.recommendedRate!);
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { locale: 'en' });
    expect(screen.getByText(new RegExp(`Price ₩${krw(at.discountedPrice)} · You keep ₩${krw(at.marginEach)} each · If all sell ₩${krw(at.ifAllSold)}`))).toBeInTheDocument();
    cleanup();
    detail('expiry-coupon', { featureId: 'expiry-coupon' }, { locale: 'zh-Hans' });
    expect(screen.getByText(new RegExp(`折后价 ${krw(at.discountedPrice)}韩元 · 每个剩余 ${krw(at.marginEach)}韩元 · 全部售出 ${krw(at.ifAllSold)}韩元`))).toBeInTheDocument();
    expect(screen.queryByText(/最大折扣率/)).toBeNull();
  });
});

it('reminder target uses a real no-break space', () => {
  const store = storeWithEndingCoupon();
  const row = statusModel(store).rows.find((r) => r.endingSoon && r.canNotify)!;
  detail('coupon-status', { featureId: 'coupon-status', focus: 'action' }, { store });
  expect(document.querySelector('.mkt-notify__target')?.textContent).toContain(`${rawName(row.name)}\u00a0·\u00a0${row.daysLeft}일 남음`);
});

it('D231 uses matching limits and shows a result title for a sent quiet slot', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  detail('expiry-coupon');
  expect(screen.getByText(`${expiryModel().target!.maxSliderRate}%까지 할인하면 원가 이상으로 팔아요`)).toBeInTheDocument();
  cleanup();
  const m = slotModel();
  const first = firstSlotWithRegulars(m);
  const people = m.recipients.filter((r) => r.selectable && r.slotIds.includes(first.slotId)).length;
  detail('slot-coupon');
  await userEvent.click(screen.getByRole('button', { name: `${people}명에게 쿠폰 보내기` }));
  await userEvent.click(screen.getByRole('button', { name: '보내기' }));
  act(() => { vi.advanceTimersByTime(700); });
  expect(screen.getByText(`${slotLabelKo(first)} 단골 ${people}명에게 발송을 예약했어요`)).toBeInTheDocument();
});

describe('GD-3 marketing consistency labels', () => {
  it('the slot detail names the exact window dates and never calls it next week (S5-129)', () => {
    detail('slot-coupon');
    const line = document.querySelector('[data-slot="slot-coupon.window"]') as HTMLElement;
    const { window } = slotModel();
    expect(line).toHaveTextContent(`내일부터 7일 · ${shortKo(window.start)}~${shortKo(window.end)}`);
    expect(window.start).toBe(TOMORROW);
    expect(document.body.textContent).not.toMatch(/다음 ?주/);
    cleanup();
    detail('slot-coupon', { featureId: 'slot-coupon' }, { locale: 'en' });
    expect(document.querySelector('[data-slot="slot-coupon.window"]')).toHaveTextContent(`Next 7 days · ${shortEn(window.start)} – ${shortEn(window.end)}`);
  });
  it('the panel counts running coupons only and names the paused ones on their own line (U-03)', () => {
    const store = createWidgetDataStore();
    const before = statusModel(store);
    store.dispatch({ type: 'coupon.pause', couponId: before.rows[0]!.couponId });
    const q = panel('coupon-status', 2, 2, { store });
    expect(q.container.querySelector('[data-slot="coupon-status.metric.value"]')).toHaveTextContent(String(before.activeCount - 1));
    expect(q.container.textContent).toContain('중지된 쿠폰 1개');
  });
  it('the regular tab shows the visit basis and D-430 masked member numbers', async () => {
    const store = createWidgetDataStore();
    const regular = groupsModel(store).counts.regular;
    detail('customer-groups', { featureId: 'customer-groups' }, { store });
    await userEvent.click(screen.getByRole('tab', { name: `단골 ${regular}` }));
    const regularPanel = screen.getByRole('tabpanel', { name: `단골 ${regular}` });
    expect(regularPanel).toHaveTextContent(/최근 \d+일 안에 \d+번 이상 온 손님이에요/);
    expect(regularPanel).not.toHaveTextContent(`단골은 ${regular}명`);
    const listed = [...regularPanel.querySelectorAll('.ui-recipient-row__name')];
    const members = new Map(selectMembers(store.getSnapshot(), {}).rows.map(member => [member.customerId, member]));
    expect(listed.length).toBe(regular);
    let knownMemberNumbers = 0;
    for (const name of listed) {
      const member = members.get(name.closest('li')?.dataset.rowId ?? '');
      if (member?.memberCode) {
        knownMemberNumbers++;
        const surname = typeof member.name === 'string' ? Array.from(member.name)[0] : '손';
        expect(name.textContent).toBe(`${surname}○○ · ${member.memberCode}`);
      } else {
        expect(name.textContent).toMatch(/^\p{L}○○$/u);
      }
    }
    expect(knownMemberNumbers).toBeGreaterThan(0);
  });
});
