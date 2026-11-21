/**
 * GD-3 marketing consistency: one selector per number, whatever the seed holds. Each guard is tested against store state
 * (find the coupon / customer by what it is), never by a literal seed id or amount, so a replaced seed keeps the tests meaningful.
 *  1. ending reminder audience: one selector for the form preview and the command; zero blocks (NO_REMINDER_RECIPIENTS)
 *  2. running vs paused coupons; the route lines of 마케팅 성과 add up to the route row and the metric
 *  3. the slot window is tomorrow + 6 days, never ‘다음 주’
 *  4. one display alias per customer across 손님 그룹, 빈 시간 쿠폰 and 회원; the regular count says it is by recent visits
 */
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n/translator';
import type { FeatureId, QueryCondition } from '../../contracts';
import { daysBetween, LAST_MONTH_END, LAST_MONTH_START, TODAY, TOMORROW } from '../db/time';
import { selectMembers } from '../derive/members';
import { createWidgetDataStore, dataBundles, resolveDataText, selectWidget, type DataCommandResult, type ModelOf, type WidgetDataStore } from '../widget-data';
import { customerAlias, reminderAudience, SLOT_COUPON_ENDS, SLOT_WINDOW } from './derive';
import { marketingFactBuilders } from './facts';
import type { MarketingTables } from './types';

