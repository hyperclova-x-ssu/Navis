import { randomUUID } from 'node:crypto';
import { appendOutbox, applyCommand, readCommand } from '../../ledger.ts';
import type { PosPreflight } from '../../preflight.ts';
import { object, PosError, uuid } from '../../wire.ts';
import { currentDay, money, revision as contentRevision, type FinanceTx } from '../09/input.ts';
import type { TaxEvidenceFile, VerifyTaxEvidence } from './evidence-client.ts';
import { addDays, amount, confirmed, cursorInput, day, limitInput, query, revisionInput, taxType } from './input.ts';
import { unchangedReceipt, undoableReceipt } from './receipts.ts';

export type TaxStatus = 'unpaid' | 'paid';
export const maxEvidenceFiles = 10;

type EvidenceFile = { fileId: string; contentType: string; size: number; sha256: string; attachedAt: string };
type PaymentDb = {
  taxPaymentId: string; type: string; typeKey: string; amount: number; dueOn: string; paidOn: string | null;
  status: TaxStatus; revision: number; paidRecordedAt: Date | null; paidRecordedBy: string | null;
  createdAt: Date; updatedAt: Date; deletedAt: Date | null; deletedBy: string | null; evidenceFiles: EvidenceFile[];
};
/** Undo image of the owner-editable state, including which Account files are attached. */
export type PaymentImage = {
  type: string; typeKey: string; amount: number; dueOn: string; paidOn: string | null; status: TaxStatus;
  paidRecordedAt: string | null; paidRecordedBy: string | null; deletedAt: string | null; deletedBy: string | null;
  evidenceFileIds: string[];
};

const columns = `p.tax_payment_id AS "taxPaymentId", p.tax_type AS type, p.type_key AS "typeKey",
  p.amount::double precision AS amount, p.due_on::text AS "dueOn", p.paid_on::text AS "paidOn", p.status, p.revision,
  p.paid_recorded_at AS "paidRecordedAt", p.paid_recorded_by AS "paidRecordedBy", p.created_at AS "createdAt",
  p.updated_at AS "updatedAt", p.deleted_at AS "deletedAt", p.deleted_by AS "deletedBy",
  coalesce((SELECT jsonb_agg(jsonb_build_object('fileId', e.file_id, 'contentType', e.content_type, 'size', e.size,
      'sha256', e.sha256, 'attachedAt', e.attached_at) ORDER BY e.attached_at, e.file_id)
    FROM pos.tax_evidence e
    WHERE e.store_id = p.store_id AND e.tax_payment_id = p.tax_payment_id AND e.detached_at IS NULL), '[]'::jsonb) AS "evidenceFiles"`;

