import {createSessionActions,sessionGateFor} from './session-actions';
import {createTableLayout,setTableSeats} from '../layout/table-layout';
import {beginDashboard} from './test-session';
/**
 * T-055 integration (W4): the 28 widget modules are registered, and one fake DB keeps every surface on the same numbers —
 * panels' models, the arrival briefing card, the calendar and Navis facts (AC-231~239, AC-313~318). The single-widget
 * command rules live in src/data/flows.test.ts and src/data/marketing/flows.test.ts; this file crosses them in one run.
 */
import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureId, QueryCondition } from '../contracts';
import { getLayerCatalog, getRegistry } from '../catalog';
import { readDemand, TODAY, createWidgetDataStore, selectWidget, widgetFacts, type DataCommandResult, type ModelOf, type WidgetDataStore } from '../data/widget-data';
import { createSeedTables } from '../data/db/seed';
import { WidgetDataProvider } from '../data/react';
import { I18nProvider } from '../i18n';
import { screenPresets } from '../layout/presets';
import { createRunStore } from '../state';
import { UiProvider, timePolicy } from '../ui';
import { BriefingOverlay } from '../screens/briefing';
import { widgetModules } from '../features/widgets/registry';

afterEach(cleanup);
const DEFAULT: QueryCondition = { kind: 'default' };
function modelOf<F extends FeatureId>(store: WidgetDataStore, id: F): ModelOf<F> {
  const view = selectWidget(store.getSnapshot(), id, DEFAULT, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} not ready: ${view.status}`);
  return view.model as ModelOf<F>;
}
const factsOf = (store: WidgetDataStore, id: FeatureId) => widgetFacts(selectWidget(store.getSnapshot(), id, DEFAULT, 'normal'));
const fact = (store: WidgetDataStore, id: FeatureId, key: string) => factsOf(store, id).find(f => f.key === key)?.value;
const ok = (r: DataCommandResult) => { if (!r.ok) throw new Error(`${r.code} ${r.messageKey}`); return r; };

describe('widget modules (API-13, AC-271·319)', () => {
  it('registers exactly the 29 registry widgets (management 17, marketing 12) with a panel, a summary and a detail; only marketing-today has no detail', () => {
    const ids = widgetModules.map(m => m.id);
    expect(new Set(ids).size).toBe(29);
    expect([...ids].sort()).toEqual(getRegistry('A').map(f => f.id).sort());
    expect(ids.filter(id => getLayerCatalog('A', 'management').some(f => f.id === id))).toHaveLength(17);
    expect(ids.filter(id => getLayerCatalog('A', 'marketing').some(f => f.id === id))).toHaveLength(12);
    for (const module of widgetModules) {
      expect(typeof module.Panel, module.id).toBe('function');
      expect(typeof module.useSummary, module.id).toBe('function');
      if (module.id === 'marketing-today') expect(module.Detail).toBeNull(); else expect(typeof module.Detail, module.id).toBe('function');
    }
    expect(ids as string[]).not.toContain('stock-sync');
  });
});

describe('one delivery, one source (AC-231~239)', () => {
  it('8 L received twice with one key applies once: stock, restock, supplier remaining, ledger candidate, calendar, briefing card and Navis agree', () => {
    const store = createWidgetDataStore();
    const milk = store.getSnapshot().tables.purchaseItem.find(i => i.itemId === 'i-milk')!;
    ok(store.dispatch({ type: 'inventory.updateItem', itemId: milk.itemId, stock: 5_000 }));
    ok(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-bean-house', stock: 0 }));
    const { poId, polId } = ok(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: milk.purchaseItemId, qty: 12, dueDate: TODAY, idempotencyKey: 'order' })).value as { poId: string; polId: string };
    const before = { restock: modelOf(store, 'inventory-booking').restockCount, upcoming: modelOf(store, 'suppliers').upcomingCount, candidates: modelOf(store, 'ledger').candidates.length };
    const receipt = { type: 'suppliers.recordReceipt', polId, qty: 8, idempotencyKey: 'rcv' } as const;
    const { expenseId } = ok(store.dispatch(receipt)).value as { expenseId: string };
    const revision = store.getSnapshot().revision;
    expect(ok(store.dispatch(receipt)).duplicate).toBe(true);
    expect(store.getSnapshot().revision).toBe(revision);

    const inventory = modelOf(store, 'inventory-booking');
    expect(inventory.ingredients.find(i => i.itemId === milk.itemId)?.stock).toBe(13_000);
    expect([before.restock, inventory.restockCount]).toEqual([2, 1]);
    const suppliers = modelOf(store, 'suppliers');
    expect([suppliers.upcomingCount, suppliers.upcoming.find(order => order.poId === poId)?.lines[0].remaining]).toEqual([before.upcoming, 4]);
    const candidates = modelOf(store, 'ledger').candidates;
    expect(candidates).toHaveLength(before.candidates + 1);
    expect(candidates.find(c => c.expenseId === expenseId)).toMatchObject({ amount: 8 * milk.unitPrice, status: 'candidate' });
    const calendar = modelOf(store, 'calendar');
    expect(calendar.todayEntries.some(e => e.sourceId === poId)).toBe(true);
    const briefing = modelOf(store, 'briefing').arrival;
    expect(briefing.find(i => i.featureId === 'inventory-booking')?.value).toBe(inventory.restockCount);
    expect(briefing.find(i => i.featureId === 'calendar')?.value).toBe(calendar.todayCount);
    expect(fact(store, 'inventory-booking', 'inventory.restock.count')).toBe(1);
    expect(fact(store, 'ledger', 'ledger.candidates.count')).toBe(before.candidates + 1);
    expect(fact(store, 'suppliers', 'suppliers.upcoming.count')).toBe(before.upcoming);
    expect(fact(store, 'calendar', 'calendar.today.count')).toBe(calendar.todayCount);

    // The arrival card on screen shows the restock number of the shared store.
    let now = 0;
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: true });
    const tick = (ms: number) => act(() => { now += ms; run.actions.tick(); });
    act(() => { beginDashboard(run,'cafe'); run.actions.visualSettled(); }); tick(400);
    act(() => { run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); }); tick(200);
    for (let i = 0; i < 12; i += 1) { const g = run.getState().guidance; if (!g.active && !g.activeWidget && !g.queue.length && !g.widgetQueue.length) break; act(() => run.actions.dismissCoach()); tick(200); }
    act(() => { run.actions.clearNotice(); run.actions.finishEditing(); }); tick(1300);
    render(<I18nProvider locale="ko"><WidgetDataProvider store={store}><UiProvider screenPreset={screenPresets.A} reducedMotion><BriefingOverlay run={run} /></UiProvider></WidgetDataProvider></I18nProvider>);
    const card = screen.getByRole('dialog', { name: '오늘 가게 소식이에요' });
    expect(within(card).getByRole('button', { name: `오늘 일정 ${calendar.todayCount}개` })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '보충 필요 1개 품목' })).toBeInTheDocument();
    run.dispose();
  });
  it('settings publish the table layout and reservation capacity together', () => {
    const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light'});
    const gate=sessionGateFor(run),store=createWidgetDataStore(undefined,{runId:run.getState().runId,sessionGate:gate});
    run.actions.setOnboardingAnswer({businessType:'cafe'});run.actions.setOnboardingAnswer({paymentStyle:'postpaid'});run.actions.skipOnboardingTables();
    const actions=createSessionActions(run,store,gate);ok(actions.completeOnboarding(null));
    const layout=setTableSeats(createTableLayout(), 'table-1', 4)!;
    const actualLayout=layout??createTableLayout();
    ok(actions.updateSettings({...run.getState().shopSettings,tableLayout:actualLayout,revision:2}));
    expect(run.getState().shopSettings.tableLayout).toEqual(store.getSnapshot().tables.shopSettings.tableLayout);
    expect(modelOf(store,'voice-booking').seats).toBe(actualLayout.tables.reduce((n,t)=>n+t.seats,0));
  });
});

describe('one coupon source across the marketing board (AC-313~318)', () => {
  it('a day of marketing in one store: slot coupon, sell-today coupon, posted video, reply — every widget and Navis read the same numbers', () => {
    const { marketing } = createSeedTables();
    const menuId = 'm-chestnut-latte';
    // The default cafe catalog has no demo photos. Provide five media rows to exercise posting.
    const promoPhoto = Array.from({ length: 5 }, (_, order) => ({
      photoId: `test-photo-${order}`, menuId, url: `/test/cafe-photo-${order}.jpg`, width: 1920, height: 1080, order,
    }));
    const campaign = marketing.coupon.find(row => row.status === 'active' && row.startsOn <= TODAY && row.endsOn >= TODAY)!;
    const store = createWidgetDataStore({ marketing: { ...marketing, promoPhoto } });
    const before = modelOf(store, 'coupon-status');
    const beforePerf = modelOf(store, 'marketing-performance');
    expect([before.activeCount, beforePerf.issued, beforePerf.used]).toEqual([1, 299, 223]);
    const slots = modelOf(store, 'slot-coupon');
    const slot = slots.slots.find(slot => slot.regularIds.length > 0)!;
    const send = () => store.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: slot.regularIds, benefit: 'percent-10', idempotencyKey: 'send' });
    ok(send());
    expect(ok(send()).duplicate).toBe(true);
    let perf = modelOf(store, 'marketing-performance');
    const rate = (issued: number) => Math.round(beforePerf.used * 100 / issued);
    let issued = beforePerf.issued + slot.regularIds.length;
    expect([modelOf(store, 'coupon-status').activeCount, perf.issued, perf.rate]).toEqual([before.activeCount + 1, issued, rate(issued)]);
    const sms = beforePerf.routes.find(route => route.route === 'sms')!;
    expect(perf.routes.find(route => route.route === 'sms')).toMatchObject({
      issued: sms.issued + slot.regularIds.length, used: sms.used, rate: Math.round(sms.used * 100 / (sms.issued + slot.regularIds.length)),
    });
    expect([fact(store, 'coupon-status', 'coupons.active'), fact(store, 'marketing-performance', 'perf.issued'), fact(store, 'marketing-performance', 'perf.rate')]).toEqual([before.activeCount + 1, issued, rate(issued)]);

    const expiry = modelOf(store, 'expiry-coupon'), target = expiry.target;
    if (!target?.atRecommended) throw new Error('Expected an expiring item with a recommended discount');
    expect(modelOf(store, 'coupon-status').endingSoonCount).toBe(before.endingSoonCount);
    ok(store.dispatch({ type: 'coupon.createExpiry', itemId: target.itemId, benefit: { kind: 'setPrice', value: target.atRecommended.discountedPrice }, route: 'sms', idempotencyKey: 'expiry' }));
    issued += expiry.routes.sms.recipients;
    expect([modelOf(store, 'coupon-status').endingSoonCount, fact(store, 'coupon-status', 'coupons.endingSoon')]).toEqual([before.endingSoonCount + 1, before.endingSoonCount + 1]);

    const { recipientIds } = modelOf(store, 'customer-groups').reachOut;
    ok(store.dispatch({ type: 'coupon.sendReachOut', recipientIds, idempotencyKey: 'reach' }));
    issued += recipientIds.length;
    const status = modelOf(store, 'coupon-status');
    expect([status.activeCount, status.endingSoonCount, status.runningUsed, status.endedUsed, status.monthUsed]).toEqual([before.activeCount + 3, before.endingSoonCount + 1, before.runningUsed, before.endedUsed, before.monthUsed]);
    perf = modelOf(store, 'marketing-performance');
    expect([perf.issued, perf.used, perf.rate]).toEqual([issued, beforePerf.used, rate(issued)]);
    expect(fact(store, 'marketing-performance', 'perf.rate')).toBe(perf.rate);

    const below = readDemand(store.getSnapshot()).hourly
      .filter(day => day.date >= slots.window.start && day.date <= slots.window.end)
      .flatMap(day => day.hours.filter(hour => hour.belowUsual).map(hour => `${day.date}@${hour.hour}`));
    expect(new Set(below.map(hour => hour.slice(0, 10))).size).toBe(7);
    expect(slots.slots.flatMap(slot => slot.hours.map(hour => `${slot.date}@${hour.hour}`))).toEqual(below);
    ok(store.dispatch({ type: 'inventory.updateItem', itemId: target.itemId, stock: 5 }));
    const forecast = marketing.expiryForecast.find(row => row.itemId === target.itemId)!;
    expect([modelOf(store, 'expiry-coupon').items.find(item => item.itemId === target.itemId)?.qty, modelOf(store, 'inventory-booking').ingredients.find(item => item.itemId === target.itemId)?.stock]).toEqual([5 - forecast.expectedSalesUntilClose, 5]);

    const response = modelOf(store, 'ai-response');
    const review = response.threads.find(thread => thread.status === 'waiting' && thread.type === 'review' && thread.isPublic && thread.rating !== null && thread.rating <= 2)!;
    ok(store.dispatch({ type: 'inquiry.post', threadId: review.threadId, idempotencyKey: 'reply' }));
    const afterReply = modelOf(store, 'ai-response');
    expect(afterReply.waitingCount).toBe(response.waitingCount - 1);
    expect([modelOf(store, 'promo-video').materialsCount, afterReply.praiseCount]).toEqual([promoPhoto.length, response.praiseCount]);
    const made = ok(store.dispatch({ type: 'video.make', input: { menuIds: [menuId], photoIds: promoPhoto.map(p => p.photoId), moods: ['warm'], concepts: ['review-roundup'], memo: '', referenceId: 'ref-1', lengthSec: 15, locale: 'ko' }, idempotencyKey: 'video-make-1' }));
    const videoId = (made.value as { videoId: string }).videoId;
    ok(store.dispatch({ type: 'video.attachJob', videoId, jobId: 'pj-0123456789ab' }));
    ok(store.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'done', result: { durationSec: 15, music: { trackId: 'warm-cozy-acoustic', title: 'Cozy', artist: 'MintoDog', licenseLabel: 'CC0-1.0' }, fileUrl: '/api/promo/jobs/pj-0123456789ab/video.mp4', sizeBytes: 1000, madeAt: `${TODAY}T00:00:00.000Z` } } }));
    const clipBefore = modelOf(store, 'marketing-performance').routes.find(r => r.route === 'clip')?.issued;
    ok(store.dispatch({ type: 'video.markPosted', videoId, route: 'clip', idempotencyKey: 'posted' }));
    expect(store.getSnapshot().tables.marketing.couponCode.find(code => code.videoId === videoId)).toMatchObject({ couponId: campaign.couponId, route: 'clip', issueCount: 10 });
    perf = modelOf(store, 'marketing-performance');
    expect(perf.routes.find(r => r.route === 'clip')?.issued).toBe((clipBefore ?? 0) + 10);
    issued += 10;
    expect([perf.issued, perf.used, perf.rate]).toEqual([issued, beforePerf.used, rate(issued)]);
    expect(fact(store, 'marketing-performance', 'perf.issued')).toBe(perf.issued);
    expect(fact(store, 'promo-video', 'video.posted.count')).toBe(1);
  });
});

describe('rendered sample: no message keys on screen, no Hangul in English chrome (T-055 ③, AC-208·218)', () => {
  const KEY_TEXT = /\b(?:app|common|group|page|help|format|unit|language|preview|ui|dashboard|settings|shell|detail|briefing|navis|data|marketing|widget)\.[a-z][\w-]*\.[\w.-]*\b/u;
  it.each(['en', 'zh-Hans'] as const)('%s: dashboard with starters, an open drawer and settings', async locale => {
    const { App } = await import('./App');
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
    act(() => { run.actions.setLocale(locale); beginDashboard(run,'cafe'); run.actions.startWithThree(); run.actions.skipWidgetCoaches(); run.actions.clearNotice(); });
    render(<App run={run} manageLifecycle={false} />);
    await screen.findByRole('heading', { level: 1, name: '안숭잘부 카페' });
    act(() => { run.actions.openDrawer('stock'); });
    const chrome = () => ['.dashboard-header', '.dashboard-rail', '.ui-drawer', '.app-layer-navigation'].map(s => document.querySelector(s)?.textContent ?? '').join(' | ');
    expect(chrome()).toContain('재고');
    expect(chrome()).toContain(locale==='en'?'Settings':'设置');
    expect(document.body.textContent).not.toMatch(KEY_TEXT);
    act(() => { run.actions.closeOverlay('button'); });
    act(() => { run.actions.openSettings(); });
    const settings = await screen.findByRole('dialog');
    expect(settings.textContent).not.toMatch(KEY_TEXT);
    expect(settings.textContent).toContain('매장 설정');
    run.dispose();
  });
});
