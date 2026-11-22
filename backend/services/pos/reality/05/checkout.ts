import { assertNoPendingApproval, quoteOpenBill, recognizeSale } from '../../sales.ts';
import { applyCommand, openDay } from '../../ledger.ts';
import { commandReceipt, fingerprint, integer, methods, object, PosError, uuid, type MethodSplit, type PosTx } from '../../wire.ts';
import type { ReadPosCatalog } from '../../catalog.ts';
import { endTableSession } from '../02/tables.ts';
import { parseTerminal, requireTerminal } from '../02/terminal.ts';
import { accountSources, allocateSources, balance, bumpAccount, publishBalance, writeEntry } from './accounts.ts';
import type { CustomerMemberClient } from './customer-client.ts';

type Value = { kind: 'charge' | 'receivable'; amount: number };
type Method = { kind: 'method' } & MethodSplit;
type PassUse = { kind: 'membership_count' | 'membership_period'; membershipId: string; allocationId: string; quantity: number };
type Allocation = Value | Method | PassUse;
type ReadInput = { memberId: string; allocations: Allocation[] };
const claimKey = (key: string, billId: string, input: ReadInput) => 'r1:' + fingerprint({ key, billId, ...input });

function parse(body: unknown, command: boolean) {
  const input = object(body, ['memberId', 'allocations', ...(command ? ['quoteRevision', 'terminal', 'accountRevision'] : [])]);
  const memberId = uuid(input.memberId);
  if (!Array.isArray(input.allocations) || !input.allocations.length || input.allocations.length > 6) throw new PosError(400, 'INVALID_REQUEST');
  const allocations = input.allocations.map((value): Allocation => {
    const kind = object(value, ['kind', 'method', 'amount', 'membershipId', 'allocationId', 'quantity']).kind;
    if (kind === 'method') {
      const row = object(value, ['kind', 'method', 'amount']);
      const method = methods.find(candidate => candidate === row.method);
      if (!method) throw new PosError(400, 'INVALID_REQUEST');
      return { kind, method, amount: integer(row.amount, 1) };
    }
    if (kind === 'charge' || kind === 'receivable') return { kind, amount: integer(object(value, ['kind', 'amount']).amount, 1) };
    if (kind === 'membership_count' || kind === 'membership_period') {
      const row = object(value, ['kind', 'membershipId', 'allocationId', 'quantity']);
      return { kind, membershipId: uuid(row.membershipId), allocationId: uuid(row.allocationId), quantity: integer(row.quantity, 1, 99) };
    }
    throw new PosError(400, 'INVALID_REQUEST');
  });
  const methodKeys = allocations.map(row => row.kind === 'method' ? row.method : row.kind.startsWith('membership_') ? 'pass' : row.kind);
  if (new Set(methodKeys).size !== methodKeys.length) throw new PosError(400, 'INVALID_REQUEST');
  return { memberId, allocations, ...(command && {
    quoteRevision: integer(input.quoteRevision, 0), terminal: parseTerminal(input.terminal),
    accountRevision: input.accountRevision === undefined ? undefined : integer(input.accountRevision, 0),
  }) };
}

async function plan(tx: PosTx, customer: CustomerMemberClient, billId: string, input: ReadInput,
  readCatalog?: ReadPosCatalog, requestKey?: string) {
  const day = await openDay(tx);
  const quote = await quoteOpenBill(tx, billId, day, readCatalog);
  const passUse = input.allocations.find((row): row is PassUse => row.kind === 'membership_count' || row.kind === 'membership_period');
  const member = await customer.member(tx.storeId, input.memberId, day, undefined, passUse?.membershipId, requestKey);
  if (!member.active || member.memberId !== input.memberId) throw new PosError(404, 'MEMBER_NOT_FOUND');
  const account = await balance(tx, input.memberId);
  const realSplits = input.allocations.flatMap((row): MethodSplit[] => row.kind === 'method' ? [{ method: row.method, amount: row.amount }] : [])
    .sort((a, b) => methods.indexOf(a.method) - methods.indexOf(b.method));
  const realAmount = realSplits.reduce((total, row) => total + row.amount, 0);
  const charge = input.allocations.find((row): row is Value => row.kind === 'charge')?.amount ?? 0;
  const receivable = input.allocations.find((row): row is Value => row.kind === 'receivable')?.amount ?? 0;
  const line = quote.lines.find(row => row.allocationId === passUse?.allocationId);
  const pass = member.pass;
  let covered = 0, recognizedAmount = 0;
  if (passUse) {
    if (!pass || pass.status !== 'active' || pass.startsOn > day || pass.endsOn < day || pass.usesLeft === 0 ||
      !line || (passUse.quantity !== 1 && passUse.quantity !== line.qty) || !pass.terms.menuIds.includes(line.menuId) ||
      (passUse.kind === 'membership_count') !== (pass.terms.kind === 'count')) throw new PosError(409, 'MEMBERSHIP_UNAVAILABLE');
    covered = passUse.quantity === line.qty ? line.amount : Math.floor(line.amount / line.qty);
    if (pass.terms.totalUses !== null) {
      const base = Math.trunc(pass.terms.soldPrice / pass.terms.totalUses);
      recognizedAmount = Math.min(covered, base + (pass.usesLeft === 1 ? pass.terms.soldPrice % pass.terms.totalUses : 0));
    }
  }
  const discount = covered - recognizedAmount;
  const amountDue = quote.payable - covered;
  if (!Number.isSafeInteger(realAmount + charge + receivable) || realAmount + charge + receivable !== amountDue) {
    throw new PosError(400, 'ALLOCATION_SUM_MISMATCH', { amountDue });
  }
  if (charge > account.chargeBalance) throw new PosError(409, 'CHARGE_BALANCE_EXCEEDED', { available: account.chargeBalance });
  if (!Number.isSafeInteger(account.receivableBalance + receivable)) throw new PosError(409, 'RECEIVABLE_LIMIT');
  const quoteRevision = Number.parseInt(fingerprint({ quote: quote.quoteRevision, revision: account.revision,
    pass: pass ? { revision: pass.revision, usesLeft: pass.usesLeft } : null, ...input }).slice(0, 13), 16);
  return { day, quote, quoteRevision, account, amountDue, realAmount, realSplits, charge, receivable, pass, passUse, discount, recognizedAmount };
}