export function paymentDto(row: PaymentDb, today: string) {
  return {
    taxPaymentId: row.taxPaymentId, type: row.type, amount: row.amount, dueOn: row.dueOn, paidOn: row.paidOn,
    status: row.status, overdue: row.status === 'unpaid' && row.dueOn < today, revision: row.revision,
    // D-347: a paid status is the owner's own record of a payment made outside Navis (Hometax, bank).
    paidRecordedAt: row.paidRecordedAt?.toISOString() ?? null,
    evidence: row.evidenceFiles.length ? 'attached' as const : 'none' as const,
    evidenceFiles: row.evidenceFiles.map(file => ({ ...file, attachedAt: new Date(file.attachedAt).toISOString() })),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}
export type TaxPaymentDto = ReturnType<typeof paymentDto>;

export async function readPayment(tx: FinanceTx, taxPaymentId: string, includeDeleted = false) {
  const { rows: [row] } = await tx.db.query<PaymentDb>(`
    SELECT ${columns} FROM pos.tax_payment p WHERE p.store_id = $1 AND p.tax_payment_id = $2
  `, [tx.storeId, taxPaymentId]);
  if (!row || (row.deletedAt && !includeDeleted)) throw new PosError(404, 'TAX_PAYMENT_NOT_FOUND');
  return row;
}

function image(row: PaymentDb): PaymentImage {
  return {
    type: row.type, typeKey: row.typeKey, amount: row.amount, dueOn: row.dueOn, paidOn: row.paidOn, status: row.status,
    paidRecordedAt: row.paidRecordedAt?.toISOString() ?? null, paidRecordedBy: row.paidRecordedBy,
    deletedAt: row.deletedAt?.toISOString() ?? null, deletedBy: row.deletedBy,
    evidenceFileIds: row.evidenceFiles.map(file => file.fileId),
  };
}

const stale = (row: PaymentDb) => new PosError(409, 'STALE_REVISION', { revision: row.revision });

async function save(tx: FinanceTx, taxPaymentId: string, next: PaymentImage, revision: number) {
  await tx.db.query(`
    UPDATE pos.tax_payment SET tax_type = $3, type_key = $4, amount = $5, due_on = $6, paid_on = $7, status = $8,
      paid_recorded_by = $9, paid_recorded_at = $10, deleted_at = $11, deleted_by = $12, revision = $13, updated_at = $14
    WHERE store_id = $1 AND tax_payment_id = $2
  `, [tx.storeId, taxPaymentId, next.type, next.typeKey, next.amount, next.dueOn, next.paidOn, next.status,
    next.paidRecordedBy, next.paidRecordedAt, next.deletedAt, next.deletedBy, revision, tx.at]);
}

async function bump(tx: FinanceTx, taxPaymentId: string, revision: number) {
  await tx.db.query('UPDATE pos.tax_payment SET revision = $3, updated_at = $4 WHERE store_id = $1 AND tax_payment_id = $2',
    [tx.storeId, taxPaymentId, revision, tx.at]);
}

/**
 * One event per committed revision. `calendarProjection` follows the B07 contract: an unpaid, active
 * payment projects its due date into the tax-admin calendar and briefing; paid or deleted withdraws it.
 * No tax type text, file names or bytes leave POS.
 */
async function dueEvent(tx: FinanceTx, row: PaymentDb) {
  const active = row.deletedAt === null;
  await appendOutbox(tx, 'pos.tax_due_changed.v1', row.taxPaymentId, {
    taxPaymentId: row.taxPaymentId, revision: row.revision, status: row.status, dueOn: row.dueOn, paidOn: row.paidOn,
    amount: row.amount, deleted: !active, evidenceCount: row.evidenceFiles.length,
    calendarProjection: { source: 'tax-due', sourceId: row.taxPaymentId, revision: row.revision,
      entry: active && row.status === 'unpaid' ? { date: row.dueOn } : null },
  });
}

async function committed(tx: FinanceTx, taxPaymentId: string, before: PaymentImage | null) {
  const row = await readPayment(tx, taxPaymentId, true);
  await dueEvent(tx, row);
  const receipt = await undoableReceipt(tx, 'tax-payment', taxPaymentId, row.revision, before);
  return { ...receipt, taxPaymentId, payment: paymentDto(row, await currentDay(tx)) };
}

async function unchanged(tx: FinanceTx, row: PaymentDb) {
  return { ...unchangedReceipt(row.taxPaymentId, row.revision), taxPaymentId: row.taxPaymentId,
    payment: paymentDto(row, await currentDay(tx)) };
}

async function paidDay(tx: FinanceTx, value: string) {
  if (value > await currentDay(tx)) throw new PosError(400, 'PAID_ON_FUTURE');
  return value;
}

export function createPayment(tx: FinanceTx, key: string, body: unknown) {
  const input = object(body, ['taxType', 'amount', 'dueOn', 'confirmDuplicate']);
  const { type, key: typeKey } = taxType(input.taxType);
  const value = amount(input.amount);
  const dueOn = day(input.dueOn);
  if (input.confirmDuplicate !== undefined && typeof input.confirmDuplicate !== 'boolean') throw new PosError(400, 'INVALID_REQUEST');
  const confirmDuplicate = input.confirmDuplicate === true;
  return applyCommand(tx, 'tax.payment.create', key, { type, amount: value, dueOn, confirmDuplicate }, async () => {
    if (!confirmDuplicate) {
      // Past due dates stay allowed (recording overdue debt). The same obligation is surfaced first.
      const { rows: [same] } = await tx.db.query(`
        SELECT tax_payment_id AS "taxPaymentId", tax_type AS type, amount::double precision AS amount, due_on::text AS "dueOn", status
        FROM pos.tax_payment WHERE store_id = $1 AND type_key = $2 AND amount = $3 AND due_on = $4 AND deleted_at IS NULL
        ORDER BY created_at, tax_payment_id LIMIT 1
      `, [tx.storeId, typeKey, value, dueOn]);
      if (same) throw new PosError(409, 'TAX_PAYMENT_EXISTS', same);
    }
    const taxPaymentId = randomUUID();
    await tx.db.query(`
      INSERT INTO pos.tax_payment (store_id, tax_payment_id, tax_type, type_key, amount, due_on, status, revision,
        created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'unpaid', 1, $7, $8, $8)
    `, [tx.storeId, taxPaymentId, type, typeKey, value, dueOn, tx.actorId, tx.at]);
    return committed(tx, taxPaymentId, null);
  });
}

export function updatePayment(tx: FinanceTx, key: string, taxPaymentId: string, body: unknown) {
  const input = object(body, ['type', 'amount', 'dueOn', 'paidOn', 'status', 'expectedRevision']);
  const expectedRevision = revisionInput(input.expectedRevision);
  const patch: { type?: string; typeKey?: string; amount?: number; dueOn?: string; paidOn?: string | null; status?: TaxStatus } = {};
  if (input.type !== undefined) ({ type: patch.type, key: patch.typeKey } = taxType(input.type));
  if (input.amount !== undefined) patch.amount = amount(input.amount);
  if (input.dueOn !== undefined) patch.dueOn = day(input.dueOn);
  if (input.paidOn !== undefined) patch.paidOn = input.paidOn === null ? null : day(input.paidOn);
  if (input.status !== undefined) {
    if (input.status !== 'paid' && input.status !== 'unpaid') throw new PosError(400, 'STATUS_INVALID');
    patch.status = input.status;
  }
  if (!Object.keys(patch).length) throw new PosError(400, 'INVALID_REQUEST');
  return applyCommand(tx, 'tax.payment.update', key, { taxPaymentId, patch, expectedRevision }, async () => {
    const row = await readPayment(tx, taxPaymentId);
    if (row.revision !== expectedRevision) throw stale(row);
    const before = image(row);
    const status = patch.status ?? row.status;
    // An unpaid record has no payment date; a paid record needs the date the owner paid.
    if (status === 'unpaid' && patch.paidOn) throw new PosError(400, 'DATE_INVALID');
    const paidOn = status === 'unpaid' ? null : patch.paidOn !== undefined ? patch.paidOn : row.paidOn;
    if (status === 'paid' && !paidOn) throw new PosError(400, 'DATE_INVALID');
    if (paidOn && paidOn !== row.paidOn) await paidDay(tx, paidOn);
    const keepRecord = status === 'paid' && row.status === 'paid';
    const next: PaymentImage = {
      ...before, type: patch.type ?? row.type, typeKey: patch.typeKey ?? row.typeKey, amount: patch.amount ?? row.amount,
      dueOn: patch.dueOn ?? row.dueOn, status, paidOn,
      paidRecordedAt: status === 'unpaid' ? null : keepRecord ? before.paidRecordedAt : tx.at.toISOString(),
      paidRecordedBy: status === 'unpaid' ? null : keepRecord ? before.paidRecordedBy : tx.actorId,
    };
    if (next.type === before.type && next.amount === before.amount && next.dueOn === before.dueOn
      && next.status === before.status && next.paidOn === before.paidOn) return unchanged(tx, row);
    await save(tx, taxPaymentId, next, row.revision + 1);
    return committed(tx, taxPaymentId, before);
  });
}

/** `tax.markPaid`: the owner records a payment made at Hometax or the bank. Navis never pays or checks payment status. */
export function markPaid(tx: FinanceTx, key: string, taxPaymentId: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'paidOn']);
  const expectedRevision = revisionInput(input.expectedRevision);
  const requested = input.paidOn === undefined ? null : day(input.paidOn);
  return applyCommand(tx, 'tax.payment.paid', key, { taxPaymentId, expectedRevision, paidOn: requested }, async () => {
    const row = await readPayment(tx, taxPaymentId);
    if (row.revision !== expectedRevision) throw stale(row);
    if (row.status === 'paid') return unchanged(tx, row);
    const paidOn = await paidDay(tx, requested ?? await currentDay(tx));
    const before = image(row);
    await save(tx, taxPaymentId, { ...before, status: 'paid', paidOn, paidRecordedAt: tx.at.toISOString(),
      paidRecordedBy: tx.actorId }, row.revision + 1);
    return committed(tx, taxPaymentId, before);
  });
}

