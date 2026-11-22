import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailRef, FeatureId, LayoutAdapter, QueryCondition, RunStore, WidgetModule } from '../../contracts';
import { getRegistry } from '../../catalog';
import { preview, screenPresets } from '../../layout';
import { testTime } from '../../layout/test-policy';
import { createRunStore, selectCommonNotice } from '../../state';
import { I18nProvider } from '../../i18n';
import { WidgetRegistryProvider, createWidgetHost, useWidgetModule, useWidgetSummary, useWidgetTapTarget } from './registry-context';

afterEach(cleanup);
const Panel = () => null;
const module = (id: FeatureId, extra: Partial<WidgetModule> = {}): WidgetModule => ({ id, Panel, Detail: Panel, useSummary: () => `${id} summary`, ...extra });
const wrap = (modules: readonly WidgetModule[], locale: 'ko' | 'en' = 'ko') => ({ children }: { children?: ReactNode }) => (
  <I18nProvider locale={locale}><WidgetRegistryProvider modules={modules}>{children}</WidgetRegistryProvider></I18nProvider>
);

describe('registry context hooks', () => {
  it('finds modules by id and returns undefined for the rest', () => {
    const ledger = module('ledger');
    const { result } = renderHook(() => [useWidgetModule('ledger'), useWidgetModule('margin')] as const, { wrapper: wrap([ledger]) });
    expect(result.current[0]).toBe(ledger);
    expect(result.current[1]).toBeUndefined();
  });
  it('summary falls back to the widget name in the current language when there is no module or the sentence is empty', () => {
    const none = renderHook(() => useWidgetSummary('ledger'), { wrapper: wrap([]) });
    expect(none.result.current).toBe('손익');
    const en = renderHook(() => useWidgetSummary('ledger'), { wrapper: wrap([], 'en') });
    expect(en.result.current).toBe('손익');
    const empty = renderHook(() => useWidgetSummary('ledger'), { wrapper: wrap([module('ledger', { useSummary: () => '' })]) });
    expect(empty.result.current).toBe('손익');
  });
  it('summary uses the module hook and passes the widget and condition', () => {
    const seen: unknown[] = [];
    const condition: QueryCondition = { kind: 'snapshot', asOf: '2026-10-26' };
    const mod = module('inventory-booking', { useSummary: (args) => { seen.push(args); return '재고 12개'; } });
    const { result } = renderHook(() => useWidgetSummary('inventory-booking', condition), { wrapper: wrap([mod]) });
    expect(result.current).toBe('재고 12개');
    expect(seen[0]).toEqual({ featureId: 'inventory-booking', condition });
  });
  it('tap target: own detail by default, none for a module without Detail, the module target when it has one, and own detail without a module', () => {
    const own = renderHook(() => useWidgetTapTarget('ledger'), { wrapper: wrap([module('ledger')]) });
    expect(own.result.current).toEqual({ featureId: 'ledger' });
    const bare = renderHook(() => useWidgetTapTarget('margin'), { wrapper: wrap([]) });
    expect(bare.result.current).toEqual({ featureId: 'margin' });
    const noDetail = renderHook(() => useWidgetTapTarget('marketing-today'), { wrapper: wrap([module('marketing-today', { Detail: null })]) });
    expect(noDetail.result.current).toBeNull();
    const target: DetailRef = { featureId: 'coupon-status', view: 'coupon' };
    const custom = renderHook(() => useWidgetTapTarget('marketing-today'), { wrapper: wrap([module('marketing-today', { Detail: null, useTapTarget: () => target })]) });
    expect(custom.result.current).toBe(target);
    const customNull = renderHook(() => useWidgetTapTarget('marketing-today'), { wrapper: wrap([module('marketing-today', { useTapTarget: () => null })]) });
    expect(customNull.result.current).toBeNull();
  });
});

