import { describe, expect, it } from 'vitest';
import type { PosPlanningResult, PosReadSnapshot } from '../../contracts/pos';
import { createTableLayout } from '../../layout/table-layout';
import { createPosSeed, createPosSeedCatalog, createPosUi } from '../seed';
import { planTableCommand } from './commands';
import { normalizePosSettings } from './preferences';
import { planCartCommand } from '../domain/cart';
import { createLinkedOccupancyState, observeLinkedOccupancy, reconcileLinkedOccupancy, selectLinkedTableStates } from '../../data/iteration7/table-links';
import { POS_NOW } from '../clock';

const americano = createPosSeedCatalog().items.find(menu => menu.menuId === 'm-americano')!;
const americanoOptions = (temperature: 'HOT' | 'ICE') =>
  americano.groups.flatMap(group => group.options.filter(option => [temperature, '레귤러'].includes(option.name)).map(option => option.optionId));


function read(): PosReadSnapshot {
  const pos = createPosSeed();
  return { runId: 'links-test', runRevision: 0, pos, posRevision: pos.revision, posUi: createPosUi(), dataRevision: 0,
    settings: { businessType: 'cafe', paymentStyle: 'postpaid', tableLayout: createTableLayout(), revision: 0,
      ...{ cctvPosLinks: [{ zoneId: 't2', tableId: 'T2' }] } }, scenario: 'normal',
    data: { revision: 0, catalog: createPosSeedCatalog(), dayClosed: false, closingGeneration: 0 } };
}

describe('T-279 existing POS settings paths', () => {
  it('clears the waiting task on real order submission and starts fresh after unpaid cancellation', () => {
    let current = read();
    let occupancy = observeLinkedOccupancy(current, createLinkedOccupancyState(), { zoneId: 't2', state: 'occupied', observedAt: POS_NOW, elapsedNow: 0 });
    expect(selectLinkedTableStates(current, { occupancy, elapsedNow: 600_001 }).seatedWithoutOrderTasks).toHaveLength(1);
    const apply = (result: PosPlanningResult) => {
      if (!result.ok) throw new Error(result.reason);
      current = { ...current, pos: result.plan.nextPos, posUi: result.plan.nextUi, posRevision: result.plan.nextPos.revision,
        dataRevision: result.plan.result.dataRevision, settings: result.plan.dataChanges?.settings ?? current.settings };
    };
    apply(planCartCommand(current, { type: 'cart.add', menuId: 'm-americano', optionIds: americanoOptions('HOT'), qty: 1,
      meta: { runId: current.runId, idempotencyKey: 'add' } }));
    apply(planTableCommand(current, { type: 'bill.submitOrder', cartId: current.pos.cart.cartId, tableId: 'T2',
      meta: { runId: current.runId, idempotencyKey: 'order' } }, POS_NOW));
    occupancy = reconcileLinkedOccupancy(current, occupancy, 600_001);
    expect(occupancy.seatedWithoutOrder).toEqual([]);
    expect(selectLinkedTableStates(current, { occupancy, elapsedNow: 900_000 }).seatedWithoutOrderTasks).toEqual([]);
    const orderId = current.pos.orders.at(-1)!.orderId;
    apply(planTableCommand(current, { type: 'order.cancelUnpaid', orderId,
      meta: { runId: current.runId, idempotencyKey: 'cancel' } }, POS_NOW));
    occupancy = reconcileLinkedOccupancy(current, occupancy, 900_000);
    expect(occupancy.seatedWithoutOrder).toEqual([{ zoneId: 't2', tableId: 'T2', since: 900_000 }]);
    expect(selectLinkedTableStates(current, { occupancy, elapsedNow: 900_001 }).seatedWithoutOrderTasks).toEqual([]);
  });

  it('prunes the deleted table association in the existing layout command', () => {
    const before = read(), layout = before.settings.tableLayout!;
    const result = planTableCommand(before, { type: 'table.saveLayout', layout: { ...layout, revision: 1, tables: layout.tables.filter(t => t.tableId !== 'T2') },
      expectedSettingsRevision: 0, meta: { runId: before.runId, idempotencyKey: 'remove-table' } }, POS_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.dataChanges?.settings).toMatchObject({ cctvPosLinks: [], revision: 1 });
    expect(before.settings).toMatchObject({ cctvPosLinks: [{ zoneId: 't2', tableId: 'T2' }], revision: 0 });
  });

  it('retains inactive links when the table preference is switched off', () => {
    const before = read();
    const result = planTableCommand(before, { type: 'pos.setPreferences', showTables: false,
      meta: { runId: before.runId, idempotencyKey: 'hide-tables' } }, POS_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.dataChanges?.settings).toMatchObject({ cctvPosLinks: [{ zoneId: 't2', tableId: 'T2' }], posPreferences: { showTables: false } });
    expect(result.plan.nextPos.orders).toBe(before.pos.orders);
  });

  it('normalizes the generic settings path without removing valid inactive links', () => {
    const settings = { ...read().settings, paymentStyle: 'prepaid' as const, cctvPosLinks: [{ zoneId: 't1', tableId: 'T1' }, { zoneId: 'gone', tableId: 'removed' }] };
    expect(normalizePosSettings(settings)).toMatchObject({ cctvPosLinks: [{ zoneId: 't1', tableId: 'T1' }] });
  });
});