export function deletePayment(tx: FinanceTx, key: string, taxPaymentId: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'confirmed']);
  const expectedRevision = revisionInput(input.expectedRevision);
  confirmed(input.confirmed);
  return applyCommand(tx, 'tax.payment.delete', key, { taxPaymentId, expectedRevision }, async () => {
    const row = await readPayment(tx, taxPaymentId);
    if (row.revision !== expectedRevision) throw stale(row);
    const before = image(row);
    await save(tx, taxPaymentId, { ...before, deletedAt: tx.at.toISOString(), deletedBy: tx.actorId }, row.revision + 1);
    return committed(tx, taxPaymentId, before);
  });
}

async function evidenceTarget(tx: FinanceTx, taxPaymentId: string, fileId: string, expectedRevision: number) {
  const row = await readPayment(tx, taxPaymentId);
  if (row.revision !== expectedRevision) throw stale(row);
  const alreadyAttached = row.evidenceFiles.some(file => file.fileId === fileId);
  if (!alreadyAttached && row.evidenceFiles.length >= maxEvidenceFiles) {
    throw new PosError(409, 'EVIDENCE_LIMIT', { max: maxEvidenceFiles });
  }
  return { row, alreadyAttached };
}

/** Verify the completed Account file after releasing the read transaction. */
export async function prepareAttachEvidence(scope: PosPreflight, key: string, taxPaymentId: string, body: unknown, verify?: VerifyTaxEvidence) {
  const input = object(body, ['fileId', 'expectedRevision']);
  const fileId = uuid(input.fileId);
  const expectedRevision = revisionInput(input.expectedRevision);
  const needsVerification = await scope.read(async tx => {
    if (await readCommand(tx, 'tax.evidence.attach', key)) return false;
    return !(await evidenceTarget(tx, taxPaymentId, fileId, expectedRevision)).alreadyAttached;
  });
  let file: TaxEvidenceFile | null = null;
  if (needsVerification) {
    if (!verify) throw new PosError(503, 'EVIDENCE_VERIFIER_UNAVAILABLE');
    try {
      file = await verify({ storeId: scope.storeId, actorId: scope.actorId, fileId });
    } catch {
      throw new PosError(503, 'EVIDENCE_VERIFIER_UNAVAILABLE');
    }
    if (!file || file.fileId !== fileId) throw new PosError(404, 'EVIDENCE_FILE_NOT_FOUND');
  }
  return (tx: FinanceTx) => applyCommand(tx, 'tax.evidence.attach', key, { taxPaymentId, fileId, expectedRevision }, async () => {
    const { row, alreadyAttached } = await evidenceTarget(tx, taxPaymentId, fileId, expectedRevision);
    if (alreadyAttached) return unchanged(tx, row);
    if (!file) throw new PosError(503, 'EVIDENCE_VERIFIER_UNAVAILABLE');
    const before = image(row);
    await tx.db.query(`
      INSERT INTO pos.tax_evidence (store_id, tax_payment_id, file_id, content_type, size, sha256, attached_by, attached_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (store_id, tax_payment_id, file_id) DO UPDATE SET content_type = EXCLUDED.content_type,
        size = EXCLUDED.size, sha256 = EXCLUDED.sha256, attached_by = EXCLUDED.attached_by,
        attached_at = EXCLUDED.attached_at, detached_at = NULL, detached_by = NULL
    `, [tx.storeId, taxPaymentId, fileId, file.contentType, file.size, file.sha256, tx.actorId, tx.at]);
    await bump(tx, taxPaymentId, row.revision + 1);
    return committed(tx, taxPaymentId, before);
  });
}

