import type { PosCatalog, PosOrder } from '../../contracts/pos';
import type { OrderInputs, OrderRecord, OrderRuntime } from '../../orders';

const menuKeys: Readonly<Record<string, string>> = {
  'm-americano': 'data.menu.americano', 'm-latte': 'data.menu.latte', 'm-vanilla': 'data.menu.vanillaLatte',
  'm-croissant': 'data.item.croissant', 'm-financier': 'data.item.financier',
  'm-beans200': 'data.item.beans200', 'm-dripbag': 'data.item.dripBagSet',
};

export function orderRuntime(order: PosOrder): OrderRuntime {
  return {
    id: order.orderId, status: order.preparation === 'completed' ? 'done' : order.preparation,
    doneAt: order.completedAt, preparedAt: order.preparedAt, completedInRun: order.completedInRun,
    completedFrom: order.preparation === 'completed' && order.completedInRun ? order.preparedAt ? 'preparing' : 'accepted' : undefined,
  };
}
export function orderRecord(order: PosOrder): OrderRecord {
  const lines = order.lines.filter(line => line.qty > line.canceledQty).map(line => ({
    menuId: line.menuId, menu: line.nameAtOrder, qty: line.qty - line.canceledQty, unitPrice: line.unitPriceAtOrder,
  }));
  return { id: order.orderId, no: order.orderNo, orderedAt: order.orderedAt, lines,
    amount: lines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0),
    initialStatus: order.preparation === 'completed' ? 'done' : order.preparation, initialDoneAt: order.completedAt };
}
/** No seed import: records, live catalog and businessNow are always supplied by the caller. */
export function orderInputs(orders: readonly PosOrder[], catalog: PosCatalog, businessNow: string): OrderInputs {
  const records = orders.map(orderRecord);
  const live = new Map(catalog.items.map(item => [item.menuId, item]));
  const ids = new Set([...live.keys(), ...records.flatMap(record => record.lines.map(line => line.menuId))]);
  return { records, businessNow, catalog: [...ids].map(menuId => {
    const item = live.get(menuId);
    const prepMin = item?.prepMin ?? 3;
    return { menuId, name: item?.name ?? '', key: menuKeys[menuId] ?? '', unitPrice: item?.price ?? 0, prepMin };
  }) };
}
