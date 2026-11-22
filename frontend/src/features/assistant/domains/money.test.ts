// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { PosCashReceipt } from '../../../contracts/pos';
import { createWidgetDataStore, readModel, resolveDataText, TODAY } from '../../../data/widget-data';
import { addDays, WEEK_START } from '../../../data/db/time';
import { createAgentActions } from '../agent-actions';
import { assistantDomains } from '../snapshot';
import { navisTranslator } from '../messages';
import { widgetHandoffRef } from '../widget-handoff';
import { createDomainRegistry } from './registry';
import { createMoneyDomain, moneyDetailPrefill, moneyDomain, projectMoneyFacts } from './money';
import { validateAgentDetailRef } from '../../../../shared/navis-agent-schema.mjs';

const feature = createMoneyDomain({ allowExpenseEntry: true, allowTaxDelete: true });
const domains = createDomainRegistry([feature]);

function taxSnapshot(today = addDays(TODAY, 4)) {
  const snapshot = createWidgetDataStore().getSnapshot();
  const preview = {
    from: today, to: today, asOf: `${today}T00:00:00Z`, sourceRevision: 1,
    preview: {
      sales: { total: 0 }, deposits: { total: 0 },
      expenses: { total: 0, count: 0, evidenceRecorded: 0, missingEvidence: 0 },
      reviews: { needsCheck: 0, checked: 0 },
      taxPayments: { count: 0, paidTotal: 0, unpaidTotal: 0, withEvidenceFile: 0 },
      cashReceipts: null, rowCount: 0,
    },
    verification: { status: 'verified' as const }, estimate: null, connections: [], officialLinks: { hometax: '' },
  };
  const period = { preview, reviews: [] };
  return { ...snapshot, tables: { ...snapshot.tables, realTax: { today, month: period, last: period } } };
}

