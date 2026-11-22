import { randomBytes } from 'node:crypto';
import type { ReadPosCatalog } from '../../catalog.ts';
import { applyCommand } from '../../ledger.ts';
import { correctPayment, createReversalTokens, quoteReversal } from '../../reversals.ts';
import { integer, object, PosError, uuid, validKey } from '../../wire.ts';
import type { PosTx } from '../../wire.ts';
import type { PosOwnerRoute } from '../02/routes.ts';
import { validDate } from '../02/terminal.ts';
import { balance, balances, entries } from './accounts.ts';
import { quoteMemberCheckout, recordMemberCheckout } from './checkout.ts';
import type { CustomerMemberClient } from './customer-client.ts';
import { readFunding, recordFunding, refundFunding } from './funding.ts';

type PrivateRegistrar = (method: 'POST', path: string, mode: 'write',
  handle: (tx: PosTx, params: { storeId: string; id?: string }, body: unknown) => Promise<unknown>) => void;
type Options = { customer: CustomerMemberClient; readCatalog?: ReadPosCatalog };

export function registerMemberAccountRoutes(owner: PosOwnerRoute, { customer, readCatalog }: Options) {
  owner('GET', '/member-accounts', 'read', (tx, _params, _body, _key, query) => balances(tx, query));
  owner('GET', '/member-accounts/:id', 'read', async (tx, { id }) => {
    const memberId = uuid(id);
    await customer.member(tx.storeId, memberId, tx.at.toISOString().slice(0, 10));
    return balance(tx, memberId);
  });
  owner('GET', '/member-accounts/:id/entries', 'read', (tx, { id }, _body, _key, query) => entries(tx, uuid(id), query));
  owner('POST', '/member-accounts/:id/entries', 'command', (tx, { id }, body, key) =>
    recordFunding(tx, customer, key, uuid(id), body));
  owner('GET', '/member-funding/:id', 'read', (tx, { id }) => readFunding(tx, uuid(id)));
  owner('POST', '/member-funding/:id/refunds', 'command', (tx, { id }, body, key) =>
    refundFunding(tx, key, uuid(id), body, customer));
  owner('POST', '/bills/:id/member-quote', 'read', (tx, { id }, body) =>
    quoteMemberCheckout(tx, customer, uuid(id), body, readCatalog));
  owner('POST', '/bills/:id/member-payments', 'command', (tx, { id }, body, key) =>
    recordMemberCheckout(tx, customer, key, uuid(id), body, readCatalog));
}

export function registerMemberArchiveRoute(registrar: PrivateRegistrar, { customer, readCatalog }: Options) {
  const localTokens = createReversalTokens(randomBytes(32).toString('hex'));
  registrar('POST', '/member-uses/use', 'write', (tx, _params, body) => {
    const input = object(body, ['actorId', 'key', 'memberId', 'membershipId', 'billId', 'allocationId', 'expectedRevision', 'kind']);
    const actorId = uuid(input.actorId);
    const memberId = uuid(input.memberId);
    const membershipId = uuid(input.membershipId);
    const billId = uuid(input.billId);
    const allocationId = uuid(input.allocationId);
    const expectedRevision = integer(input.expectedRevision, 1);
    const { kind } = input;
    if (kind !== 'count' && kind !== 'period') throw new PosError(400, 'INVALID_REQUEST');
    if (!validKey(input.key)) throw new PosError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const key = input.key;
    const scopedTx = { ...tx, actorId };
    return applyCommand(scopedTx, 'member.use.record', key, { memberId, membershipId, billId, allocationId, expectedRevision, kind }, async () => {
      const checkout = { memberId, allocations: [{ kind: 'membership_' + kind, membershipId, allocationId, quantity: 1 }] };
      const checkoutKey = key + ':member-use';
      const { quoteRevision, accountRevision, passRevision } =
        await quoteMemberCheckout(scopedTx, customer, billId, checkout, readCatalog, checkoutKey);
      if (passRevision !== expectedRevision) throw new PosError(409, 'STALE_REVISION', { revision: passRevision });
      return recordMemberCheckout(scopedTx, customer, checkoutKey, billId, { ...checkout, quoteRevision, accountRevision }, readCatalog);
    });
  });
  registrar('POST', '/member-uses/cancel', 'write', (tx, _params, body) => {
    const input = object(body, ['memberId', 'settlementId', 'useId', 'actorId', 'key', 'confirmed']);
    const memberId = uuid(input.memberId);
    const settlementId = uuid(input.settlementId);
    const useId = uuid(input.useId);
    const actorId = uuid(input.actorId);
    if (input.confirmed !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
    if (!validKey(input.key)) throw new PosError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const key = input.key;
    const scopedTx = { ...tx, actorId };
    return applyCommand(scopedTx, 'member.use.cancel', key, { memberId, settlementId, useId }, async () => {
      const { rowCount } = await tx.db.query(`SELECT 1 FROM pos.member_sale s
        WHERE store_id=$1 AND member_id=$2 AND settlement_id=$3 AND has_pass AND cash_amount=0
          AND (SELECT count(*) FROM pos.settlement_line WHERE store_id=$1 AND settlement_id=$3)=1
          AND NOT EXISTS (SELECT 1 FROM pos.member_account_entry WHERE store_id=$1 AND settlement_id=$3)`,
      [tx.storeId, memberId, settlementId]);
      if (!rowCount) throw new PosError(409, 'MEMBERSHIP_POS_CONTEXT_REQUIRED');
      const quote = await quoteReversal(scopedTx, localTokens, settlementId, { kind: 'cancel' });
      if (!quote.canSubmit) throw new PosError(409, quote.issues[0]?.reason ?? 'MEMBERSHIP_POS_CONTEXT_REQUIRED', quote.issues[0]?.details);
      return correctPayment(scopedTx, localTokens, key + ':member-use', quote.quoteToken, { settlementId, terminal: null });
    });
  });
  for (const undo of [false, true]) {
    registrar('POST', undo ? '/member-archive/undo' : '/member-archive', 'write', async (tx, _params, body) => {
      const input = object(body, ['memberId', 'actorId', 'key', 'businessDate',
        ...(undo ? ['receiptId'] : ['expectedRevision', 'confirmed'])]);
      const memberId = uuid(input.memberId);
      const actorId = uuid(input.actorId);
      if (!validKey(input.key)) throw new PosError(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const key = input.key;
      const businessDate = input.businessDate;
      if (typeof businessDate !== 'string' || !validDate(businessDate)) throw new PosError(400, 'INVALID_REQUEST');
      if (!undo && input.confirmed !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
      const command = undo ? { receiptId: uuid(input.receiptId) } : { expectedRevision: integer(input.expectedRevision, 1), confirmed: true };
      await tx.db.query('INSERT INTO pos.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [tx.storeId]);
      return applyCommand({ ...tx, actorId }, 'member.archive', key, { memberId, ...command }, async () => {
        const current = await balance(tx, memberId);
        if (current.chargeBalance || current.receivableBalance) throw new PosError(409, 'MEMBER_DELETE_BLOCKED',
          { charge: current.chargeBalance, receivable: current.receivableBalance });
        const { rows } = await tx.db.query<{ membership_id: string }>(`SELECT membership_id FROM pos.member_funding
          WHERE store_id=$1 AND member_id=$2 AND expires_on >= $3::date ORDER BY membership_id`, [tx.storeId, memberId, businessDate]);
        // Customer confirms these POS purchases were projected before checking active passes.
        return customer.archive(tx.storeId, { memberId, actorId, key, businessDate, ...command,
          purchasedMembershipIds: rows.map(row => row.membership_id) }, undo);
      });
    });
  }
}
