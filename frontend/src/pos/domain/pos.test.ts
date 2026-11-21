import { describe, expect, it } from 'vitest';
import type { PosCommand, PosPlan, PosReadSnapshot } from '../../contracts/pos';
import { createPosSeed, createPosSeedCatalog, posSeedLinks } from '../seed';
import { allocatePosAmount, planPosCommand, planPosUndo, quoteCart, selectPosDayTotals, selectPosSalesByMenu } from './index';
import { POS_NOW } from '../clock';
import manifest from '../../data/db/generated/manifest.json';
import { seedToday } from '../../data/db/generated/today';
import { createPosSeed as createLegacyPosSeed } from '../seed/legacy';

const americano = createPosSeedCatalog().items.find(menu => menu.menuId === 'm-americano')!;
const americanoOptions = (temperature: 'HOT' | 'ICE') =>
  americano.groups.flatMap(group => group.options.filter(option => [temperature, '레귤러'].includes(option.name)).map(option => option.optionId));


const cafeCatalog = createPosSeedCatalog();
const latte = cafeCatalog.items.find(menu => menu.menuId === 'm-cafe-latte')!;
const temperature = latte.groups.find(group => group.name === '온도')!;
const latteIce = temperature.options.find(option => option.name === 'ICE')!.optionId;
// The cafe paid modifiers lack recipe costs. Add two priced groups to exercise this scenario.
const pricedLatte = { ...latte, groups: [temperature,
  { groupId: 'test-size', menuId: latte.menuId, name: '사이즈', required: false, options: [
    { optionId: 'test-size:up', groupId: 'test-size', name: '사이즈업', extraPrice: 500, extraCost: 350,
      extraRecipe: [{ itemId: 'i-milk', quantityBase: 100, unitDimension: 'mL' as const }] },
  ] },
  { groupId: 'test-extra', menuId: latte.menuId, name: '추가', required: false, options: [
    { optionId: 'test-extra:shot', groupId: 'test-extra', name: '샷 추가', extraPrice: 500, extraCost: 300,
      extraRecipe: [{ itemId: 'i-bean-house', quantityBase: 12, unitDimension: 'g' as const }] },
  ] },
] };
const catalog = { ...cafeCatalog, items: cafeCatalog.items.map(menu => menu === latte ? pricedLatte : menu) };

const settings = { businessType: 'cafe', paymentStyle: 'prepaid', tableLayout: null, revision: 0 } as const;
function read(): PosReadSnapshot {
  return { runId: 'run', runRevision: 0, pos: createPosSeed(), posRevision: 0,
    posUi: { tab: 'order', approval: null, cartUndo: null }, dataRevision: 0,
    settings, scenario: 'normal', data: { revision: 0, catalog, dayClosed: false, closingGeneration: 0 } };
}
function apply(r: PosReadSnapshot, command: PosCommand): { read: PosReadSnapshot; plan: PosPlan } {
  const result = planPosCommand(r, command, POS_NOW);
  if (!result.ok) throw new Error(result.reason);
  return { plan: result.plan, read: { ...r, pos: result.plan.nextPos, posRevision: result.plan.nextPos.revision, posUi: result.plan.nextUi } };
}
const add = (key: string, options = americanoOptions('ICE'), qty = 1): Extract<PosCommand, { type: 'cart.add' }> =>
  ({ type: 'cart.add', meta: { runId: 'run', idempotencyKey: key }, menuId: 'm-americano', optionIds: options, qty });

