// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, readModel, TODAY } from '../../../data/widget-data';
import { addDays } from '../../../data/db/time';
import { createAgentActions } from '../agent-actions';
import { assistantDomains } from '../snapshot';
import { createDomainRegistry } from './registry';
import { createMoneyDomain, moneyDetailPrefill, moneyDomain, projectMoneyFacts } from './money';
import { validateAgentDetailRef } from '../../../../shared/navis-agent-schema.mjs';

const feature = createMoneyDomain({ allowExpenseEntry: true, allowTaxDelete: true });
const domains = createDomainRegistry([feature]);

describe('N11 bookkeeping boundary', () => {
  it('leaves ingredient usage questions with inventory', () => {
    expect(feature.route?.('오늘 우유 얼마나 썼어?', createWidgetDataStore().getSnapshot(), 'ko')).toBeUndefined();
  });

  it('S1-297 prepares a local expense, writes once on confirmation and restores it on receipt undo', () => {
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const route = moneyDomain.route?.('오늘 소모품 3만원 썼어', snapshot, 'ko');
    expect(route).toMatchObject({ intent: { command: 'ledger.recordExpense' }, slots: { amount: 30_000, date: TODAY, category: 'supplies', evidence: 'none' } });
    if (!route || !('intent' in route) || route.intent.kind !== 'command') throw Error('Missing expense route');
    const actions = createAgentActions(store);
    const result = actions.prepare({ proposalId: 'expense', command: 'ledger.recordExpense',
      args: route.intent.args ?? {}, runId: snapshot.runId!, snapshotRevision: snapshot.revision, layer: 'management', tier: 'normal' },
    route.slots ?? {}, snapshot);
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') throw Error('Missing expense proposal');
    expect(store.getSnapshot()).toBe(snapshot);
    expect(result.proposal.confirm(createWidgetDataStore()).frame.outcome).toBe('conflict');
    const receipt = result.proposal.confirm(store);
    expect(receipt.frame.outcome).toBe('applied');
    expect(result.proposal.confirm(store).frame).toEqual(receipt.frame);
    expect(store.getSnapshot().tables.expense.at(-1)?.evidence).toBe('none');
    expect(readModel(store.getSnapshot(), 'ledger').expenses.total).toBe(readModel(snapshot, 'ledger').expenses.total + 30_000);
    expect(receipt.undoToken && store.undo(receipt.undoToken).ok).toBe(true);
    expect(store.getSnapshot().tables.expense).toEqual(snapshot.tables.expense);
  });

  it('S2-040 selects an earlier unpaid obligation immediately and restores the due date on undo', () => {
    const store = createWidgetDataStore();
    const before = store.getSnapshot();
    const dueOn = addDays(TODAY, -45);
    const applied = store.dispatch({ type: 'tax.createPayment', taxType: '일정 테스트', amount: 25_000, dueOn, idempotencyKey: 'earlier-tax' });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw Error(applied.messageKey);
    const nextDue = (snapshot: typeof before) => projectMoneyFacts(snapshot, 'tax', { kind: 'default' }, 'ko');
    expect(nextDue(store.getSnapshot())).toMatchObject({ facts: expect.arrayContaining([expect.objectContaining({ key: 'tax.nextDue', date: dueOn })]) });
    expect(applied.undoToken && store.undo(applied.undoToken).ok).toBe(true);
    expect(nextDue(store.getSnapshot())).toEqual(nextDue(before));
  });

  it('hands a named tax paid-state change to its exact widget row', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    for (const text of ['원천세 10월 24일에 냈어 납부 완료로 해줘', '원천세 지난 토요일에 납부했어 그날로 기록', '원천세 10/24 납부 완료 처리 (그날 냈음)']) {
      expect(moneyDomain.route?.(text, snapshot, 'ko')).toMatchObject({ kind: 'refusal', reason: 'widget_only',
        alternative: { featureId: 'tax', command: 'tax.markPaid', draft: { taxPaymentId: 'sample-tax-1' } } });
    }
    expect(moneyDomain.handoff?.('tax.markPaid', { taxPaymentId: 'sample-tax-1' })).toEqual({
      featureId: 'tax', view: 'payments', itemId: 'sample-tax-1',
    });
  });

  it('D-325 deletes one unpaid tax schedule on the second press and restores it from its receipt', () => {
    const store = createWidgetDataStore();
    const before = store.getSnapshot();
    expect(assistantDomains.route('원천세 납부 일정을 지워줘', before, 'ko')).toMatchObject({
      intent: { kind: 'command', command: 'tax.deletePayment' },
    });
    expect(assistantDomains.route('부가세 납부 전 항목 삭제해줘', before, 'ko')).toMatchObject({
      intent: { kind: 'command', command: 'tax.deletePayment' },
    });
    const result = createAgentActions(store).prepare({
      proposalId: 'delete-tax', command: 'tax.deletePayment', args: { taxPaymentId: { handle: 'selected' } },
      runId: before.runId!, snapshotRevision: before.revision, layer: 'management', tier: 'extra-confirm',
    }, {}, before, undefined, new Map([['selected', { kind: 'taxPayment', id: 'sample-tax-1' }]]));
    if (result.kind !== 'proposal') throw Error(result.kind);
    const { proposal } = result;
    expect(proposal.confirm(store).requiresExtraConfirmation).toBe(true);
    expect(store.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(store, proposal.id);
    expect(receipt.frame.outcome).toBe('applied');
    const after = store.getSnapshot();
    expect(after.tables.taxPayment.map(row => row.taxPaymentId)).toEqual(['sample-tax-2']);
    expect(proposal.confirm(store, proposal.id).frame).toEqual(receipt.frame);
    expect(receipt.undoToken && store.undo(receipt.undoToken).ok).toBe(true);
    expect(store.getSnapshot().tables.taxPayment).toEqual(before.tables.taxPayment);
  });

  it('D-325 blocks bulk tax deletes and retains the paid record', () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'tax.markPaid', taxPaymentId: 'sample-tax-1' }).ok).toBe(true);
    const before = store.getSnapshot();
    expect(moneyDomain.route?.('원천세 납부 일정 전부 지워줘', before, 'ko')).toMatchObject({ kind: 'refusal', reason: 'unsupported' });
    expect(moneyDomain.route?.('원천세 납부 기록 지워줘', before, 'ko')).toMatchObject({ kind: 'refusal', reason: 'widget_only' });
    expect(store.getSnapshot()).toBe(before);
  });

  it('D-326 Q2 edits one past expense on the card as before → after and restores it from the receipt', () => {
    const store = createWidgetDataStore();
    // Earlier business days of the café seed are already settled, so today is the editable past expense.
    expect(store.dispatch({ type: 'ledger.recordExpense', category: 'supplies', amount: 30_000, date: TODAY, memo: '냅킨' }).ok).toBe(true);
    const before = store.getSnapshot();
    const id = before.tables.expense.at(-1)!.expenseId;
    const route = moneyDomain.route?.('오늘 소모품 3만원 지출을 4만원으로 고쳐줘', before, 'ko');
    expect(route).toMatchObject({ intent: { command: 'ledger.updateExpense' }, slots: { amount: 40_000 } });
    if (!route || !('intent' in route) || route.intent.kind !== 'command') throw Error('Missing expense edit route');
    const actions = createAgentActions(store, createDomainRegistry([moneyDomain]));
    const prepared = actions.prepare({ proposalId: 'edit', command: 'ledger.updateExpense', args: { ...route.intent.args, expenseId: { handle: 'selected' } },
      runId: before.runId!, snapshotRevision: before.revision, layer: 'management', tier: 'normal' },
    route.slots ?? {}, before, undefined, new Map([['selected', { kind: 'expense' as const, id }]]));
    if (prepared.kind !== 'proposal') throw Error(prepared.kind);
    const { proposal } = prepared;
    expect(proposal.tier).toBe('normal');
    expect((proposal.preview as { fields: { before: string; after: string }[] }).fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ before: '30,000원', after: '40,000원' }),
    ]));
    expect(store.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(store, proposal.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(store.getSnapshot().tables.expense.find(row => row.expenseId === id)).toMatchObject({ amount: 40_000, businessDate: TODAY });
    expect(proposal.confirm(store, proposal.id).frame).toEqual(receipt.frame);
    expect(receipt.undoToken && store.undo(receipt.undoToken).ok).toBe(true);
    expect(store.getSnapshot().tables.expense).toEqual(before.tables.expense);
  });

  it('D-326 Q2 keeps a settled day, deletes and several expenses in the ledger widget', () => {
    const store = createWidgetDataStore();
    const day = addDays(TODAY, -3);
    expect(store.dispatch({ type: 'ledger.recordExpense', category: 'supplies', amount: 30_000, date: day }).ok).toBe(true);
    const base = store.getSnapshot();
    const closed = { ...base, tables: { ...base.tables, dayClosing: [...base.tables.dayClosing,
      { ...base.tables.dayClosing.at(-1)!, businessDate: day, scenario: 'normal' as const, status: 'closed' as const }] } };
    expect(closed.tables.dayClosing.some(row => row.businessDate === day && row.status === 'closed')).toBe(true);
    expect(moneyDomain.route?.(`${day.slice(5, 7)}월 ${Number(day.slice(8))}일 소모품 지출을 4만원으로 고쳐줘`, closed, 'ko')).toMatchObject({
      kind: 'refusal', reason: 'widget_only', alternative: { featureId: 'ledger' },
    });
    for (const text of ['소모품 지출 삭제해줘', '지출 전부 4만원으로 고쳐줘']) {
      expect(moneyDomain.route?.(text, base, 'ko'), text).toMatchObject({ kind: 'refusal' });
    }
    // Without the switch the same sentence still goes to the widget.
    expect(createMoneyDomain({ allowExpenseEntry: true }).route?.('오늘 소모품 3만원 지출을 4만원으로 고쳐줘', base, 'ko')).toMatchObject({ kind: 'refusal', reason: 'widget_only' });
    expect(store.getSnapshot()).toBe(base);
  });

  it('S2-069 brings a matching tax schedule to review and leaves the store untouched', () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'tax.createPayment', taxType: '원천세(10월분)', amount: 132_000, dueOn: '2026-11-10', idempotencyKey: 'legacy-tax' }).ok).toBe(true);
    const original = store.getSnapshot();
    expect(feature.route?.('원천세 10월분 132,000원 11월 10일 납부 기록 추가해줘', original, 'ko'))
      .toMatchObject({ kind: 'clarification', field: 'confirmDuplicate' });
    expect(store.getSnapshot()).toBe(original);
  });

  it('S1-307 finds an existing same-month rent expense on a different date', () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'ledger.recordExpense', category: 'rent', amount: 1_800_000, date: addDays(TODAY, -1) }).ok).toBe(true);
    const original = store.getSnapshot();
    expect(feature.route?.('이번 달 임대료 180만원 냈어', original, 'ko')).toMatchObject({
      kind: 'clarification', field: 'confirmDuplicate', answer: expect.stringContaining('11월 16일'),
    });
    expect(store.getSnapshot()).toBe(original);
  });

  it('keeps an explicitly opened expense form unsaved and seeds its validated fields', () => {
    const store = createWidgetDataStore();
    const original = store.getSnapshot();
    const plan = feature.navigation?.('어제 소모품 3만원 지출 기록 폼 열어줘 (냅킨)', original, 'ko');
    expect(validateAgentDetailRef(plan?.args)).toBe(true);
    expect(plan?.args).toMatchObject({
      featureId: 'ledger', view: 'expenses', focus: 'action',
      prefill: { amount: 30_000, date: addDays(TODAY, -1), category: 'supplies', memo: '냅킨', evidence: 'none' },
    });
    expect(moneyDetailPrefill({ featureId: 'ledger', view: 'expenses', focus: 'action',
      prefill: { kind: 'widget-draft', command: 'ui.openDetail', fields: { amount: -1 } } })).toBeUndefined();
    expect(store.getSnapshot()).toBe(original);
  });

  it('requires a fresh expense preview after another write changes the revision', () => {
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const actions = createAgentActions(store, domains);
    const result = actions.prepare({ proposalId: 'expense-stale', command: 'ledger.recordExpense',
      args: { date: { slot: 'date' }, amount: { slot: 'amount' }, category: 'supplies' },
      runId: snapshot.runId!, snapshotRevision: snapshot.revision, layer: 'management', tier: 'normal' },
    { amount: 30_000, date: TODAY }, snapshot);
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') throw Error('Missing expense proposal');
    expect(store.dispatch({ type: 'ledger.recordExpense', category: 'other', amount: 5_000, date: TODAY }).ok).toBe(true);
    const updated = store.getSnapshot();
    expect(result.proposal.confirm(store).frame.outcome).toBe('conflict');
    expect(store.getSnapshot()).toBe(updated);
  });

  it('keeps an unavailable named tax period and due date scoped to the request', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    expect(feature.navigation?.('세무관리 9월 기준으로 보여줘', snapshot, 'ko')).toBeNull();
    expect(feature.route?.('세무관리 9월 기준으로 보여줘', snapshot, 'ko')).toMatchObject({
      intent: { kind: 'read', featureId: 'tax', condition: { kind: 'dateRange', start: '2026-09-01', end: '2026-09-30' } },
    });
    expect(feature.navigation?.('11월 10일 세금 항목 어디서 봐?', snapshot, 'ko')).toBeNull();
    expect(feature.route?.('11월 10일 세금 항목 어디서 봐?', snapshot, 'ko')).toMatchObject({
      intent: { kind: 'read', recordKind: 'taxPayment' },
    });
  });
});