describe('createWidgetHost (API-13 mapping)', () => {
  it('maps every method to a RunStore action, keeping ref.focus', () => {
    const actions = { resetWidgetPreview: vi.fn(), openLinkedDetail: vi.fn(), openDetailRef: vi.fn(), showNotice: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
    const host = createWidgetHost({ actions } as unknown as RunStore, { featureId: 'slot-coupon', layer: 'marketing' });
    expect(host.layer).toBe('marketing');
    host.resetPreview(); expect(actions.resetWidgetPreview).toHaveBeenCalledWith('slot-coupon');
    const ref: DetailRef = { featureId: 'coupon-status', view: 'coupon', itemId: 'c1', focus: 'action' };
    host.openLinked(ref); expect(actions.openLinkedDetail).toHaveBeenCalledWith(ref);
    host.openDetail(ref); expect(actions.openDetailRef).toHaveBeenCalledWith(ref, 'panel:slot-coupon');
    host.notify({ kind: 'success', messageKey: 'data.done', params: { n: 2 }, undoToken: 'tok' });
    expect(actions.showNotice).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.done', featureId: 'slot-coupon', params: { n: 2 }, undo: { target: 'data', token: 'tok' } });
    host.notify({ kind: 'error', messageKey: 'x' });
    expect(actions.showNotice).toHaveBeenLastCalledWith({ kind: 'error', messageKey: 'x', featureId: 'slot-coupon' });
    expect(host.openClosing('briefing:closing')).toBe(true); expect(actions.openClosing).toHaveBeenCalledWith('briefing:closing');
    host.acknowledgeBriefing(); expect(actions.acknowledgeBriefing).toHaveBeenCalled();
  });
  it('uses the focus key option for the button that opened the detail', () => {
    const actions = { openDetailRef: vi.fn() };
    const host = createWidgetHost({ actions } as unknown as RunStore, { featureId: 'marketing-today', layer: 'marketing', focusKey: 'panel-action:marketing-today:2' });
    host.openDetail({ featureId: 'slot-coupon', view: 'send', focus: 'action' });
    expect(actions.openDetailRef).toHaveBeenCalledWith({ featureId: 'slot-coupon', view: 'send', focus: 'action' }, 'panel-action:marketing-today:2');
  });
});

describe('createWidgetHost against a real RunStore', () => {
  const solve = (request: Parameters<LayoutAdapter['submit']>[0]) => ({ ...request, result: preview(request.beforePanels, request.intent, screenPresets[request.presetId].grid, getRegistry(request.presetId)) });
  const sync: LayoutAdapter = { ready: async () => {}, submit: (request, receive) => receive(solve(request)), cancel() {}, dispose() {} };
  let now = 0; let run: RunStore;
  beforeEach(() => {
    now = 0;
    run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => now, theme: 'light', layoutAdapter: sync });
    run.actions.chooseBusiness('cafe');
    run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
    run.actions.startEmpty();
    run.actions.visualSettled(); now += 400; run.actions.tick(); run.actions.dismissCoach();
    run.actions.switchLayer('marketing'); run.actions.visualSettled(); now += 400; run.actions.tick();
  });
  afterEach(() => run.dispose());
  it('opens a detail with the primary action focus, links, and shows a notice with a data undo', () => {
    const host = createWidgetHost(run, { featureId: 'marketing-today', layer: 'marketing', focusKey: 'btn-1' });
    host.openDetail({ featureId: 'slot-coupon', view: 'send', focus: 'action' });
    expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'slot-coupon', returnFocusKey: 'btn-1', stack: [{ featureId: 'slot-coupon', view: 'send', focus: 'action' }] });
    host.openLinked({ featureId: 'coupon-status', focus: 'action' });
    expect(run.getState().overlay).toMatchObject({ featureId: 'coupon-status' });
    host.notify({ kind: 'success', messageKey: 'common.copied', undoToken: 'u1' });
    const notice = selectCommonNotice(run.getState());
    expect(notice).toMatchObject({ kind: 'success', messageKey: 'common.copied', featureId: 'marketing-today', undo: { target: 'data', token: 'u1' } });
  });
  it('opens the shared closing dialog from the current board with its focus key', () => {
    const host = createWidgetHost(run, { featureId: 'briefing', layer: 'management' });
    expect(host.openClosing('briefing:closing')).toBe(true);
    expect(run.getState().overlay).toMatchObject({ type: 'closing', returnFocusKey: 'briefing:closing' });
    expect(run.getState().layer).toBe('marketing');
  });
  it('retires only its own superseded success notice', () => {
    const staff = createWidgetHost(run, { featureId: 'staff-schedule', layer: 'management' });
    const calendar = createWidgetHost(run, { featureId: 'calendar', layer: 'management' });
    calendar.notify({ kind: 'success', messageKey: 'data.notice.calendarAdded' });
    const other = selectCommonNotice(run.getState());
    staff.supersedeSuccessNotice?.();
    expect(selectCommonNotice(run.getState())).toBe(other);

    staff.notify({ kind: 'error', messageKey: 'data.staff.error.STAFF_SHIFT_OVERLAP' });
    const error = selectCommonNotice(run.getState());
    staff.supersedeSuccessNotice?.();
    expect(selectCommonNotice(run.getState())).toBe(error);

    staff.notify({ kind: 'success', messageKey: 'data.staff.notice.scheduleSaved' });
    staff.supersedeSuccessNotice?.();
    expect(selectCommonNotice(run.getState())).toBeNull();
  });
  it('keeps the original undo token and deadline when retiring the success text', () => {
    const host = createWidgetHost(run, { featureId: 'staff-schedule', layer: 'management' });
    host.notify({ kind: 'success', messageKey: 'data.staff.notice.scheduleSaved', undoToken: 'staff-change',
      undoUntil: new Date(Date.now() + 1_500).toISOString() });
    const before = selectCommonNotice(run.getState())!;
    host.supersedeSuccessNotice?.();
    expect(selectCommonNotice(run.getState())).toMatchObject({
      id: before.id, kind: 'complete', messageKey: 'data.real.receipt.previousChange',
      expiresAt: before.expiresAt, remainingMs: before.remainingMs, undo: { target: 'data', token: 'staff-change' },
    });
  });
});