function modelOf<F extends FeatureId>(store: WidgetDataStore, id: F, condition: QueryCondition = { kind: 'default' }): ModelOf<F> {
  const view = selectWidget(store.getSnapshot(), id, condition, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} not ready: ${view.status}`);
  return view.model as ModelOf<F>;
}
const okResult = (r: DataCommandResult) => {
  if (!r.ok) throw new Error(`command failed: ${r.code} ${r.messageKey} ${r.field ?? ''}`);
  return r;
};
const marketing = (store: WidgetDataStore) => store.getSnapshot().tables.marketing;
const withTextAudience = () => {
  const store = createWidgetDataStore();
  const m = marketing(store);
  const coupon = m.coupon.find(row => row.status === 'active')!;
  const code = m.couponCode.find(row => row.couponId === coupon.couponId)!;
  const people = m.mktCustomer.filter(row => row.consentSms).slice(0, 2);
  return createWidgetDataStore({ marketing: {
    ...m,
    couponTarget: people.map(({ customerId }) => ({ couponId: coupon.couponId, codeId: code.codeId, customerId, reason: 'regular', sendId: `audience:${customerId}` })),
  } });
};
const bundleText = (locale: 'ko' | 'en' | 'zh-Hans' | 'zh-Hant', key: string): string => {
  for (const bundle of dataBundles) { const value = (bundle[locale] as Record<string, string> | undefined)?.[key]; if (value !== undefined) return value; }
  throw new Error(`no ${locale} text for ${key}`);
};
/** A running coupon whose reminder has nobody to reach, and one whose reminder has somebody. Found by state, not by id. */
const withoutAudience = (store: WidgetDataStore) => modelOf(store, 'coupon-status').rows.find((r) => r.canNotify && r.reminderRecipients === 0);
const withAudience = (store: WidgetDataStore) => modelOf(store, 'coupon-status').rows.find((r) => r.canNotify && r.reminderRecipients > 0);

describe('1 · ending reminder audience (one selector, zero blocks)', () => {
  it('refuses a reminder when no consenting target is left, with the typed refusal, and records nothing', () => {
    const store = createWidgetDataStore();
    const coupon = withoutAudience(store);
    expect(coupon, 'the fixture needs one running coupon with no text targets').toBeDefined();
    const before = store.getSnapshot();
    const refused = store.dispatch({ type: 'coupon.notifyEnding', couponId: coupon!.couponId, idempotencyKey: 'r0' });
    expect(refused).toMatchObject({
      ok: false, code: 'VALIDATION', reason: 'NO_REMINDER_RECIPIENTS', messageKey: 'data.marketing.error.noReminderRecipients', field: 'couponId',
      details: { couponId: coupon!.couponId, recipients: 0 },
    });
    expect(store.getSnapshot().tables.marketing.couponReminder).toEqual(before.tables.marketing.couponReminder);
    expect(store.getSnapshot().tables.marketing.messageSend).toEqual(before.tables.marketing.messageSend);
  });
  it('the form preview count is the count the command sends (allowed neighbour) and a same-key replay returns the first receipt', () => {
    const store = withTextAudience();
    const coupon = withAudience(store);
    expect(coupon, 'the fixture needs one running coupon texted to consenting customers').toBeDefined();
    const audience = reminderAudience(marketing(store), coupon!.couponId);
    expect(coupon!.reminderRecipients).toBe(audience.length);
    const first = okResult(store.dispatch({ type: 'coupon.notifyEnding', couponId: coupon!.couponId, idempotencyKey: 'r1' }));
    expect(first.params).toEqual({ count: audience.length });
    expect(first.value).toMatchObject({ recipients: audience.length });
    const sentTo = marketing(store).messageSend.filter((s) => s.kind === 'reminder' && s.couponId === coupon!.couponId).map((s) => s.customerId).sort();
    expect(sentTo).toEqual([...audience].sort());
    const again = store.dispatch({ type: 'coupon.notifyEnding', couponId: coupon!.couponId, idempotencyKey: 'r1' });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(marketing(store).couponReminder).toHaveLength(1);
  });
  it('counts a target once and only while the customer is known and still consents', () => {
    const base = withTextAudience();
    const coupon = withAudience(base)!;
    const m = marketing(base);
    const [first, ...rest] = reminderAudience(m, coupon.couponId);
    const revoked: MarketingTables = { ...m, mktCustomer: m.mktCustomer.map((c) => (c.customerId === first ? { ...c, consentSms: false } : c)) };
    expect(reminderAudience(revoked, coupon.couponId).sort()).toEqual([...rest].sort());
    const removed: MarketingTables = { ...m, mktCustomer: m.mktCustomer.map((c) => (c.customerId === first ? { ...c, deletedAt: '2026-10-26T09:00' } : c)) };
    expect(reminderAudience(removed, coupon.couponId)).not.toContain(first);
    const duplicated: MarketingTables = { ...m, couponTarget: [...m.couponTarget, ...m.couponTarget.filter((t) => t.couponId === coupon.couponId)] };
    expect(reminderAudience(duplicated, coupon.couponId)).toHaveLength(coupon.reminderRecipients);
  });
});

describe('2 · running vs paused coupons, and route lines that add up', () => {
  it('a paused coupon leaves the running count, stays listed with its own count, and undo puts it back', () => {
    const store = createWidgetDataStore();
    const before = modelOf(store, 'coupon-status');
    const running = before.rows.find((r) => r.status === 'active')!;
    const paused = okResult(store.dispatch({ type: 'coupon.pause', couponId: running.couponId }));
    const after = modelOf(store, 'coupon-status');
    expect([after.activeCount, after.pausedCount, after.rows.length]).toEqual([before.activeCount - 1, before.pausedCount + 1, before.rows.length]);
    expect(after.rows.find((r) => r.couponId === running.couponId)?.status).toBe('paused');
    expect(after.runningUsed).toBe(before.runningUsed);
    const facts = marketingFactBuilders['coupon-status'](after);
    expect(facts.find((f) => f.key === 'coupons.active')?.value).toBe(after.activeCount);
    expect(facts.find((f) => f.key === 'coupons.paused')?.value).toBe(1 + before.pausedCount);
    okResult(store.undo(paused.undoToken!));
    const restored = modelOf(store, 'coupon-status');
    expect([restored.activeCount, restored.pausedCount]).toEqual([before.activeCount, before.pausedCount]);
  });
  it('every route row is the sum of its per-code lines, and the rows are the sum of the metric (ended coupon codes included)', () => {
    const original = marketing(createWidgetDataStore());
    const endedCoupon = original.coupon.find(row => row.status === 'ended')!;
    const endedCode = { codeId: 'ended-this-month', couponId: endedCoupon.couponId, route: 'blog' as const,
      code: 'ENDED', issueCount: 2, activatedAt: `${TODAY}T10:00`, videoId: null };
    const store = createWidgetDataStore({ marketing: { ...original, couponCode: [...original.couponCode, endedCode] } });
    const slot = modelOf(store, 'slot-coupon').openSlots.find(row => row.regularIds.length > 0)!;
    okResult(store.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: slot.regularIds, benefit: 'percent-10', idempotencyKey: 'perf-1' }));
    const perf = modelOf(store, 'marketing-performance');
    for (const route of perf.routes) {
      expect([route.route, route.lines.reduce((s, l) => s + l.issued, 0)]).toEqual([route.route, route.issued]);
      expect([route.route, route.lines.reduce((s, l) => s + l.used, 0)]).toEqual([route.route, route.used]);
    }
    expect(perf.routes.reduce((s, r) => s + r.issued, 0)).toBe(perf.issued);
    expect(perf.routes.reduce((s, r) => s + r.used, 0)).toBe(perf.used);
    const ended = marketing(store).coupon.filter((c) => c.status === 'ended' || c.endsOn < TODAY).map((c) => c.couponId);
    expect(perf.routes.flatMap((r) => r.lines).some((l) => ended.includes(l.couponId) && l.status === 'ended'), 'ended coupons stay in the lines').toBe(true);
  });
  it('last month is a fixed sample: its rows keep their numbers and carry no per-coupon lines', () => {
    const store = createWidgetDataStore();
    const last = modelOf(store, 'marketing-performance', { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END });
    expect(last.periodKind).toBe('last-month');
    expect(last.routes.every((r) => r.lines.length === 0)).toBe(true);
    expect(last.routes.reduce((s, r) => s + r.issued, 0)).toBe(last.issued);
  });
});

describe('3 · the slot window is tomorrow and six more days, not a calendar week', () => {
  it('starts tomorrow and spans exactly 7 days', () => {
    expect(SLOT_WINDOW.start).toBe(TOMORROW);
    expect(daysBetween(SLOT_WINDOW.start, SLOT_WINDOW.end) + 1).toBe(7);
    expect(SLOT_COUPON_ENDS > SLOT_WINDOW.end).toBe(true);
  });
  it('no slot text in any language calls the window next week', () => {
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const keys = ['data.marketing.coupon.slotFreeShot', 'data.marketing.coupon.slotPercent', 'data.marketing.coupon.slotAmount', 'data.marketing.sms.slotFreeShot', 'data.marketing.sms.slotPercent', 'data.marketing.sms.slotAmount', 'data.state.slot-coupon.no-slots', 'data.fact.slot.quietHours.count'];
      for (const key of keys) expect(bundleText(locale, key), `${locale} ${key}`).not.toMatch(/다음 ?주|next week|下周|下週/i);
    }
  });
  it('the text message names the exact window dates (they follow SLOT_WINDOW)', () => {
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const { date } = createTranslator(locale).format;
      const t = createTranslator(locale, ...dataBundles);
      const slot = modelOf(createWidgetDataStore(), 'slot-coupon');
      for (const body of Object.values(slot.message.bodies)) {
        const text = resolveDataText(t.t, body);
        for (const day of [SLOT_WINDOW.start, SLOT_WINDOW.end, SLOT_COUPON_ENDS]) {
          expect(text, locale).toContain(date(day, 'monthDay'));
        }
      }
    }
  });
});

describe('4 · one customer, one alias, and the regular count says which selector answered', () => {
  it('every member who is in a group or a slot list has the same alias in both views (joined by customerId)', () => {
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const members = selectMembers(snapshot, {}).rows;
    const aliasOf = (name: unknown) => (typeof name === 'string' ? { raw: name } : name);
    const groups = modelOf(store, 'customer-groups');
    const slot = modelOf(store, 'slot-coupon');
    const seen = new Set<string>();
    for (const row of [...groups.groups.flatMap((g) => g.customers), ...slot.recipients]) {
      const member = members.find((m) => m.customerId === row.customerId);
      if (!member) continue;
      seen.add(row.customerId);
      expect(row.name, `${row.customerId} in the groups/slot views`).toEqual(aliasOf(member.name));
    }
    expect(seen.size, 'the fixture needs members that appear in marketing views').toBeGreaterThan(0);
    // the alias is the one function: a nameless sample customer falls back to its alias key, a named one is masked
    const customer = snapshot.tables.marketing.mktCustomer[0];
    expect(customerAlias(customer)).toEqual(aliasOf(selectMembers(snapshot, {}).rows.find((m) => m.customerId === customer.customerId)?.name ?? customerAlias(customer)));
  });
  it('the group regular count follows visits, not the 회원 grade, and its label says so', () => {
    const store = createWidgetDataStore();
    const groups = modelOf(store, 'customer-groups');
    const members = selectMembers(store.getSnapshot(), {});
    const target = members.rows.find((m) => m.automaticGrade === 'regular' && groups.groups.find((g) => g.id === 'regular')!.customers.some((c) => c.customerId === m.customerId));
    expect(target, 'the fixture needs a member who is a regular by visits').toBeDefined();
    okResult(store.dispatch({ type: 'members.setGrade', memberId: target!.memberId, grade: 'inactive' }));
    const afterGroups = modelOf(store, 'customer-groups');
    const afterMembers = selectMembers(store.getSnapshot(), {});
    expect(afterGroups.counts.regular).toBe(groups.counts.regular);
    expect(afterMembers.gradeCounts.regular).toBe(members.gradeCounts.regular - 1);
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) expect(bundleText(locale, 'data.fact.groups.regular')).not.toBe(bundleText(locale, 'data.marketing.group.regular'));
    expect(bundleText('ko', 'data.fact.groups.regular')).toContain('최근 방문 기준');
  });
});