/** Detaching keeps the Account file. The owner deletes the file itself through the Account file API. */
export function detachEvidence(tx: FinanceTx, key: string, taxPaymentId: string, fileId: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'confirmed']);
  const expectedRevision = revisionInput(input.expectedRevision);
  confirmed(input.confirmed);
  return applyCommand(tx, 'tax.evidence.detach', key, { taxPaymentId, fileId, expectedRevision }, async () => {
    const row = await readPayment(tx, taxPaymentId);
    if (row.revision !== expectedRevision) throw stale(row);
    if (!row.evidenceFiles.some(file => file.fileId === fileId)) throw new PosError(404, 'EVIDENCE_NOT_ATTACHED');
    const before = image(row);
    await tx.db.query(`
      UPDATE pos.tax_evidence SET detached_at = $4, detached_by = $5
      WHERE store_id = $1 AND tax_payment_id = $2 AND file_id = $3 AND detached_at IS NULL
    `, [tx.storeId, taxPaymentId, fileId, tx.at, tx.actorId]);
    await bump(tx, taxPaymentId, row.revision + 1);
    return committed(tx, taxPaymentId, before);
  });
}

/** Undo: restore the recorded image, or withdraw a created record. Called only after the receipt checks pass. */
export async function restorePayment(tx: FinanceTx, taxPaymentId: string, revision: number, before: PaymentImage | null) {
  const row = await readPayment(tx, taxPaymentId, true);
  if (row.revision !== revision) throw new PosError(409, 'UNDO_UNAVAILABLE');
  const next = before ?? { ...image(row), deletedAt: tx.at.toISOString(), deletedBy: tx.actorId };
  await save(tx, taxPaymentId, next, row.revision + 1);
  if (before) {
    await tx.db.query(`
      UPDATE pos.tax_evidence SET
        detached_at = CASE WHEN file_id = ANY($3::uuid[]) THEN NULL ELSE coalesce(detached_at, $4) END,
        detached_by = CASE WHEN file_id = ANY($3::uuid[]) THEN NULL ELSE coalesce(detached_by, $5) END
      WHERE store_id = $1 AND tax_payment_id = $2
    `, [tx.storeId, taxPaymentId, before.evidenceFileIds, tx.at, tx.actorId]);
  }
  const restored = await readPayment(tx, taxPaymentId, true);
  await dueEvent(tx, restored);
  return restored.revision;
}

