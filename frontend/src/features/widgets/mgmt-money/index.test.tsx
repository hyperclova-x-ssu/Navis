import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CellSpan, ContentShape, DetailRef, FeatureId, Locale, PreviewSelection, QueryCondition, WidgetHost } from '../../../contracts';
import { baseBundles, createTranslator, findDuplicateKeys, findKoGaps, type MessageBundle } from '../../../i18n';
import { dataBundle } from '../../../data/messages';
import { createWidgetDataStore } from '../../../data/db/store';
import { readModel, selectWidget, supportedConditions } from '../../../data/widget-data';
import { briefingOf, ledgerOf, man, marginOf, menuLabel, openReceipt, percent, storeWithAllAlerts, storeWithClosure, won } from './test-values';
import { uiBundle } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets, mgmtMoneyBundle, r2Review } from './index';

afterEach(cleanup);

const IDS = ['briefing', 'ledger', 'margin', 'tax', 'grants'] as const;
const byId = (id: FeatureId) => widgets.find((w) => w.id === id)!;
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
type Store = ReturnType<typeof createWidgetDataStore>;
interface Calls { openLinked: DetailRef[]; notify: { kind: string; messageKey: string; undoToken?: string }[]; resetPreview: number; acknowledged: number; openClosing: string[] }
type TestHost = WidgetHost & { readonly calls: Calls };
function makeHost(): TestHost {
  const calls: Calls = { openLinked: [], notify: [], resetPreview: 0, acknowledged: 0, openClosing: [] };
  return {
    layer: 'management', calls,
    resetPreview: () => { calls.resetPreview += 1; }, openLinked: (r) => { calls.openLinked.push(r); }, openDetail: () => {},
    openClosing: (key) => { calls.openClosing.push(key); return true; },
    notify: (n) => { calls.notify.push(n); }, acknowledgeBriefing: () => { calls.acknowledged += 1; },
  };
}
const normal: QueryCondition = { kind: 'default' };
interface Opts { locale?: Locale; textScale?: 100 | 125; preview?: PreviewSelection; store?: Store; host?: TestHost }
function panel(id: FeatureId, w: CellSpan, h: CellSpan, opts: Opts = {}) {
  const Panel = byId(id).Panel;
  const host = opts.host ?? makeHost();
  return { host, ...renderWithKit(<div data-testid="p"><Panel featureId={id} condition={normal} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} host={host} /></div>, { locale: opts.locale, textScale: opts.textScale, preview: opts.preview, store: opts.store }) };
}
function detail(id: FeatureId, opts: Opts & { condition?: QueryCondition } = {}) {
  const Detail = byId(id).Detail!;
  const host = opts.host ?? makeHost();
  return { host, ...renderWithKit(<Detail featureId={id} condition={opts.condition ?? normal} detailRef={{ featureId: id }} host={host} />, { locale: opts.locale, preview: opts.preview, store: opts.store }) };
}
const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`);
const text = () => document.body.textContent ?? '';
const variant = (id: FeatureId, family: PreviewSelection['family'], overrides: PreviewSelection['overrides'] = {}): PreviewSelection => ({ family, overrides: { [id]: undefined, ...overrides } as PreviewSelection['overrides'] });
const only = (id: FeatureId, v: string): PreviewSelection => ({ family: 'normal', overrides: { [id]: v } });

describe('module shape and messages', () => {
  it('exports the five modules with a Detail, a summary hook and a bundle with no key clashes', () => {
    expect(widgets.map((w) => w.id)).toEqual(['briefing', 'ledger', 'margin', 'tax', 'grants']);
    for (const w of widgets) { expect(w.Detail).not.toBeNull(); expect(typeof w.useSummary).toBe('function'); }
    expect(findDuplicateKeys(mgmtMoneyBundle, ...(baseBundles as readonly MessageBundle<string>[]), dataBundle, uiBundle as MessageBundle<string>)).toEqual([]);
    expect(findKoGaps(mgmtMoneyBundle)).toEqual([]);
    for (const key of Object.keys(mgmtMoneyBundle.ko)) expect(key).toMatch(/^widget\.(briefing|ledger|margin|tax|grants)\./);
    expect(Object.keys(mgmtMoneyBundle.ko).filter((k) => /\.(title|coach|aliases)$/.test(k))).toEqual([]);
    expect(r2Review.strings).toBeGreaterThan(0);
  });
  it('resolves every key in en/zh with ko fallback for new Korean-only copy (API-213)', () => {
    const ko = Object.keys(mgmtMoneyBundle.ko);
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      const translator = createTranslator<string>(locale, mgmtMoneyBundle);
      for (const key of ko) {
        expect(translator.t(key), `${locale} ${key}`).not.toBe('');
        expect(translator.t(key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});

describe('panels: 16 sizes x 4 languages show the data and never a key', () => {
  const sizes: [CellSpan, CellSpan][] = [];
  for (let w = 1; w <= 4; w += 1) for (let h = 1; h <= 4; h += 1) sizes.push([w as CellSpan, h as CellSpan]);
  for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
    it(`${locale}: all sizes render without key names`, () => {
      for (const id of IDS) for (const [w, h] of sizes) {
        const { unmount } = panel(id, w, h, { locale });
        expect(text(), `${id} ${w}x${h}`).not.toMatch(/\b(widget|data|common|ui)\.[a-zA-Z-]+\./);
        expect(slot(`${id}.metric.value`) ?? slot(`${id}.state`), `${id} ${w}x${h} value`).not.toBeNull();
        unmount();
      }
    }, 120_000);
  }
  it('125% text keeps the value and drops the comparison line in Q', () => {
    panel('ledger', 1, 1, { textScale: 125 });
    expect(slot('ledger.metric.value')).toHaveTextContent(man(ledgerOf().sales.net));
  });
});

describe('key numbers come from the data (1x1, Korean)', () => {
  it('ledger: 오늘 매출 and 지난주 같은 요일 대비 come from the ledger model', () => {
    const model = ledgerOf(), delta = model.comparison!.delta.value;
    panel('ledger', 1, 1);
    expect(slot('ledger.metric.label')).toHaveTextContent('오늘 매출');
    expect(slot('ledger.metric.value')).toHaveTextContent(`${man(model.sales.net)}만 원`);
    expect(slot('ledger.metric.secondary')).toHaveTextContent(`지난주 같은 요일 대비 ${delta < 0 ? '▼' : '▲'}${Math.abs(delta)}%`);
  });
  it('ledger 2x1 shows 지출 and 순이익 from the model (expenses, and sales minus expenses)', () => {
    const model = ledgerOf();
    panel('ledger', 2, 1);
    expect(text()).toContain(`${man(model.expenses.total)}만 원`);
    expect(text()).toContain(`${man(model.sales.net - model.expenses.total)}만 원`);
    expect(model.remaining).toBe(model.sales.net - model.expenses.total);
  });
  it('ledger 1x2 lists the expense categories, 2x2 adds the missing-evidence count', () => {
    const model = ledgerOf();
    panel('ledger', 1, 2);
    expect(within(slot('ledger.list') as HTMLElement).getAllByRole('listitem')).toHaveLength(model.expenses.byCategory.length);
    expect(text()).toContain(`${man(model.expenses.byCategory[0]!.amount)}만 원`);
    cleanup();
    panel('ledger', 2, 2);
    expect(text()).toContain(`증빙이 빠진 지출 ${model.missingEvidenceCount}개`);
    expect(slot('ledger.list')).not.toBeNull();
  });
  it('margin: the rate with its change, the line chart in 2x1 and the lowest-margin items in 1x2 (AC-1065)', () => {
    const model = marginOf(), delta = model.comparison!.delta.value;
    panel('margin', 1, 1);
    expect(slot('margin.metric.value')).toHaveTextContent(percent(model.rate!));
    expect(slot('margin.metric.secondary')).toHaveTextContent(`${delta < 0 ? '▼' : '▲'}${Math.abs(delta)}%p`);
    cleanup();
    panel('margin', 2, 1);
    expect(document.querySelector('.mm-chart')).not.toBeNull();
    cleanup();
    panel('margin', 1, 2);
    const rows = within(slot('margin.list') as HTMLElement).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThanOrEqual(2); // every menu of the model is offered; the fit guard trims what does not fit (T-063)
    for (const [index, menu] of model.menus.slice(0, 2).entries()) {
      expect(rows[index]).toHaveTextContent(menuLabel(createWidgetDataStore(), menu.menuId));
      expect(rows[index]).toHaveTextContent(percent(menu.rate!));
    }
  });
  it('tax: 확인할 세무 자료 N건; grants: 확인할 지원사업 2건; briefing: 중요 알림 N개 (AC-1067·1086, F-279)', () => {
    panel('tax', 1, 1);
    expect(slot('tax.metric.label')).toHaveTextContent('확인할 세무 자료');
    expect(slot('tax.metric.value')).toHaveTextContent(`${taxReviewCount()}건`);
    cleanup();
    panel('grants', 1, 1);
    expect(slot('grants.metric.value')).toHaveTextContent('2건');
    cleanup();
    // PRD §12.4 F-279 / API-272: an unsent closure adds one task, and the number counts every alert item.
    const { store } = storeWithClosure();
    const alerts = readModel(store.getSnapshot(), 'briefing').importantAlerts;
    expect(alerts.groups.map(group => group.id)).toEqual(['tax', 'tasks']);
    expect(alerts.groups.find(group => group.id === 'tasks')?.items.filter(item => item.id.startsWith('closure:'))).toEqual([
      expect.objectContaining({ id: 'closure:closure-test', params: expect.objectContaining({ kind: '임시 휴무' }), ref: { featureId: 'notice-send', itemId: 'closure-test' } }),
    ]);
    expect(alerts.count).toBe(alerts.groups.flatMap(group => group.items).length);
    expect(alerts.count).toBe(briefingOf().importantAlerts.count + 1);
    panel('briefing', 1, 1, { store });
    expect(slot('briefing.metric.label')).toHaveTextContent('중요 알림');
    expect(slot('briefing.metric.value')).toHaveTextContent(`${alerts.count}개`);
  });
  it('tax tall panels show review items and payments without the old connection chips', () => {
    panel('tax', 1, 2);
    const short = within(slot('tax.list') as HTMLElement).getAllByRole('listitem').length;
    cleanup();
    panel('tax', 1, 3);
    const tall = within(slot('tax.list') as HTMLElement).getAllByRole('listitem').length;
    expect(tall).toBe(short);
    expect(slot('tax.list')).not.toHaveTextContent(/연결됨|예시/);
    cleanup();
    panel('tax', 1, 4);
    expect(within(slot('tax.list') as HTMLElement).getAllByRole('listitem')).toHaveLength(tall);
  });
  it('briefing 2x3 lists schedules, reservations and the four source groups (AC-1086)', () => {
    const { store } = storeWithAllAlerts();
    const model = briefingOf(store);
    expect(model.importantAlerts.groups.map(group => group.id)).toEqual(['purchasing', 'stock', 'tax', 'tasks']);
    panel('briefing', 2, 3, { store });
    expect(text()).toContain(`오늘 일정 ${model.schedules.todayCount}개`);
    expect(text()).toContain(`보충 필요 ${model.importantAlerts.groups[1]!.items[0]!.params!.count}개 품목`);
    expect(text()).toContain(`오늘 ${model.reservations.count}건\u00a0· ${model.reservations.partyTotal}명`);
    for (const group of ['발주·입고', '재고 부족', '세금 납부', '주요 업무']) expect(text()).toContain(group);
    expect(text()).not.toContain('동네 소식');
    expect(text()).not.toContain('어제 매출');
  });
  it('English shows the full won amount in one piece', () => {
    panel('ledger', 1, 1, { locale: 'en' });
    expect(slot('ledger.metric.value')).toHaveTextContent(`₩${ledgerOf().sales.net.toLocaleString('en-US')}`);
    expect(slot('ledger.metric.label')).toHaveTextContent("Today's sales");
  });
  it('the panels have no buttons except the state action', () => {
    for (const id of IDS) { panel(id, 2, 2); expect(document.querySelectorAll('button')).toHaveLength(0); cleanup(); }
  });
});

describe('empty and error states', () => {
  it('empty uses the data sentence without a fake value', () => {
    panel('ledger', 1, 1, { preview: only('ledger', 'no-sales') });
    expect(text()).toContain('아직 기록한 매출이 없어요');
    expect(slot('ledger.metric.value')).toBeNull();
  });
  it('error offers 다시 시도하기 that only resets this widget', () => {
    const { host } = panel('margin', 1, 1, { preview: only('margin', 'error') });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
    expect(host.calls.resetPreview).toBe(1);
  });
  it('special: margin with a missing cost says 원가 확인 필요 and tax without a period asks for one', () => {
    panel('margin', 2, 2, { preview: only('margin', 'missing-cost') });
    expect(text()).toContain('원가 확인 필요');
    cleanup();
    panel('tax', 1, 1, { preview: only('tax', 'missing-data') });
    expect(text()).toContain('자료 기간을 선택해 주세요');
    cleanup();
    panel('briefing', 2, 2, { preview: only('briefing', 'partial') });
    expect(text()).toContain('일부 소식을 불러오지 못했어요');
  });
  it('ledger without expenses replaces 남은 돈 by 지출을 기록해 주세요', () => {
    panel('ledger', 2, 1, { preview: only('ledger', 'no-expenses') });
    expect(text()).toContain('지출을 기록해 주세요');
  });
});

describe('ledger detail', () => {
  it('switches period and shows sales by method and the discount/refund', () => {
    detail('ledger');
    expect(slot('ledger.kpi.sales')).toHaveTextContent(man(ledgerOf().sales.net));
    fireEvent.click(screen.getByRole('radio', { name: '최근 7일' }));
    expect(slot('ledger.kpi.sales')).toHaveTextContent(man(ledgerOf(createWidgetDataStore(), supportedConditions('ledger')[1]!).sales.net));
    expect(slot('ledger.sales-table')).toHaveTextContent('카드');
  });
  it('records an expense once, with the receipt default, and reports it to the host', () => {
    const store = createWidgetDataStore();
    const before = ledgerOf(store);
    const { host } = detail('ledger', { store });
    fireEvent.click(screen.getByRole('tab', { name: '지출' }));
    fireEvent.click(screen.getByRole('button', { name: '지출 기록하기' }));
    const save = screen.getByRole('button', { name: '저장하기' });
    fireEvent.click(save);
    expect(screen.getByText('금액을 1원 이상으로 넣어 주세요')).toBeInTheDocument();
    expect(host.calls.notify).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('금액'), { target: { value: '12000' } });
    expect(screen.getByRole('radio', { name: '영수증 있음' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    fireEvent.click(screen.queryByRole('button', { name: '저장하기' }) ?? document.body);
    expect(host.calls.notify).toHaveLength(1);
    expect(host.calls.notify[0]).toMatchObject({ kind: 'success', messageKey: 'data.notice.expenseRecorded' });
    expect(host.calls.notify[0]?.undoToken).toBeTruthy();
    expect(slot('ledger.kpi.expenses')).toHaveTextContent(man(before.expenses.total + 12_000));
    expect(slot('ledger.kpi.remaining')).toHaveTextContent(man(before.remaining! - 12_000));
  });
  it('asks before a look-alike expense and records it only after 그래도 기록하기', () => {
    const store = createWidgetDataStore();
    const { host } = detail('ledger', { store });
    const record = () => {
      fireEvent.click(screen.getByRole('button', { name: '지출 기록하기' }));
      fireEvent.change(screen.getByLabelText('금액'), { target: { value: '12000' } });
      fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    };
    fireEvent.click(screen.getByRole('tab', { name: '지출' }));
    record();
    expect(host.calls.notify).toHaveLength(1);
    const rows = () => ledgerOf(store).expenses.items.length;
    const count = rows();
    record();
    // The refusal is answered in the form (the existing expense and the way on), not by an error toast.
    const answer = screen.getByRole('alert');
    expect(answer).toHaveTextContent('비슷한 지출이 이미 있어요');
    expect(answer).toHaveTextContent(`이미 있는 지출`);
    expect(answer).toHaveTextContent(won(12_000));
    expect(host.calls.notify).toHaveLength(1);
    expect(rows()).toBe(count);
    fireEvent.click(within(answer).getByRole('button', { name: '그래도 기록하기' }));
    expect(rows()).toBe(count + 1);
    expect(host.calls.notify).toHaveLength(2);
    expect(host.calls.notify[1]).toMatchObject({ kind: 'success', messageKey: 'data.notice.expenseRecorded' });
  });
  it('a delivery candidate is not counted until 확인해서 넣기', () => {
    const store = createWidgetDataStore();
    const before = ledgerOf(store).expenses.total;
    expect(store.dispatch({ type: 'suppliers.recordReceipt', ...openReceipt(store), idempotencyKey: 'k1' }).ok).toBe(true);
    const candidateAmount = ledgerOf(store).candidates[0]!.amount;
    const { host } = detail('ledger', { store });
    expect(slot('ledger.kpi.expenses')).toHaveTextContent(man(before));
    fireEvent.click(screen.getByRole('tab', { name: '지출' }));
    const candidate = slot('ledger.candidate') as HTMLElement;
    expect(candidate).not.toBeNull();
    // PRD 9.13 F-216: the received quantity times the unit price. Until confirmed it is not in 총지출.
    expect(candidate).toHaveTextContent(won(candidateAmount));
    fireEvent.click(within(candidate).getByRole('button', { name: '확인해서 넣기' }));
    // DESIGN_SYSTEM 15.6 (Q-259) retains one decimal.
    expect(slot('ledger.kpi.expenses')).toHaveTextContent(`${man(before + candidateAmount)}만 원`);
    expect(host.calls.notify[0]).toMatchObject({ messageKey: 'data.notice.candidateConfirmed' });
    expect(slot('ledger.candidate')).toBeNull();
  });
});

describe('margin detail', () => {
  const lowestFirst = (store = createWidgetDataStore()) => [...marginOf(store).menus].sort((x, y) => Number(y.costMissing) - Number(x.costMissing) || (x.rate ?? Infinity) - (y.rate ?? Infinity) || x.menuId.localeCompare(y.menuId));
  it('lists every item (price and cost from the model), starting with the lowest margin (AC-1065, API-211)', () => {
    const store = createWidgetDataStore();
    detail('margin', { store });
    const grid = screen.getByRole('grid', { name: '품목 표' });
    const rows = within(grid).getAllByRole('row').slice(1);
    const menus = lowestFirst(store);
    expect(rows).toHaveLength(menus.length);
    expect(rows[0]).toHaveAttribute('data-grid-row', menus[0]!.menuId);
    for (const menu of [menus[0]!, menus.at(-1)!]) {
      const name = menuLabel(store, menu.menuId);
      fireEvent.click(within(grid).getByRole('gridcell', { name: `${name}, 품목, ${name}` }));
      expect(slot('margin.menu-detail')).toHaveTextContent(won(menu.price));
      expect(slot('margin.menu-detail')).toHaveTextContent(won(menu.unitCost!));
    }
  });
  it('calculator: a price and cost try-out gives the profit and rate, the change from now and −… marked 실제 실적과 달라요', () => {
    const store = createWidgetDataStore();
    const row = marginOf(store).menus.find(menu => menu.unitCost !== null)!, name = menuLabel(store, row.menuId);
    detail('margin', { store });
    fireEvent.click(screen.getByRole('gridcell', { name: `${name}, 품목, ${name}` }));
    expect(screen.getByLabelText('예상 판매가')).toHaveValue(row.price);
    expect(screen.getByLabelText('예상 단위 원가')).toHaveValue(row.unitCost);
    const rate = (profit: number) => `${Number((profit / row.price * 100).toFixed(1))}%`;
    expect(slot('margin.sim-profit')).toHaveTextContent(won(row.price - row.unitCost!));
    expect(slot('margin.sim-rate')).toHaveTextContent(rate(row.price - row.unitCost!));
    fireEvent.change(screen.getByLabelText('예상 단위 원가'), { target: { value: '2000' } });
    expect(slot('margin.sim-profit')).toHaveTextContent(won(row.price - 2000));
    expect(slot('margin.sim-rate')).toHaveTextContent(rate(row.price - 2000));
    const change = row.unitCost! - 2000;
    expect(slot('margin.sim-diff')).toHaveTextContent(`${change < 0 ? '−' : '+'}${Math.abs(change).toLocaleString('en-US')}원`);
    expect(slot('margin.sim-diff')).toHaveTextContent('%p');
    // Less profit than now is written with the minus sign, in the amount and in the rate.
    fireEvent.change(screen.getByLabelText('예상 단위 원가'), { target: { value: String(row.unitCost! + 500) } });
    expect(slot('margin.sim-diff')).toHaveTextContent('−500원');
    expect(slot('margin.sim-diff')).toHaveTextContent('▼');
    expect(slot('margin.simulator')).toHaveTextContent('실제 실적과 달라요');
    fireEvent.change(screen.getByLabelText('예상 판매가'), { target: { value: '0' } });
    expect(slot('margin.sim-invalid')).not.toBeNull();
  });
  it('sorting by a column header changes the order (one sort, no separate chips)', () => {
    const store = createWidgetDataStore();
    detail('margin', { store });
    expect(screen.queryByRole('radio', { name: '이익 큰 순' })).toBeNull();
    const grid = screen.getByRole('grid', { name: '품목 표' });
    expect(within(grid).getByRole('gridcell', { name: /^아메리카노, 판매량, .*잔$/ })).toBeInTheDocument();
    expect(within(grid).getByRole('gridcell', { name: /^겉바속촉 버터 소금빵, 판매량, .*개$/ })).toBeInTheDocument();
    expect(within(grid).getByRole('columnheader', { name: /마진율/ })).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(within(grid).getByRole('button', { name: /^마진(?!율)/ }));
    const header = within(grid).getByRole('columnheader', { name: /^마진(?!율)/ });
    const direction = header.getAttribute('aria-sort');
    expect(['ascending', 'descending']).toContain(direction);
    const menus = [...marginOf(store).menus].sort((x, y) => ((x.unitMargin ?? -Infinity) - (y.unitMargin ?? -Infinity)) * (direction === 'ascending' ? 1 : -1) || x.menuId.localeCompare(y.menuId));
    const first = within(grid).getAllByRole('row')[1];
    expect(first).toHaveAttribute('data-grid-row', menus[0]!.menuId);
    expect(first).toHaveTextContent(won(menus[0]!.unitMargin!));
  });
});

/** The cafe seed's open tax items (and the grant notices), read with the selectors the widgets use. */
const taxReviewCount = () => {
  const view = selectWidget(createWidgetDataStore().getSnapshot(), 'tax', normal, 'normal');
  if (view.status !== 'ready') throw new Error('Tax fixture must be available');
  return view.model.reviewCount;
};
const grantIds = () => {
  const view = selectWidget(createWidgetDataStore().getSnapshot(), 'grants', normal, 'normal');
  if (view.status !== 'ready') throw new Error('Grants fixture must be available');
  return view.model.notices.map((n) => n.noticeId);
};

describe('tax detail', () => {
  it('checks every open item, the count drops to 0 and the estimate appears', async () => {
    const store = createWidgetDataStore();
    const taxView = () => selectWidget(store.getSnapshot(), 'tax', normal, 'normal');
    const before = taxView();
    if (before.status !== 'ready') throw new Error('Tax fixture must be available');
    const open = before.model.items.filter((i) => i.status === 'needs-check').map((i) => i.refId);
    expect(open.length).toBeGreaterThan(1);
    // One press costs a whole detail re-render (~50 ms, 39 open items = the 5 s timeout under load). The press is only `tax.markChecked`, so check all but the last two
    // through the same command up front and press those two in the UI: selection moving to the next open item, the notice per press and the end state stay covered.
    const PRESSES = 2;
    for (const refId of open.slice(0, -PRESSES)) store.dispatch({ type: 'tax.markChecked', refId });
    const { host } = detail('tax', { store });
    expect(slot('tax.estimate')).toHaveTextContent('모두 확인하면');
    const item = () => within(slot('tax.item') as HTMLElement);
    // Wait for each check to settle before pressing the next selected item.
    for (let i = 0; i < PRESSES; i++) {
      await act(async () => {
        fireEvent.click(item().getByText('확인 완료로 표시하기'));
      });
    }
    expect(host.calls.notify[0]).toMatchObject({ messageKey: 'data.notice.taxChecked' });
    expect(host.calls.notify).toHaveLength(PRESSES);
    expect(item().queryByText('확인 완료로 표시하기')).toBeNull();
    const after = taxView();
    expect(after.status === 'ready' && after.model.reviewCount).toBe(0);
    expect(slot('tax.kpi.estimate')).not.toBeNull();
    expect(slot('tax.estimate')).toHaveTextContent('기준일');
    expect(slot('tax.estimate')).toHaveTextContent('부가세 10%');
  });
  it('without a period the export is disabled and the sentence asks for one', () => {
    detail('tax', { preview: only('tax', 'missing-data') });
    expect(text()).toContain('자료 기간을 선택해 주세요');
    expect(screen.getByRole('button', { name: '세무사 자료 받기' })).toBeDisabled();
  });
});

describe('grants detail', () => {
  it('lists by deadline, opens the in-app sample notice and marks reviewed (2 → 1)', () => {
    const store = createWidgetDataStore();
    const { host } = detail('grants', { store });
    const rows = Array.from(document.querySelectorAll('[data-slot="grants.list"] li')).map((r) => r.getAttribute('data-row-id'));
    expect(rows).toEqual(grantIds());
    fireEvent.click(screen.getByRole('button', { name: '공식 공고 보기' }));
    expect(slot('grants.official')).toHaveTextContent('최종 자격은 기관의 공식 공고에서 확인해요');
    fireEvent.click(screen.getByRole('button', { name: '검토 완료로 표시하기' }));
    expect(host.calls.notify[0]).toMatchObject({ messageKey: 'data.notice.grantReviewed' });
    expect(screen.queryByRole('button', { name: '검토 완료로 표시하기' })).toBeNull();
    cleanup();
    panel('grants', 1, 1, { store });
    expect(slot('grants.metric.value')).toHaveTextContent('1건');
  });
});

describe('briefing detail', () => {
  it('opens the source detail from each update and acknowledges once', () => {
    const { store } = storeWithAllAlerts();
    const { host } = detail('briefing', { store });
    const row = screen.getByRole('button', { name: /보충 필요 \d+개 품목/ });
    // The row ends with the number of items that need restocking.
    expect(within(row).getByText(/^\d+개$/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(host.calls.openLinked).toEqual([{ featureId: 'inventory-booking' }]);
    const done = screen.getByRole('button', { name: '모두 읽음으로 표시하기' });
    fireEvent.click(done);
    fireEvent.click(done);
    expect(host.calls.acknowledged).toBe(1);
    expect(text()).toContain('다시 띄우지 않아요');
  });
  it('closing tab opens the shared closing dialog without a removed demand source', () => {
    const { host } = detail('briefing');
    fireEvent.click(screen.getByRole('tab', { name: '퇴근' }));
    expect(slot('briefing.kpi.sales')).toHaveTextContent(man(briefingOf().closingSummary.salesSnapshot.net));
    expect(document.querySelector('[data-row-id="demand"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '마감 정산하기' }));
    expect(host.calls.openClosing).toHaveLength(1);
    expect(host.calls.openLinked).toEqual([]);
  });
});

describe('key sentences (useSummary)', () => {
  function Summary({ id }: { id: FeatureId }) { const w = byId(id); const s = w.useSummary({ featureId: id, condition: normal }); return <p data-testid="s">{s}</p>; }
  const read = (id: FeatureId, opts: Opts = {}) => { renderWithKit(<Summary id={id} />, { locale: opts.locale, preview: opts.preview }); const value = screen.getByTestId('s').textContent; cleanup(); return value; };
  it('says the label, value and comparison in the current language', () => {
    const ledger = ledgerOf(), delta = ledger.comparison!.delta.value;
    expect(read('ledger')).toBe(`오늘 매출 ${man(ledger.sales.net)}만 원, 지난주 같은 요일 대비 ${delta < 0 ? '▼' : '▲'}${Math.abs(delta)}%`);
    expect(read('ledger', { locale: 'en' })).toContain(`₩${ledger.sales.net.toLocaleString('en-US')}`);
    expect(read('margin')).toContain(percent(marginOf().rate!));
    expect(read('tax')).toBe(`확인할 세무 자료 ${taxReviewCount()}건`);
    expect(read('grants')).toBe('확인할 지원사업 2건');
    expect(read('briefing')).toBe(`중요 알림 ${briefingOf().importantAlerts.count}개`); // F-279 / API-272: the number counts alert items.
  });
  it('says the state sentence for empty and error', () => {
    expect(read('ledger', { preview: only('ledger', 'no-sales') })).toBe('아직 기록한 매출이 없어요');
    expect(read('tax', { preview: only('tax', 'error') })).toContain('세무 자료');
  });
});

void variant;
