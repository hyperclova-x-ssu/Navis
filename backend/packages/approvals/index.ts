import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export class ApprovalError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export const cardLifetimeMs = 60_000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Input = {
  stage: 'press' | 'confirm'; operation: string; targetRef?: string;
  expectedRevision: number; command: Record<string, unknown>; approvalId?: string;
};
type Binding = { storeId: string; actorId: string; operation: string; targetRef?: string;
  expectedRevision: number; fingerprint: string; requiresConfirmation: boolean };

export function approvalInput(raw: unknown): Input {
  const input = raw as Partial<Input> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['stage', 'operation', 'targetRef', 'expectedRevision', 'command', 'approvalId'].includes(key))
    || typeof input.operation !== 'string' || !/^[a-zA-Z.]{1,64}$/.test(input.operation)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 0 || input.expectedRevision! > 2147483647
    || !input.command || typeof input.command !== 'object' || Array.isArray(input.command)
    || (input.targetRef !== undefined && (typeof input.targetRef !== 'string' || !input.targetRef || input.targetRef.length > 256))
    || (input.stage === 'press' ? input.approvalId !== undefined : input.stage !== 'confirm'
      || typeof input.approvalId !== 'string' || !uuid.test(input.approvalId))) {
    throw new ApprovalError(400, 'INVALID_REQUEST');
  }
  return input as Input;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function approvalFingerprint(command: unknown) {
  return createHash('sha256').update(JSON.stringify(canonical(command))).digest('hex');
}

export function approvalTableDefinition(service: 'customer' | 'marketing' | 'inventory') {
  const table = service + '.card_approval';
  return `CREATE TABLE ${table} (
    store_id uuid NOT NULL, approval_id uuid NOT NULL, actor_id uuid NOT NULL,
    operation text NOT NULL, target_ref text, revision integer NOT NULL CHECK (revision >= 0),
    fingerprint text NOT NULL, expires_at timestamptz NOT NULL, confirmed_at timestamptz, consumed_at timestamptz,
    requires_confirmation boolean NOT NULL,
    PRIMARY KEY (store_id, approval_id)
);
CREATE INDEX card_approval_expiry ON ${table} (store_id, expires_at);
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON ${table} TO ${service}_mig, ${service}_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT, DELETE ON ${table} TO ${service}_run;
GRANT UPDATE (confirmed_at, consumed_at) ON ${table} TO ${service}_run;`;
}

export function cardApprovals(service: 'customer' | 'marketing' | 'inventory') {
  const table = service + '.card_approval';
  const exact = `store_id=$1 AND approval_id=$2 AND actor_id=$3 AND operation=$4 AND target_ref IS NOT DISTINCT FROM $5
    AND revision=$6 AND fingerprint=$7 AND requires_confirmation=$8`;
  const eligible = exact + ' AND expires_at>$9 AND consumed_at IS NULL';
  const ready = eligible + ' AND (NOT requires_confirmation OR confirmed_at IS NOT NULL)';
  const values = (binding: Binding, id: string, at: Date) => [binding.storeId, id, binding.actorId,
    binding.operation, binding.targetRef ?? null, binding.expectedRevision, binding.fingerprint, binding.requiresConfirmation, at];

  async function expire(db: PoolClient, storeId: string, at: Date) {
    await db.query(`DELETE FROM ${table} WHERE store_id=$1 AND expires_at<=$2`, [storeId, at]);
  }
  return {
    expire,
    async issue(db: PoolClient, input: Input, binding: Binding, at: Date) {
      if (input.stage === 'confirm') {
        if (!binding.requiresConfirmation) throw new ApprovalError(403, 'CARD_REQUIRED');
        const { rows: [row] } = await db.query<{ expiresAt: Date }>(`
          UPDATE ${table} SET confirmed_at=coalesce(confirmed_at, $9)
          WHERE ${eligible} RETURNING expires_at AS "expiresAt"`, values(binding, input.approvalId!, at));
        if (!row) throw new ApprovalError(403, 'CARD_REQUIRED');
        return { approvalId: input.approvalId!, expiresAt: row.expiresAt, requiresConfirmation: false };
      }
      await expire(db, binding.storeId, at);
      const approvalId = randomUUID();
      const expiresAt = new Date(+at + cardLifetimeMs);
      await db.query(`INSERT INTO ${table}
        (store_id, approval_id, actor_id, operation, target_ref, revision, fingerprint, requires_confirmation, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, values(binding, approvalId, expiresAt));
      return { approvalId, expiresAt, requiresConfirmation: binding.requiresConfirmation };
    },
    async verify(db: PoolClient, binding: Binding, id: string, at: Date) {
      return Boolean((await db.query(`SELECT 1 FROM ${table} WHERE ${ready}`, values(binding, id, at))).rowCount);
    },
    async consume(db: PoolClient, binding: Binding, id: string, at: Date) {
      return Boolean((await db.query(`UPDATE ${table} SET consumed_at=$9 WHERE ${ready}`, values(binding, id, at))).rowCount);
    },
  };
}