function optionalDay(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new PosError(400, 'INVALID_PERIOD');
  return day(value);
}

export async function paymentDetail(tx: FinanceTx, taxPaymentId: string) {
  const row = await readPayment(tx, taxPaymentId);
  return { ...paymentDto(row, await currentDay(tx)), asOf: tx.at.toISOString(), sourceRevision: row.revision };
}

type Summary = { unpaidCount: string; unpaidTotal: string; overdueCount: string; dueSoonCount: string; paidCount: string; withEvidenceCount: string };

/**
 * Newest due date first (the grid default). `next` is the earliest unpaid record in due order (date, amount, ID),
 * the same rule as `selectNextTaxPayment`. `summary.dueSoonCount` counts unpaid records due within 30 days, including overdue ones.
 */
export async function listPayments(tx: FinanceTx, value: unknown) {
  const input = query(value, ['status', 'dueFrom', 'dueTo', 'cursor', 'limit']);
  if (input.status !== undefined && input.status !== 'paid' && input.status !== 'unpaid') throw new PosError(400, 'INVALID_STATUS');
  const status = (input.status ?? null) as TaxStatus | null;
  let dueFrom: string | null, dueTo: string | null;
  try {
    dueFrom = optionalDay(input.dueFrom);
    dueTo = optionalDay(input.dueTo);
  } catch {
    throw new PosError(400, 'INVALID_PERIOD');
  }
  if (dueFrom && dueTo && dueFrom > dueTo) throw new PosError(400, 'INVALID_PERIOD');
  const limit = limitInput(input.limit);
  const cursor = cursorInput(input.cursor);
  const today = await currentDay(tx);
  const { rows } = await tx.db.query<PaymentDb>(`
    SELECT ${columns} FROM pos.tax_payment p
    WHERE p.store_id = $1 AND p.deleted_at IS NULL AND ($2::text IS NULL OR p.status = $2)
      AND ($3::date IS NULL OR p.due_on >= $3) AND ($4::date IS NULL OR p.due_on <= $4)
      AND ($5::uuid IS NULL OR (p.due_on, p.tax_payment_id) < (
        SELECT due_on, tax_payment_id FROM pos.tax_payment WHERE store_id = $1 AND tax_payment_id = $5))
    ORDER BY p.due_on DESC, p.tax_payment_id DESC LIMIT $6
  `, [tx.storeId, status, dueFrom, dueTo, cursor, limit + 1]);
  const page = rows.slice(0, limit).map(row => paymentDto(row, today));
  const nextCursor = rows.length > limit ? page[limit - 1].taxPaymentId : null;
  const { rows: [nextRow] } = await tx.db.query<PaymentDb>(`
    SELECT ${columns} FROM pos.tax_payment p WHERE p.store_id = $1 AND p.deleted_at IS NULL AND p.status = 'unpaid'
    ORDER BY p.due_on, p.amount, p.tax_payment_id LIMIT 1
  `, [tx.storeId]);
  const { rows: [counts] } = await tx.db.query<Summary>(`
    SELECT count(*) FILTER (WHERE status = 'unpaid') AS "unpaidCount",
      coalesce(sum(amount) FILTER (WHERE status = 'unpaid'), 0) AS "unpaidTotal",
      count(*) FILTER (WHERE status = 'unpaid' AND due_on < $2) AS "overdueCount",
      count(*) FILTER (WHERE status = 'unpaid' AND due_on <= $3) AS "dueSoonCount",
      count(*) FILTER (WHERE status = 'paid') AS "paidCount",
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pos.tax_evidence e WHERE e.store_id = p.store_id
        AND e.tax_payment_id = p.tax_payment_id AND e.detached_at IS NULL)) AS "withEvidenceCount"
    FROM pos.tax_payment p WHERE store_id = $1 AND deleted_at IS NULL
  `, [tx.storeId, today, addDays(today, 30)]);
  const summary = {
    unpaidCount: money(counts.unpaidCount), unpaidTotal: money(counts.unpaidTotal), overdueCount: money(counts.overdueCount),
    dueSoonCount: money(counts.dueSoonCount), paidCount: money(counts.paidCount), withEvidenceCount: money(counts.withEvidenceCount),
  };
  const next = nextRow ? paymentDto(nextRow, today) : null;
  return { items: page, nextCursor, next, summary, today, asOf: tx.at.toISOString(),
    sourceRevision: contentRevision({ items: page, nextCursor, next, summary }) };
}
