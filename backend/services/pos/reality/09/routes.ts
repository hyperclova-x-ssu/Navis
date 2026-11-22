import { uuid } from '../../wire.ts';
import type { PosOwnerRoute } from '../02/routes.ts';
import { date } from './input.ts';
import { readExpense, listExpenses, recordExpense, updateExpense, confirmCandidate, undoExpense, type ReadReceiptStatus } from './expenses.ts';
import { readLedger, listDeposits, listMargins } from './finance.ts';
import { readClosing, listClosings, closeDay, reopenDay, changeDrawer, addCashMovement, removeCashMovement } from './closings.ts';

export function registerFinanceRoutes(owner: PosOwnerRoute, { readReceiptStatus }: { readReceiptStatus?: ReadReceiptStatus } = {}) {
  owner('GET', '/expenses', 'read', (tx, _params, _body, _key, query) => listExpenses(tx, query));
  owner('GET', '/expenses/:id', 'read', async (tx, { id }) => {
    const expense = await readExpense(tx, uuid(id));
    return { ...expense, asOf: tx.at.toISOString(), sourceRevision: expense.revision };
  });
  owner('POST', '/expenses', 'command', (tx, _params, body, key) => recordExpense(tx, key, body));
  owner('PATCH', '/expenses/:id', 'command', (tx, { id }, body, key) => updateExpense(tx, key, uuid(id), body));
  owner('GET', '/expense-candidates', 'read', (tx, _params, _body, _key, query) => listExpenses(tx, query, true));
  owner('POST', '/expense-candidates/:id/confirm', 'command', (tx, { id }, body, key) =>
    confirmCandidate(tx, key, uuid(id), body, readReceiptStatus));
  owner('POST', '/finance/receipts/:id/undo', 'command', (tx, { id }, body, key) => undoExpense(tx, key, uuid(id), body));
  owner('GET', '/ledger', 'read', (tx, _params, _body, _key, query) => readLedger(tx, query));
  owner('GET', '/deposits', 'read', (tx, _params, _body, _key, query) => listDeposits(tx, query));
  owner('GET', '/margins', 'read', (tx, _params, _body, _key, query) => listMargins(tx, query));
  owner('GET', '/closings', 'read', (tx, _params, _body, _key, query) => listClosings(tx, query));
  owner('GET', '/closings/:id', 'read', async (tx, { id }) => {
    const closing = await readClosing(tx, date(id));
    return { ...closing, asOf: tx.at.toISOString(), sourceRevision: closing.revision };
  });
  owner('POST', '/closings', 'command', (tx, _params, body, key) => closeDay(tx, key, body));
  owner('POST', '/closings/:id/reopen', 'command', (tx, { id }, body, key) => reopenDay(tx, key, uuid(id), body));
  owner('PATCH', '/closings/:id/drawer', 'command', (tx, { id }, body, key) => changeDrawer(tx, key, date(id), body));
  owner('POST', '/cash-movements', 'command', (tx, _params, body, key) => addCashMovement(tx, key, body));
  owner('DELETE', '/cash-movements/:id', 'command', (tx, { id }, body, key) => removeCashMovement(tx, key, uuid(id), body));
}
