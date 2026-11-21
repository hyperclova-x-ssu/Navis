import { describe, expect, it } from 'vitest';
import * as engine from './index';
import { applied, credit, membership, method, read, source, terms, transact, withPass } from './test-fixtures';

describe('M3 review money regressions', () => {
  it.each(['count', 'period'] as const)('RV-1 abandons a partial %s use exactly once and permits repayment', kind => {
    const firstPrice = kind === 'count' ? 4500 : 5000;
    const s = source('bill', firstPrice + 5000, { lines: [source('bill', firstPrice).lines[0], source('second', 5000).lines[0]],
      parts: [{ partId: 'first', amount: firstPrice, allocationIds: ['line:bill'] }, { partId: 'second', amount: 5000, allocationIds: ['line:second'] }] });
    let r = withPass({ ...read(), sources: [s] }, terms(kind));
    const allocation = membership(r, kind === 'count' ? 'membership_count' : 'membership_period', kind === 'count' ? 4000 : 0);
    r = transact(r, { purpose: 'sale', billId: 'bill', partId: 'first' }, [allocation]).read;
    expect(r.state.uses.filter(u => !u.canceledAt)).toHaveLength(1);
    const command = { sourceRef: s.sourceRef, meta: { runId: r.runId, idempotencyKey: 'abandon' } };
    r = applied(r, engine.planAbandonSettlement(r, command));
    expect(r.state.uses.filter(u => !u.canceledAt)).toHaveLength(0);
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0, gross: 0, discount: 0 }, deposits: { total: 0 }, orderCount: 0, cost: 0 });
    expect(r.state.recognitions).toEqual([]);
    expect(engine.planAbandonSettlement(r, command)).toMatchObject({ ok: true, duplicate: true, changed: false });
    r = transact(r, { purpose: 'sale', billId: 'bill', partId: 'first' }, [allocation], 'retry-first').read;
    r = transact(r, { purpose: 'sale', billId: 'bill', partId: 'second' }, [method(5000)], 'retry-second').read;
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: kind === 'count' ? 9000 : 5000 }, deposits: { total: 5000 }, orderCount: 1 });
    expect(r.state.recognitions.reduce((n, x) => n + (x.quantity ?? 0), 0)).toBe(2);
  });

  it.each([false, true])('RV-2 conserves mixed allocations and physical metrics with odd discounts=%s', discounted => {
    const discounts = discounted ? { direct: 1, coupon: 3, membership: 0 } : { direct: 0, coupon: 0, membership: 0 };
    const s = source('bill', 9000 - discounts.direct - discounts.coupon, { lines: [{ ...source().lines[0], quantity: 2, unitCost: 1501, discountBySource: discounts }] });
    let r = credit({ ...read(), sources: [s] });
    r = transact(r, { purpose: 'sale', billId: 'bill' }, [method(4501), { kind: 'charge', amount: s.amountDue - 4501 }]).read;
    const settlementId = r.state.settlements.at(-1)!.settlementId;
    for (let i = 0; i < 2; i++) {
      const q = engine.quoteMoneyReversal(r, { settlementId, kind: 'cancel', lines: [{ allocationId: 'line:bill', quantity: 1 }] });
      expect(q.issues).toEqual([]);
      expect(q.amount).toBe(discounted ? i === 0 ? 4499 : 4497 : 4500);
      expect(q.recognitionEffects.reduce((n, x) => n + (x.quantity ?? 0), 0)).toBe(-1);
      expect(q.recognitionEffects.reduce((n, x) => n + (x.gross ?? 0), 0)).toBe(-4500);
      expect(q.recognitionEffects.reduce((n, x) => n + (x.cost ?? 0), 0)).toBe(-1501);
      r = applied(r, engine.planMoneyReversal(r, { quote: q, meta: { runId: r.runId, idempotencyKey: `cancel-${i}` } }));
    }
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0, gross: 0, discount: 0 }, orderCount: 0, cost: 0 });
    expect(engine.selectMemberAccounts(r).chargeBalance).toBe(50000);
    expect(r.state.corrections.reduce((n, c) => n + c.amount, 0)).toBe(s.amountDue);
  });

  it.each([
    ['refund', 'refund', 'refund'],
    ['cancel', 'cancel', 'cancel'],
    ['cancel', 'refund', 'refund'],
    ['refund', 'cancel', 'cancel'],
    ['cancel', 'refund', 'cancel'],
    ['refund', 'cancel', 'refund'],
  ] as const)('FIX-1 returns one Americano at 4500 through %s, %s, %s', (...kinds) => {
    const s = source('bill', 13500, { prepared: false, lines: [{ ...source().lines[0], quantity: 3 }] });
    let r = transact({ ...read(), sources: [s] }, { purpose: 'sale', billId: 'bill' }, [method(13500)]).read;
    const settlementId = r.state.settlements[0].settlementId;
    let physicalQuantity = 3;
    for (const [i, kind] of kinds.entries()) {
      r = { ...r, sources: [{ ...s, prepared: kind === 'refund' }] };
      const quote = engine.quoteMoneyReversal(r, { settlementId, kind, lines: [{ allocationId: 'line:bill', quantity: 1 }] });
      expect(quote.issues).toEqual([]);
      expect(quote.amount).toBe(4500);
      expect(quote.realMethodReturns).toEqual([{ method: 'card', amount: 4500 }]);
      expect(quote.lineEffects).toEqual(kind === 'refund' ? [] : [{ allocationId: 'line:bill', orderLineId: 'orderline:bill', menuId: 'm-americano', quantity: -1, stock: [{ itemId: 'beans', deltaBase: 18 }] }]);
      r = applied(r, engine.planMoneyReversal(r, { quote, meta: { runId: r.runId, idempotencyKey: `return-${i}` } }));
      if (kind === 'cancel') physicalQuantity--;
      expect(r.state.recognitions.reduce((n, row) => n + (row.quantity ?? 0), 0)).toBe(physicalQuantity);
      expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 9000 - i * 4500, gross: physicalQuantity * 4500 }, deposits: { total: 9000 - i * 4500 }, cost: physicalQuantity * 1500 });
    }
    expect(engine.selectMoneyReceipt(r, { settlementId })).toMatchObject({ remainingRefundable: 0, reversalLines: [] });
    expect(r.state.corrections.reduce((n, row) => n + row.amount, 0)).toBe(13500);
  });

  it('FIX-1 leaves the odd won on the last refunded unit across original card and charge allocations', () => {
    const s = source('bill', 9001, { prepared: true, lines: [{ ...source().lines[0], quantity: 2, unitPrice: 4501, discountBySource: { direct: 1, coupon: 0, membership: 0 } }] });
    let r = credit({ ...read(), sources: [s] });
    r = transact(r, { purpose: 'sale', billId: 'bill' }, [method(4501), { kind: 'charge', amount: 4500 }]).read;
    const settlementId = r.state.settlements.at(-1)!.settlementId;
    for (const [i, amount] of [4500, 4501].entries()) {
      const quote = engine.quoteMoneyReversal(r, { settlementId, kind: 'refund', lines: [{ allocationId: 'line:bill', quantity: 1 }] });
      expect(quote.issues).toEqual([]);
      expect(quote.amount).toBe(amount);
      expect(quote.realMethodReturns).toEqual([{ method: 'card', amount: i === 0 ? 2250 : 2251 }]);
      expect(quote.accountEffects).toMatchObject([{ account: 'charge', amount: 2250 }]);
      expect(quote.lineEffects).toEqual([]);
      r = applied(r, engine.planMoneyReversal(r, { quote, meta: { runId: r.runId, idempotencyKey: `refund-${i}` } }));
    }
    expect(engine.selectMemberAccounts(r).chargeBalance).toBe(50000);
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0, gross: 9002, discount: 1 }, deposits: { total: 50000 }, cost: 3000 });
  });

  it.each(['cancel', 'refund'] as const)('FIX-2 restricts a mixed receipt to current per-line actions, starting with %s', firstKind => {
    const s = source('bill', 9500, { prepared: false, lines: [source().lines[0], source('latte', 5000).lines[0]] });
    let r = transact({ ...read(), sources: [s] }, { purpose: 'sale', billId: 'bill' }, [method(9500)]).read;
    r = { ...r, sources: [{ ...s, prepared: true, lines: s.lines.map((line, i) => ({ ...line, prepared: i === 0 })) }] };
    const settlementId = r.state.settlements[0].settlementId;
    expect(engine.selectMoneyReceipt(r, { settlementId })).toMatchObject({ currentPrepared: true, sourceSnapshot: { prepared: false }, reversalLines: [
      { allocationId: 'line:bill', quantity: 1, prepared: true }, { allocationId: 'line:latte', quantity: 1, prepared: false },
    ] });
    for (const kind of ['cancel', 'refund'] as const) {
      const reason = kind === 'cancel' ? 'USE_REFUND' : 'USE_CANCEL';
      for (const scope of [{}, { amount: 1000 }, { lines: [{ allocationId: 'line:bill', quantity: 1 }, { allocationId: 'line:latte', quantity: 1 }] }]) {
        const quote = engine.quoteMoneyReversal(r, { settlementId, kind, ...scope });
        expect(quote).toMatchObject({ canSubmit: false, issues: [{ reason }] });
        expect(engine.planMoneyReversal(r, { quote, meta: { runId: r.runId, idempotencyKey: `blocked-${kind}` } })).toMatchObject({ ok: false, reason });
      }
    }
    const kinds = firstKind === 'cancel' ? ['cancel', 'refund'] as const : ['refund', 'cancel'] as const;
    for (const [i, kind] of kinds.entries()) {
      const allocationId = kind === 'refund' ? 'line:bill' : 'line:latte';
      const quote = engine.quoteMoneyReversal(r, { settlementId, kind, lines: [{ allocationId, quantity: 1 }] });
      expect(quote).toMatchObject({ canSubmit: true, amount: kind === 'refund' ? 4500 : 5000, issues: [] });
      if (i === 1) expect(engine.quoteMoneyReversal(r, { settlementId, kind })).toMatchObject({ canSubmit: true, amount: quote.amount });
      r = applied(r, engine.planMoneyReversal(r, { quote, meta: { runId: r.runId, idempotencyKey: `mixed-${kind}` } }));
    }
    expect(engine.selectMoneyReceipt(r, { settlementId })).toMatchObject({ remainingRefundable: 0, reversalLines: [] });
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0, gross: 4500 }, deposits: { total: 0 }, cost: 1500 });
  });

  it('RV-4 exposes current preparation while retaining immutable paid-at facts', () => {
    const paid = transact({ ...read(), sources: [source('bill', 4500, { prepared: false })] }, { purpose: 'sale', billId: 'bill' }, [method(4500)]).read;
    const current = { ...paid, sources: [source('bill', 4500, { prepared: true })] };
    expect(engine.selectMoneyReceipt(current, { settlementId: paid.state.settlements[0].settlementId })).toMatchObject({ currentPrepared: true,
      sourceSnapshot: { prepared: false }, reversalLines: [{ allocationId: 'line:bill', quantity: 1, prepared: true }] });
  });

  describe.each([true, false])('FIX-3 residual all with item split=%s', split => {
    it.each(['refund', 'cancel'] as const)('keeps refunded Americano usage when starting with %s', firstKind => {
      const americano = { ...source().lines[0], prepared: true };
      const latte = { ...source('latte', 5000).lines[0], prepared: false, unitCost: 2000,
        recipe: [{ itemId: 'beans', quantityBase: 18 }, { itemId: 'milk', quantityBase: 200 }] };
      const s = source('bill', split ? 14000 : 9500, { prepared: true,
        lines: split ? [americano, latte, { ...source('other').lines[0], prepared: true }] : [americano, latte],
        ...(split ? { parts: [
          { partId: 'first', amount: 9500, allocationIds: ['line:bill', 'line:latte'] },
          { partId: 'second', amount: 4500, allocationIds: ['line:other'] },
        ] } : {}),
      });
      let r = transact({ ...read(), sources: [s] }, { purpose: 'sale', billId: 'bill', ...(split ? { partId: 'first' } : {}) },
        [method(4751), method(4749, 'cash')]).read;
      const settlementId = r.state.settlements[0].settlementId;
      if (split) r = transact(r, { purpose: 'sale', billId: 'bill', partId: 'second' }, [method(4500, 'easy_pay')]).read;
      const kinds = firstKind === 'refund' ? ['refund', 'cancel'] as const : ['cancel', 'refund'] as const;
      for (const [i, kind] of kinds.entries()) {
        const allocationId = kind === 'refund' ? 'line:bill' : 'line:latte';
        const quote = engine.quoteMoneyReversal(r, { settlementId, kind,
          ...(i === 0 ? { lines: [{ allocationId, quantity: 1 }] } : {}),
        });
        expect(quote).toMatchObject({ canSubmit: true, issues: [], amount: kind === 'refund' ? 4500 : 5000 });
        expect(quote.quantityReturns).toEqual([{ allocationId, quantity: 1 }]);
        expect(quote.recognitionEffects.length).toBeGreaterThan(0);
        if (i === 1) expect(quote.recognitionEffects.every(row => row.billAllocationId === allocationId && row.settlementId === settlementId)).toBe(true);
        expect(quote.recognitionEffects.reduce((n, row) => n + (row.quantity ?? 0), 0)).toBe(kind === 'cancel' ? -1 : 0);
        expect(quote.recognitionEffects.reduce((n, row) => n + (row.cost ?? 0), 0)).toBe(kind === 'cancel' ? -2000 : 0);
        expect(quote.realMethodReturns).toEqual(kind === 'refund'
          ? [{ method: 'card', amount: 2250 }, { method: 'cash', amount: 2250 }]
          : [{ method: 'card', amount: 2501 }, { method: 'cash', amount: 2499 }]);
        expect(quote.lineEffects).toEqual(kind === 'refund' ? [] : [{ allocationId: 'line:latte', orderLineId: 'orderline:latte', menuId: 'm-latte', quantity: -1,
          stock: [{ itemId: 'beans', deltaBase: 18 }, { itemId: 'milk', deltaBase: 200 }] }]);
        r = applied(r, engine.planMoneyReversal(r, { quote, meta: { runId: r.runId, idempotencyKey: `residual-${kind}` } }));
        expect(r.state.corrections.at(-1)).toMatchObject({ quantityReturns: [{ allocationId, quantity: 1 }], lineEffects: quote.lineEffects });
      }
      expect(engine.selectMoneyReceipt(r, { settlementId })).toMatchObject({ remainingRefundable: 0, reversalLines: [] });
      expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: split ? 4500 : 0, gross: split ? 9000 : 4500 },
        deposits: { total: split ? 4500 : 0, byMethod: { card: 0, cash: 0, easy_pay: split ? 4500 : 0 } }, cost: split ? 3000 : 1500 });
      expect(r.state.recognitions.filter(row => row.billAllocationId === 'line:bill').reduce((n, row) => n + (row.quantity ?? 0), 0)).toBe(1);
      expect(r.state.recognitions.filter(row => row.billAllocationId === 'line:bill').reduce((n, row) => n + (row.cost ?? 0), 0)).toBe(1500);
    });
  });
});