export async function quoteMemberCheckout(tx: PosTx, customer: CustomerMemberClient, billId: string,
  body: unknown, readCatalog?: ReadPosCatalog, retryKey?: string) {
  const { memberId, allocations } = parse(body, false);
  const input = { memberId, allocations };
  const quote = await plan(tx, customer, billId, input, readCatalog, retryKey ? claimKey(retryKey, billId, input) : undefined);
  return { billId, memberId, allocations, quoteRevision: quote.quoteRevision, accountRevision: quote.account.revision,
    amountDue: quote.amountDue, realAmount: quote.realAmount, membershipDiscount: quote.discount, recognizedAmount: quote.recognizedAmount,
    ...(quote.pass && { passRevision: quote.pass.revision }),
    canSubmit: true, issues: [] };
}

export function recordMemberCheckout(tx: PosTx, customer: CustomerMemberClient, key: string, billId: string, body: unknown,
  readCatalog?: ReadPosCatalog) {
  const { memberId, allocations, quoteRevision, accountRevision, terminal } = parse(body, true);
  return applyCommand(tx, 'member.checkout', key, { billId, memberId, allocations, quoteRevision, accountRevision, terminal }, async () => {
    const requestKey = claimKey(key, billId, { memberId, allocations });
    const current = await plan(tx, customer, billId, { memberId, allocations }, readCatalog, requestKey);
    if (current.quoteRevision !== quoteRevision || (accountRevision !== undefined && accountRevision !== current.account.revision)) {
      throw new PosError(409, 'QUOTE_CHANGED');
    }
    requireTerminal(current.realSplits.some(row => row.method !== 'cash') ? 'terminal_record' : 'cash_record', terminal ?? null);
    await assertNoPendingApproval(tx, billId);
    const sources = current.charge ? await allocateSources(tx, memberId, 'charge', current.charge) : [];
    const revision = await bumpAccount(tx, memberId);
    const quote = current.passUse ? { ...current.quote, payable: current.quote.payable - current.discount,
      discount: current.quote.discount + current.discount, lines: current.quote.lines.map(line =>
        line.allocationId === current.passUse?.allocationId
          ? { ...line, amount: line.amount - current.discount, discount: line.discount + current.discount } : line) } : current.quote;
    const at = terminal ? new Date(terminal.occurredAt) : tx.at;
    const recordedAllocations = allocations.map(row => 'membershipId' in row
      ? { ...row, amount: current.recognizedAmount, membershipDiscount: current.discount } : row);
    const extra = ['pos.bills', 'pos.orders', 'pos.sales'];
    if (await endTableSession(tx, billId, 'cleaning')) extra.push('pos.tables');
    const sale = await recognizeSale(tx, { billId, businessDate: current.day, splits: current.realSplits }, quote, {
      terminal: terminal ?? null, member: { memberId, async beforePublish(settlementId) {
        const containsMemberValue = Boolean(current.charge || current.receivable || current.passUse);
        await tx.db.query(`INSERT INTO pos.member_sale
          (store_id,settlement_id,member_id,cash_amount,contains_member_value,has_pass,allocations)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tx.storeId, settlementId, memberId, current.realAmount,
          containsMemberValue, Boolean(current.passUse), JSON.stringify(recordedAllocations)]);
        const fields = { memberId, settlementId, businessDate: current.day, at };
        if (current.charge) await writeEntry(tx, { ...fields, account: 'charge', kind: 'use', amount: -current.charge }, sources);
        if (current.receivable) await writeEntry(tx, { ...fields, account: 'receivable', kind: 'sale', amount: current.receivable });
        await publishBalance(tx, memberId, settlementId);
        if (!current.passUse || !current.pass) return {};
        const { membershipId, allocationId, quantity } = current.passUse;
        const claim = await customer.reserve(tx.storeId, { actorId: tx.actorId, memberId, membershipId,
          sourceVersion: current.pass.revision, requestKey,
          businessDate: current.day });
        if (claim.state !== 'held') throw new PosError(409, 'MEMBERSHIP_UNAVAILABLE');
        return { claimId: claim.claimId, membershipContributions: [{ allocationId, quantity }] };
      } },
    });
    const { settlementId, paymentId, orderIds: [orderId] } = sale.value;
    return { ...commandReceipt(paymentId ?? settlementId, revision, [...accountSources, ...extra], paymentId ?? settlementId),
      billId, orderId, ...(paymentId && { paymentId }), settlementId, memberId, allocations: recordedAllocations };
  });
}