describe('N11 bookkeeping boundary', () => {
  it('anchors same-day tax reads to the tax service date when POS is on a different day', () => {
    const today = addDays(TODAY, 4);
    const real = taxSnapshot(today);
    expect(feature.route?.('오늘 현금영수증 몇 건 발행했어?', real, 'ko')).toMatchObject({
      intent: { kind: 'read', featureId: 'tax', condition: { kind: 'dateRange', start: today, end: today } },
    });
    expect(projectMoneyFacts(real, 'tax', { kind: 'dateRange', start: today, end: today }, 'ko'))
      .toMatchObject({ facts: expect.arrayContaining([expect.objectContaining({ key: 'tax.cashReceipts', value: 'unavailable', date: today })]) });
  });

  it('reads attached evidence and hands a file removal request to the tax widget', () => {
    const snapshot = taxSnapshot();
    const taxPaymentId = '3c90bbbb-6ad8-4b5b-8cd0-56b009936c93';
    const withAttachment = {
      ...snapshot, tables: {
        ...snapshot.tables,
        taxPayment: [{
          taxPaymentId, type: { raw: '원천세' }, amount: 40000, dueOn: TODAY, paidOn: null,
          status: 'unpaid' as const, evidence: 'none' as const,
          real: { revision: 2, overdue: true, evidenceFiles: [{
            fileId: 'ec215760-78f9-4d97-8f5c-7e0ccb8d77fa', contentType: 'application/pdf',
            attachedAt: `${TODAY}T00:00:00Z`, size: 400, sha256: 'a'.repeat(64),
          }] },
        }],
      },
    };
    const fact = projectMoneyFacts(withAttachment, 'tax', { kind: 'default' }, 'ko')?.facts?.find(row => row.key === 'tax.payment');
    expect(fact?.display).toContain('증빙 있음');
    const route = feature.route?.('원천세 증빙 지워줘', withAttachment, 'ko');
    expect(route).toMatchObject({
      kind: 'refusal', reason: 'widget_only', alternative: {
        featureId: 'tax', step: 'tax-evidence-removal', itemId: taxPaymentId,
      },
    });
    if (!route || !('alternative' in route) || !route.alternative) throw new Error('Missing evidence handoff');
    expect(widgetHandoffRef(route.alternative)).toEqual({
      featureId: 'tax', view: 'evidence', itemId: taxPaymentId, focus: 'action',
    });
    expect(withAttachment.tables.taxPayment[0].real.evidenceFiles).toHaveLength(1);
  });

  it('S1-278 uses Monday through the business day, distinct from the rolling week', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const condition = { kind: 'dateRange', start: WEEK_START, end: TODAY } as const;
    expect(feature.route?.('월요일부터 지금까지 매출', snapshot, 'ko')).toMatchObject({
      intent: { kind: 'read', featureId: 'ledger', condition },
    });
    const expectedNet = snapshot.tables.dailySales.filter(row => row.businessDate >= WEEK_START && row.businessDate <= TODAY)
      .reduce((sum, row) => sum + (row.recognizedNet ?? row.gross - row.discount - row.refund), 0);
    expect(projectMoneyFacts(snapshot, 'ledger', condition, 'ko')).toMatchObject({
      facts: expect.arrayContaining([expect.objectContaining({ key: 'ledger.sales.net', start: WEEK_START, end: TODAY, value: expectedNet })]),
    });
  });

  it('reads one historical expense day with its confirmed expense and evidence only', () => {
    const store = createWidgetDataStore();
    const date = addDays(TODAY, -1);
    expect(store.dispatch({ type: 'ledger.recordExpense', date, category: 'supplies', amount: 24_000, evidence: 'card', memo: '컵 보충' }).ok).toBe(true);
    const projection = projectMoneyFacts(store.getSnapshot(), 'ledger', { kind: 'dateRange', start: date, end: date }, 'ko');
    const expenses = projection?.facts?.filter(row => row.key === 'ledger.expense.row') ?? [];
    expect(expenses).toEqual(expect.arrayContaining([expect.objectContaining({ label: '컵 보충', date, value: 24_000, display: expect.stringContaining('카드') })]));
    expect(expenses.every(row => row.date === date)).toBe(true);
  });

  it.each([
    ['A유통에 우유값 7만원 줬어 세금계산서 받았어', 'supplierId'],
    ['우유 대금 70,000원 지출 기록해줘 A유통 세금계산서', 'supplierId'],
    ['직원 간식 10,000원 지출 기록해줘', 'category'],
    ['오늘 소모품 12.5원 기록', 'amount'],
    ['소모품 30000원 날짜는 아무때나', 'date'],
    ['지방소득세 영 원 11월 30일 납부 기록', 'amount'],
    ['지방소득세 310000원 11월 31일 납부 일정', 'dueOn'],
    ['지방소득세 31만 원 13월 5일까지', 'dueOn'],
    ['원천세 금액 마이너스 십오만원', 'amount'],
    ['31만 원 11월 30일까지 낼 세금 추가해줘', 'taxType'],
  ])('asks for just the missing or invalid field in "%s"', (utterance, field) => {
    const original = createWidgetDataStore().getSnapshot();
    // A staff keyword must not win over explicit expense recording.
    expect(assistantDomains.route(utterance, original, 'ko', 'staff-schedule')).toMatchObject({ kind: 'clarification', field });
  });

  it('S1-298 recognizes the supplier spoken alongside a category and amount', () => {
    const original = createWidgetDataStore().getSnapshot();
    expect(feature.route?.('오늘 에이유통 우유 70000원 원재료로 넣어줘', original, 'ko')).toMatchObject({
      kind: 'clarification', field: 'supplierId',
    });
  });

  it('S1-298 rechecks the corrected supplier before binding it and retains the expense fields', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const tr = navisTranslator('ko');
    const supplier = snapshot.tables.supplier.find(row => !row.deletedAt)!;
    const supplierName = resolveDataText(tr.t, supplier.name ?? { key: supplier.nameKey });
    const first = feature.route?.('A유통에 우유값 7만원 줬어 세금계산서 받았어', snapshot, 'ko');
    if (!first || !('kind' in first) || first.kind !== 'clarification') throw Error('Missing supplier clarification');
    expect(first.resume?.('네 해줘')).toMatchObject({ kind: 'clarification', field: 'supplierId' });
    expect(first.resume?.(supplierName)).toMatchObject({
      intent: { command: 'ledger.recordExpense' },
      slots: { category: 'ingredients', date: TODAY, amount: 70_000, evidence: 'tax-invoice', name: supplierName },
      lookups: [{ kind: 'supplier', querySlot: 'name', bind: ['supplierId'] }],
    });
  });

  it.each([
    '소모품 30,000원 지출 메모 냅킨 보충으로 기록해줘',
    '오늘 소모품 삼만원 (냅킨 보충)',
  ])('records the expense with its exact memo from "%s"', utterance => {
    expect(feature.route?.(utterance, createWidgetDataStore().getSnapshot(), 'ko')).toMatchObject({
      intent: { command: 'ledger.recordExpense' }, slots: { amount: 30_000, date: TODAY, category: 'supplies', memo: '냅킨 보충' },
    });
  });

  it('S2-041 answers a paid-tax history read and keeps explicit payments navigation', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    expect(feature.navigation?.('세금 낸 내역 쭉 보여줘', snapshot, 'ko')).toBeNull();
    expect(feature.route?.('세금 낸 내역 쭉 보여줘', snapshot, 'ko')).toMatchObject({
      intent: { kind: 'read', featureId: 'tax' }, factKeys: ['tax.payment.paidCount', 'tax.payment.paid'],
    });
    expect(feature.navigation?.('세금 납부 이력 보여줘', snapshot, 'ko')?.args).toMatchObject({ featureId: 'tax', view: 'payments' });
    expect(feature.navigation?.('ㅅㅁㄱㄹ 열어', snapshot, 'ko')?.args).toMatchObject({ featureId: 'tax', view: 'checks' });
  });

  it('S2-058 keeps shorthand paid-state requests at the exact widget target', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    expect(feature.route?.('원천세 낸 걸로 표시해', snapshot, 'ko')).toMatchObject({
      kind: 'refusal', reason: 'widget_only', alternative: { command: 'tax.markPaid', draft: { taxPaymentId: 'sample-tax-1' } },
    });
    expect(feature.route?.('원천세 납부 처리해줘', snapshot, 'ko')).toMatchObject({
      kind: 'refusal', reason: 'widget_only', alternative: { command: 'tax.markPaid', draft: { taxPaymentId: 'sample-tax-1' } },
    });
  });

  it('distinguishes actual tax payment history from unpaid schedules and grounds receipt totals', () => {
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    expect(feature.route?.('소득세 언제 냈는지 알려줘', snapshot, 'ko')).toMatchObject({
      intent: { kind: 'read', recordKind: 'taxPayment', querySlot: 'paidHistory' },
    });
    expect(feature.route?.('이번 달 현금영수증 얼마', snapshot, 'ko')).toMatchObject({
      intent: { kind: 'read', featureId: 'tax', condition: { kind: 'default' } }, factKeys: ['tax.cashReceipts'],
    });
    expect(projectMoneyFacts(snapshot, 'tax', { kind: 'default' }, 'ko')).toMatchObject({
      facts: expect.arrayContaining([expect.objectContaining({ key: 'tax.cashReceipts', value: 0, display: expect.stringContaining('0원') })]),
    });
  });

  it('scopes this year’s tax history by paid date', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const route = feature.route?.('올해 낸 세금 목록', snapshot, 'ko');
    expect(route).toMatchObject({
      intent: { kind: 'read', recordKind: 'taxPayment', querySlot: 'paidHistory' },
      slots: { paidHistory: `*\n\n\n${TODAY.slice(0, 4)}-01-01\n${TODAY}` },
    });
    if (!route || !('intent' in route) || typeof route.slots?.paidHistory !== 'string') throw Error('Missing year scope');
    const payment = (id: string, paidOn: string) => ({
      ...snapshot.tables.taxPayment[0], taxPaymentId: id, paidOn, status: 'paid' as const,
    });
    const withHistory = { ...snapshot, tables: { ...snapshot.tables, taxPayment: [
      ...snapshot.tables.taxPayment, payment('this-year', TODAY), payment('prior-year', '2025-12-31'),
    ] } };
    const matches = domains.reader('taxPayment')?.search({ snapshot: withHistory, locale: 'ko', query: route.slots.paidHistory, querySlot: 'paidHistory', privateLookup: false });
    expect(matches?.map(row => row.fields?.paidOn)).toEqual([TODAY]);
  });

  it('uses the POS receipt projection for today and the tax widget projection for the month', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const receipt = (id: string, date: string, cashAmount: number, status: PosCashReceipt['status']): PosCashReceipt => ({
      cashReceiptId: id, paymentId: `payment-${id}`, kind: 'income', maskedIdentifier: '010-****-3344',
      status, issuedAt: `${date}T10:00:00+09:00`, cashAmount,
    });
    const withReceipts = {
      ...snapshot,
      pos: {
        ...snapshot.pos!,
        cashReceipts: [
          receipt('today', TODAY, 2200, 'issued'),
          receipt('yesterday', addDays(TODAY, -1), 7500, 'issued'),
          receipt('canceled', TODAY, 6500, 'canceled'),
        ],
      },
    };
    const today = { kind: 'dateRange', start: TODAY, end: TODAY } as const;
    expect(feature.route?.('오늘 현금영수증 몇 건이야?', withReceipts, 'ko')).toMatchObject({
      intent: { kind: 'read', featureId: 'tax', condition: today },
    });
    expect(projectMoneyFacts(withReceipts, 'tax', today, 'ko')).toMatchObject({
      facts: [expect.objectContaining({ key: 'tax.cashReceipts', value: 1, display: expect.stringContaining('2,200원') })],
    });
    expect(projectMoneyFacts(withReceipts, 'tax', { kind: 'default' }, 'ko')).toMatchObject({
      facts: expect.arrayContaining([expect.objectContaining({ key: 'tax.cashReceipts', value: 2, display: expect.stringContaining('9,700원') })]),
    });
  });

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