describe('T-241 cart amounts and state', () => {
  it('requires one temperature, merges normalized options, and keeps different requests apart', () => {
    const initial = read();
    expect(planPosCommand(initial, add('missing', []), POS_NOW)).toMatchObject({ ok: false, reason: 'REQUIRED_OPTION' });
    expect(planPosCommand(initial, add('twice', [...americanoOptions('ICE'), americanoOptions('HOT')[0]]), '')).toMatchObject({ ok: false, reason: 'REQUIRED_OPTION' });
    let r = apply(initial, add('one')).read;
    r = apply(r, add('two')).read;
    r = apply(r, add('hot', americanoOptions('HOT'))).read;
    r = apply(r, { ...add('request'), request: '연하게' }).read;
    expect(r.pos.cart.lines.map(l => l.qty)).toEqual([2, 1, 1]);
    expect(quoteCart(r)).toMatchObject({ totalQty: 4, gross: 12000, discount: 0, payable: 12000, canSubmit: true });
  });
  it('quotes paid options and current prices, while rejecting removed or sold-out choices', () => {
    let r = apply(read(), { type: 'cart.add', meta: { runId: 'run', idempotencyKey: 'latte' }, menuId: latte.menuId, optionIds: [latteIce, 'test-size:up', 'test-extra:shot'] }).read;
    expect(quoteCart(r)).toMatchObject({ gross: 4800, lines: [{ unitPrice: 4800, optionPrice: 1000, unitCost: 1928 }] });
    r = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: r.data.catalog.items.map(m => m.menuId === latte.menuId ? { ...m, price: 5500 } : m) } } };
    expect(quoteCart(r).payable).toBe(6500);
    const sold = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: r.data.catalog.items.map(m => ({ ...m, saleStatus: 'sold_out' as const })) } } };
    expect(quoteCart(sold)).toMatchObject({ canSubmit: false, issues: [{ reason: 'SOLD_OUT' }] });
    const removed = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: [] } } };
    expect(quoteCart(removed)).toMatchObject({ canSubmit: false, issues: [{ reason: 'ITEM_REMOVED' }] });
  });
  it.each([
    { mode: 'cart', qty: 2, gross: 12200, groupId: 'test-size' },
    { mode: 'option-dialog', qty: 1, gross: 6100, groupId: temperature.groupId },
  ])('keeps live selected option amounts in an invalid $mode quote', ({ mode, qty, gross, groupId }) => {
    let r = read();
    if (mode === 'cart') r = apply(r, { type: 'cart.add', meta: { runId: 'run', idempotencyKey: 'latte' }, menuId: latte.menuId, optionIds: [latteIce, 'test-extra:shot'], qty }).read;
    else r = { ...r, pos: { ...r.pos, cart: { ...r.pos.cart, lines: [{ lineId: 'preview', menuId: latte.menuId, selectedOptionIds: ['test-extra:shot'], qty, request: '' }] } } };
    r = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: r.data.catalog.items.map(m => m.menuId === latte.menuId ? { ...m, price: 5500,
      groups: m.groups.map(g => ({ ...g, required: g.required || mode === 'cart' && g.groupId === groupId,
        options: g.options.map(o => o.optionId === 'test-extra:shot' ? { ...o, extraPrice: 600 } : o) })) } : m) } } };
    const quote = quoteCart(r);
    expect(quote).toMatchObject({ canSubmit: false, gross, payable: gross, lines: [{ basePrice: 5500, optionPrice: 600, unitPrice: 6100, gross }], issues: [{ reason: 'REQUIRED_OPTION', groupId }] });
    expect(quote.lines[0].options).toEqual(expect.arrayContaining([expect.objectContaining({ optionId: 'test-extra:shot', extraPrice: 600 })]));
  });
  it('keeps live paid option amounts on a sold-out line', () => {
    let r = apply(read(), { type: 'cart.add', meta: { runId: 'run', idempotencyKey: 'sold-latte' }, menuId: latte.menuId, optionIds: [latteIce, 'test-size:up', 'test-extra:shot'], qty: 2 }).read;
    r = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: r.data.catalog.items.map(m => m.menuId === latte.menuId ? { ...m, saleStatus: 'sold_out' as const, price: 5500,
      groups: m.groups.map(g => ({ ...g, options: g.options.map(o => o.optionId === 'test-extra:shot' ? { ...o, extraPrice: 600 } : o) })) } : m) } } };
    expect(quoteCart(r)).toMatchObject({ canSubmit: false, gross: 13200, payable: 13200,
      lines: [{ name: '카페라떼', basePrice: 5500, optionPrice: 1100, unitPrice: 6600, gross: 13200 }], issues: [{ reason: 'SOLD_OUT' }] });
  });
  it.each(['removed', 'deleted'] as const)('keeps the added menu name and amount after the menu is %s', mode => {
    let r = apply(read(), { type: 'cart.add', meta: { runId: 'run', idempotencyKey: 'removed-latte' }, menuId: latte.menuId, optionIds: [latteIce, 'test-size:up', 'test-extra:shot'], qty: 2 }).read;
    r = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: mode === 'removed' ? r.data.catalog.items.filter(m => m.menuId !== latte.menuId) : r.data.catalog.items.map(m => m.menuId === latte.menuId ? { ...m, name: '삭제 후 이름', price: 0, deletedAt: POS_NOW } : m) } } };
    const quote = quoteCart(r);
    expect(quote).toMatchObject({ canSubmit: false, gross: 9600, payable: 9600,
      lines: [{ name: '카페라떼', qty: 2, basePrice: 3800, optionPrice: 1000, unitPrice: 4800, gross: 9600 }], issues: [{ reason: 'ITEM_REMOVED' }] });
    expect(quote.lines[0].options).toEqual(expect.arrayContaining([expect.objectContaining({ optionId: 'test-extra:shot', name: '샷 추가', extraPrice: 500 })]));
  });
  it.each(['removed', 'archived', 'group-removed'] as const)('keeps the added option name and amount when the option is %s', mode => {
    let r = apply(read(), { type: 'cart.add', meta: { runId: 'run', idempotencyKey: 'removed-shot' }, menuId: latte.menuId, optionIds: [latteIce, 'test-size:up', 'test-extra:shot'], qty: 2 }).read;
    r = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: r.data.catalog.items.map(m => m.menuId === latte.menuId ? { ...m, price: 5500,
      groups: m.groups.filter(g => mode !== 'group-removed' || g.groupId !== 'test-extra').map(g => ({ ...g,
        options: g.options.filter(o => mode !== 'removed' || o.optionId !== 'test-extra:shot').map(o => o.optionId === 'test-extra:shot' ? { ...o, name: '보관한 옵션', extraPrice: 0, archivedAt: POS_NOW } : o.optionId === 'test-size:up' ? { ...o, extraPrice: 700 } : o) })) } : m) } } };
    const quote = quoteCart(r);
    expect(quote).toMatchObject({ canSubmit: false, gross: 13400, payable: 13400,
      lines: [{ name: '카페라떼', basePrice: 5500, optionPrice: 1200, unitPrice: 6700, gross: 13400 }], issues: [{ reason: 'INVALID_OPTION' }] });
    expect(quote.lines[0].options).toEqual(expect.arrayContaining([expect.objectContaining({ optionId: 'test-extra:shot', name: '샷 추가', extraPrice: 500 })]));
  });
  it('rejects invalid quantities, duplicate/archived options, bad recipe FKs and units without changing state', () => {
    const r = read();
    for (const qty of [-1, 0, 100, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(planPosCommand(r, add(`q${qty}`, undefined, qty), '')).toMatchObject({ ok: false, reason: 'QTY_LIMIT' });
    }
    expect(planPosCommand(r, add('duplicate', [...americanoOptions('ICE'), americanoOptions('ICE')[0]]), '')).toMatchObject({ ok: false, reason: 'INVALID_OPTION' });
    const bad = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, ingredients: [] } } };
    expect(planPosCommand(bad, add('bad-recipe'), '')).toMatchObject({ ok: false, reason: 'INVALID_RECIPE' });
    const unit = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, ingredients: r.data.catalog.ingredients.map(i => ({ ...i, unitDimension: 'mL' as const })) } } };
    expect(planPosCommand(unit, add('bad-unit'), '')).toMatchObject({ ok: false, reason: 'INVALID_RECIPE' });
    expect(r.pos.cart.lines).toHaveLength(0);
  });
  it('restores a removed line in its position and rejects undo after a subsequent cart write', () => {
    let r = apply(read(), add('one')).read;
    r = apply(r, { type: 'cart.add', meta: { runId: 'run', idempotencyKey: 'pastry' }, menuId: 'm-basque-cake', optionIds: [], qty: 2 }).read;
    const before = r.pos.cart;
    const removal = apply(r, { type: 'cart.quantity', meta: { runId: 'run', idempotencyKey: 'remove' }, lineId: before.lines[0].lineId, qty: 0 });
    const undo = planPosUndo(removal.read, removal.plan.result.undoToken!);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.plan.nextPos.cart.lines).toEqual(before.lines);
    expect(undo.plan.nextPos.payments).toBe(r.pos.payments);
    expect(planPosCommand({ ...removal.read, pos: undo.plan.nextPos }, { type: 'cart.quantity', meta: { runId: 'run', idempotencyKey: 'remove' }, lineId: before.lines[0].lineId, qty: 0 }, '')).toMatchObject({ ok: false, reason: 'COMMAND_UNDONE' });
    const next = apply(removal.read, add('later')).read;
    expect(planPosUndo(next, removal.plan.result.undoToken!)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  });
  it('preserves notes/type on clear undo, enforces text limits, and merges when replacing options', () => {
    let r = apply(read(), add('ice')).read;
    r = apply(r, add('hot', americanoOptions('HOT'))).read;
    r = apply(r, { type: 'cart.replaceOptions', meta: { runId: 'run', idempotencyKey: 'replace' }, lineId: r.pos.cart.lines[1].lineId, optionIds: americanoOptions('ICE') }).read;
    expect(r.pos.cart.lines.map(l => l.qty)).toEqual([2]);
    r = apply(r, { type: 'cart.note', meta: { runId: 'run', idempotencyKey: 'note' }, text: '창가 손님' }).read;
    r = apply(r, { type: 'cart.type', meta: { runId: 'run', idempotencyKey: 'type' }, orderType: 'takeout' }).read;
    expect(planPosCommand(r, { type: 'cart.note', meta: { runId: 'run', idempotencyKey: 'long' }, text: '가'.repeat(101) }, '')).toMatchObject({ ok: false, reason: 'TEXT_LIMIT' });
    const clear = apply(r, { type: 'cart.clear', meta: { runId: 'run', idempotencyKey: 'clear' } });
    expect(clear.read.pos.cart.lines).toHaveLength(0);
    const undo = planPosUndo(clear.read, clear.plan.result.undoToken!);
    expect(undo).toMatchObject({ ok: true, plan: { nextPos: { cart: { type: 'takeout', memo: '창가 손님', lines: [{ qty: 2 }] } } } });
  });
  it('checks idempotency before revisions but rejects mismatched payload and stale runs', () => {
    const first = apply(read(), add('key'));
    expect(planPosCommand(first.read, { ...add('key'), meta: { runId: 'run', idempotencyKey: 'key', expectedPosRevision: 0 } }, '')).toMatchObject({ ok: true, plan: { result: { duplicate: true } } });
    expect(planPosCommand(first.read, add('key', undefined, 2), '')).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_MISMATCH' });
    expect(planPosCommand(first.read, { ...add('stale'), meta: { runId: 'old', idempotencyKey: 'stale' } }, '')).toMatchObject({ ok: false, reason: 'STALE_RUN' });
    expect(planPosCommand(first.read, { ...add('rev'), meta: { runId: 'run', idempotencyKey: 'rev', expectedPosRevision: 0 } }, '')).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
  });
  it('derives cafe ledger totals, menu quantities and preparation from the generated day', () => {
    const r = read();
    expect(selectPosDayTotals(r.pos)).toMatchObject({ gross: 859500, discount: 28280, discountBySource: { membership: 0, coupon: 19000, direct: 9280 },
      charged: 831220, refund: 0, revenue: 831220, paymentCount: manifest.counts.payments, refundCount: 0,
      byMethod: { card: 557050, easy_pay: 217270, cash: 56900 }, methodCounts: { card: 103, easy_pay: 39, cash: 11 } });
    const sold = selectPosSalesByMenu(r.pos);
    const quantities = seedToday.pos.orders.flatMap(order => order.lines).reduce<Record<string, number>>((counts, line) => {
      counts[line.menuId] = (counts[line.menuId] ?? 0) + line.qty;
      return counts;
    }, {});
    expect(sold).toEqual(quantities);
    expect(r.pos.orders.map(o => o.preparation)).toEqual(seedToday.pos.orders.map(o => o.preparation));
    expect(r.pos.seq).toBe(seedToday.pos.seq);
  });

  it('retains the legacy refund and baseline bridge links for the old mockup', () => {
    expect(selectPosDayTotals(createLegacyPosSeed())).toMatchObject({ refund: 10000, refundCount: 1 });
    expect(posSeedLinks.baselineBridge.couponSeedIncluded).toHaveLength(2);
    expect(posSeedLinks.fallbacks).toHaveLength(3);
  });

  it('allocates discount remainders exactly and preserves the historical sale cost', () => {
    expect(allocatePosAmount(2, [{ id: 'b', amount: 1 }, { id: 'a', amount: 1 }, { id: 'c', amount: 1 }])).toEqual({ a: 1, b: 1, c: 0 });
    const r = read();
    const discountSum = r.pos.bills.flatMap(b => b.settlementLines).flatMap(l => l.discountAllocations).reduce((n, d) => n + d.amount, 0);
    expect(discountSum).toBe(28280);
    expect(r.pos.bills.flatMap(b => b.settlementLines).reduce((n, l) => n + (l.unitCostAtSale! + l.optionCostAtSale!) * l.recognizedQty, 0)).toBe(244333);
  });
  it('keeps 99 as the line limit, blocks locked carts, and rejects archived selected options', () => {
    const r = apply(read(), add('99', undefined, 99)).read;
    expect(planPosCommand(r, add('100'), '')).toMatchObject({ ok: false, reason: 'QTY_LIMIT' });
    const locked = { ...r, pos: { ...r.pos, cart: { ...r.pos.cart, lock: 'bill' } } };
    expect(planPosCommand(locked, { type: 'cart.clear', meta: { runId: 'run', idempotencyKey: 'locked' } }, '')).toMatchObject({ ok: false, reason: 'BILL_LOCKED' });
    const archived = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: r.data.catalog.items.map(m => ({ ...m, groups: m.groups.map(g => ({ ...g, options: g.options.map(o => ({ ...o, archivedAt: POS_NOW })) })) })) } } };
    expect(quoteCart(archived)).toMatchObject({ canSubmit: false, issues: [{ reason: 'INVALID_OPTION' }] });
  });
  it('rejects amounts or accumulated sale costs outside safe integer KRW', () => {
    let r = apply(read(), { ...add('shot', [latteIce, 'test-extra:shot']), menuId: latte.menuId }).read;
    r = { ...r, data: { ...r.data, catalog: { ...r.data.catalog, items: r.data.catalog.items.map(m => m.menuId === latte.menuId ? { ...m, unitCost: Number.MAX_SAFE_INTEGER } : m) } } };
    expect(quoteCart(r)).toMatchObject({ canSubmit: false, issues: [{ reason: 'INVALID_AMOUNT' }] });
    const huge = apply(read(), add('huge')).read;
    const changed = { ...huge, data: { ...huge.data, catalog: { ...huge.data.catalog, items: huge.data.catalog.items.map(m => m.menuId === 'm-americano' ? { ...m, price: Number.MAX_SAFE_INTEGER } : m) } } };
    expect(planPosCommand(changed, { type: 'approval.begin', cartId: changed.pos.cart.cartId, quoteRevision: changed.pos.cart.revision, splits: [{ method: 'card', amount: Number.MAX_SAFE_INTEGER }], meta: { runId: 'run', idempotencyKey: 'huge-pay' } }, POS_NOW)).toMatchObject({ ok: false, reason: 'INVALID_AMOUNT' });
  });
});
