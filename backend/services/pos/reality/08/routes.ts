import { uuid } from '../../wire.ts';
import type { PosOwnerRouteWithPreflight } from '../../preflight.ts';
import type { OrderDependencies } from './input.ts';
import { prepareCreateOrder, prepareUpdateOrder, transitionOrder, undoOrder } from './orders.ts';
import { quoteReversal, quoteSettlement, recordCorrection, recordPayment, undoPayment } from './payments.ts';
import { listOrders, listPickups, listTemplates, orderDetail, templateDetail } from './records.ts';
import { archiveTemplate, generateTemplate, saveTemplate, undoTemplate } from './templates.ts';
import { undoCustomReceipt } from './undo.ts';

export function registerCustomOrderRoutes(owner: PosOwnerRouteWithPreflight, options: OrderDependencies & { reversalSecret: string }) {
  const { reversalSecret, customer } = options;
  owner('GET', '/custom-templates', 'read', (tx, _, _body, _key, query) => listTemplates(tx, query));
  owner('GET', '/custom-templates/:id', 'read', (tx, { id }) => templateDetail(tx, uuid(id)));
  owner('POST', '/custom-templates', 'command', (tx, _, body, key) => saveTemplate(tx, key, body));
  owner('POST', '/custom-templates/generate', 'command', (tx, _, body, key) => generateTemplate(tx, key, body));
  owner('PATCH', '/custom-templates/:id', 'command', (tx, { id }, body, key) => saveTemplate(tx, key, body, uuid(id)));
  owner('DELETE', '/custom-templates/:id', 'command', (tx, { id }, body, key) => archiveTemplate(tx, key, uuid(id), body));
  owner('GET', '/custom-orders', 'read', (tx, _, _body, _key, query) => listOrders(tx, query, customer));
  owner('GET', '/custom-orders/:id', 'read', (tx, { id }) => orderDetail(tx, uuid(id), customer));
  owner('POST', '/custom-orders', 'command', {
    prepare: (scope, _params, body, key) => prepareCreateOrder(scope, options, key, body),
  });
  owner('PATCH', '/custom-orders/:id', 'command', {
    prepare: (scope, { id }, body, key) => prepareUpdateOrder(scope, options, key, uuid(id), body),
  });
  owner('POST', '/custom-orders/:id/transitions', 'command', (tx, { id }, body, key) => transitionOrder(tx, key, uuid(id), body));
  owner('POST', '/custom-orders/:id/settlement-quote', 'read', (tx, { id }, body) => quoteSettlement(tx, options, reversalSecret, uuid(id), body));
  owner('POST', '/custom-orders/:id/payments', 'command', (tx, { id }, body, key) => recordPayment(tx, options, reversalSecret, key, uuid(id), body));
  owner('POST', '/custom-orders/:id/reversal-quote', 'read', (tx, { id }, body) => quoteReversal(tx, reversalSecret, uuid(id), body));
  owner('POST', '/custom-orders/:id/corrections', 'command', (tx, { id }, body, key) => recordCorrection(tx, reversalSecret, key, uuid(id), body));
  owner('GET', '/custom-pickups', 'read', (tx, _, _body, _key, query) => listPickups(tx, query));
  owner('POST', '/custom-pickups/:id/transitions', 'command', (tx, { id }, body, key) => transitionOrder(tx, key, uuid(id), body, true));
  owner('POST', '/custom-receipts/receipts/:id/undo', 'command', (tx, { id }, body, key) =>
    undoCustomReceipt(tx, key, uuid(id), body, effect => {
      if (effect.kind === 'template') return undoTemplate(tx, effect);
      if (effect.kind === 'payment') return undoPayment(tx, reversalSecret, effect);
      return undoOrder(tx, effect);
    }));
}
