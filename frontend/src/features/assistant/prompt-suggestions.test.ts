import { expect, it } from 'vitest';
import { addDays, TODAY } from '../../data/db/time';
import { selectCalendar } from '../../data/derive/operations';
import { createWidgetDataStore, type SeedOverrides } from '../../data/widget-data';
import { selectPromptSuggestions } from './prompt-suggestions';
import { matchWidget } from './question';
import { assistantDomains } from './snapshot';

const seed = createWidgetDataStore().getSnapshot().tables;
const emptyTables: SeedOverrides = {
  inquiryThread: [], expense: [], calendarEvent: [],
  calendarSettings: { ...seed.calendarSettings, direct: true, delivery: false, reservation: false, deadline: false, shift: false, pickup: false },
};
const review = { ...seed.inquiryThread[0], type: 'review' as const, status: 'waiting' as const };
const expense = { ...seed.expense[0], businessDate: TODAY, evidence: 'none' as const, receiptId: null, status: 'confirmed' as const };
const event = { eventId: 'today-event', kind: 'event' as const, title: { raw: '창고 점검' }, date: TODAY, time: '10:00', memo: null };

it('returns four Korean prompts with the exact matching counts for a rich store', () => {
  const store = createWidgetDataStore({
    ...emptyTables,
    inquiryThread: [review, { ...review, threadId: 'done', status: 'done' }, { ...review, threadId: 'message', type: 'message' }],
    expense: [expense, { ...expense, expenseId: 'second' }, { ...expense, expenseId: 'candidate', status: 'candidate' },
      { ...expense, expenseId: 'with-receipt', evidence: 'receipt', receiptId: 'filed' },
      { ...expense, expenseId: 'yesterday', businessDate: addDays(TODAY, -1) }],
    calendarEvent: [event, { ...event, eventId: 'tomorrow', date: addDays(TODAY, 1) }, { ...event, eventId: 'todo', kind: 'todo' }],
  });
  expect(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', threshold: 25_000 }).ok).toBe(true);

  const snapshot = store.getSnapshot();
  const rows = selectPromptSuggestions(snapshot);
  expect(rows.map(({ templateId, count, countLabel }) => [templateId, count, countLabel])).toEqual([
    ['low-stock', 1, '1건'],
    ['unanswered-reviews', 1, '1건'],
    ['missing-expense-receipts', 2, '2건'],
    ['today-schedule', 1, '1건'],
  ]);
  for (const { readTemplate, dataRule } of rows) {
    expect(readTemplate.text).toMatch(/[가-힣]/u);
    expect(assistantDomains.route(readTemplate.text, snapshot, 'ko', matchWidget(readTemplate.text))).toMatchObject({
      intent: { kind: 'read', featureId: readTemplate.featureId },
      factKeys: expect.arrayContaining([dataRule.factKey]),
    });
  }
});

it('recomputes from the current snapshot and leaves a sparse list sparse', () => {
  const store = createWidgetDataStore(emptyTables);
  expect(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', threshold: 25_000 }).ok).toBe(true);
  expect(selectPromptSuggestions(store.getSnapshot()).map(row => [row.templateId, row.count])).toEqual([['low-stock', 1]]);
  expect(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', threshold: 0 }).ok).toBe(true);
  expect(selectPromptSuggestions(store.getSnapshot())).toEqual([]);
});

it('labels scheduled events and staff shifts with their respective counts', () => {
  const store = createWidgetDataStore({ ...emptyTables, calendarEvent: [event], calendarSettings: { ...emptyTables.calendarSettings!, shift: true } });
  const snapshot = store.getSnapshot();
  const today = selectPromptSuggestions(snapshot).find(row => row.templateId === 'today-schedule');
  const calendar = selectCalendar(snapshot, { date: TODAY });
  const scheduled = calendar.todayEntries.filter(row => row.kind === 'event').length;
  const shifts = calendar.staffEntries.filter(row => row.date === TODAY).length;
  expect(shifts).toBeGreaterThan(0);
  expect(today?.countLabel).toBe(`일정 ${scheduled}건 · 근무 일정 ${shifts}건`);
});

it('returns zero rows when connected sources contain no matching data', () => {
  expect(selectPromptSuggestions(createWidgetDataStore(emptyTables).getSnapshot())).toEqual([]);
});

it('skips unavailable sources even when records from them remain in the snapshot', () => {
  const store = createWidgetDataStore({
    ...emptyTables, calendarEvent: [event], inquiryThread: [review],
    integration: { ...seed.integration, calendar: false, channels: false },
  });
  expect(selectPromptSuggestions(store.getSnapshot())).toEqual([]);
});
