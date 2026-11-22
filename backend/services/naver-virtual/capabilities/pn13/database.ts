import type { PoolClient } from 'pg';
import type { SensProduct } from '../../../../packages/naver/contracts/pn13/index.ts';
import { PERSONA_MAINTENANCE_LOCK } from '../../db.ts';

export type Data = Record<string, unknown>;
export type RequestRow = {
  request_id: string;
  accepted_at: Date;
  scheduled_at: Date | null;
  payload: Data;
};
export type MessageRow = RequestRow & { message_id: string; message: Data };

export const sensReservationMigration = {
  id: '20261122001301_sens_reservation',
  up: `ALTER TABLE naver_virtual.sens_requests ADD COLUMN canceled_at timestamptz;
    GRANT UPDATE (canceled_at) ON naver_virtual.sens_requests TO nvirtual_run;`,
  down: 'ALTER TABLE naver_virtual.sens_requests DROP COLUMN canceled_at;',
};

export const sensMigration = {
  id: '20261122001300_sens',
  up: `
    CREATE TABLE naver_virtual.sens_requests (
      account_id text NOT NULL,
      product text NOT NULL CHECK (product IN ('sms', 'alimtalk', 'brandmessage', 'mail')),
      service_id text NOT NULL,
      request_id text NOT NULL,
      accepted_at timestamptz NOT NULL,
      scheduled_at timestamptz,
      payload jsonb NOT NULL,
      PRIMARY KEY (account_id, product, service_id, request_id)
    );
    CREATE INDEX sens_requests_accepted_idx ON naver_virtual.sens_requests
      (account_id, product, service_id, accepted_at, request_id);
    CREATE TABLE naver_virtual.sens_messages (
      account_id text NOT NULL,
      product text NOT NULL,
      service_id text NOT NULL,
      request_id text NOT NULL,
      message_id text NOT NULL,
      message jsonb NOT NULL,
      PRIMARY KEY (account_id, product, service_id, message_id),
      FOREIGN KEY (account_id, product, service_id, request_id)
        REFERENCES naver_virtual.sens_requests ON DELETE CASCADE
    );
    CREATE INDEX sens_messages_request_idx ON naver_virtual.sens_messages
      (account_id, product, service_id, request_id, message_id);
    ALTER TABLE naver_virtual.sens_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE naver_virtual.sens_requests FORCE ROW LEVEL SECURITY;
    ALTER TABLE naver_virtual.sens_messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE naver_virtual.sens_messages FORCE ROW LEVEL SECURITY;
    CREATE POLICY sens_request_scope ON naver_virtual.sens_requests
      USING (account_id = current_setting('app.persona_account_id', true))
      WITH CHECK (account_id = current_setting('app.persona_account_id', true));
    CREATE POLICY sens_message_scope ON naver_virtual.sens_messages
      USING (account_id = current_setting('app.persona_account_id', true))
      WITH CHECK (account_id = current_setting('app.persona_account_id', true));
    GRANT SELECT, INSERT ON naver_virtual.sens_requests, naver_virtual.sens_messages TO nvirtual_run;
  `,
  down: `DROP TABLE naver_virtual.sens_messages; DROP TABLE naver_virtual.sens_requests;`,
};

type Scope = [accountId: string, product: SensProduct, serviceId: string];

export async function store(client: PoolClient, scope: Scope, request: RequestRow, messages: { id: string; data: Data }[]) {
  await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [PERSONA_MAINTENANCE_LOCK]);
  await client.query(`INSERT INTO naver_virtual.sens_requests
      (account_id, product, service_id, request_id, accepted_at, scheduled_at, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [...scope, request.request_id, request.accepted_at, request.scheduled_at, request.payload]);
  await client.query(`INSERT INTO naver_virtual.sens_messages
      (account_id, product, service_id, request_id, message_id, message)
      SELECT $1, $2, $3, $4, id, data FROM jsonb_to_recordset($5::jsonb) AS messages(id text, data jsonb)`,
  [...scope, request.request_id, JSON.stringify(messages)]);
}

export async function requests(client: PoolClient, scope: Scope, requestId?: string, from?: Date, to?: Date) {
  return (await client.query<RequestRow>(`SELECT request_id, accepted_at, scheduled_at, payload
    FROM naver_virtual.sens_requests
    WHERE account_id = $1 AND product = $2 AND service_id = $3
      AND ($4::text IS NULL OR request_id = $4)
      AND ($5::timestamptz IS NULL OR accepted_at >= $5)
      AND ($6::timestamptz IS NULL OR accepted_at <= $6)
    ORDER BY accepted_at DESC, request_id`, [...scope, requestId ?? null, from ?? null, to ?? null])).rows;
}

export async function messages(client: PoolClient, scope: Scope, filter: {
  requestId?: string; messageId?: string; from?: Date; to?: Date; completionTime?: boolean;
}) {
  // Both clock expressions are selected by program logic; all caller values are parameters.
  const time = filter.completionTime ? 'COALESCE(request.scheduled_at, request.accepted_at)' : 'request.accepted_at';
  return (await client.query<MessageRow>(`SELECT request.request_id, request.accepted_at, request.scheduled_at, request.payload,
      message.message_id, message.message
    FROM naver_virtual.sens_messages message
    JOIN naver_virtual.sens_requests request USING (account_id, product, service_id, request_id)
    WHERE account_id = $1 AND product = $2 AND service_id = $3
      AND request.canceled_at IS NULL
      AND ($4::text IS NULL OR request_id = $4)
      AND ($5::text IS NULL OR message_id = $5)
      AND ($6::timestamptz IS NULL OR ${time} >= $6)
      AND ($7::timestamptz IS NULL OR ${time} <= $7)
    ORDER BY request.accepted_at DESC, request.request_id, message.message_id`,
  [...scope, filter.requestId ?? null, filter.messageId ?? null, filter.from ?? null, filter.to ?? null])).rows;
}


export async function reservation(client: PoolClient, scope: Scope, id: string) {
  const { rows: [row] } = await client.query<{ scheduled_at: Date; canceled_at: Date | null }>(
    `SELECT scheduled_at, canceled_at FROM naver_virtual.sens_requests
     WHERE account_id=$1 AND product=$2 AND service_id=$3 AND request_id=$4 AND scheduled_at IS NOT NULL`,
    [...scope, id]);
  return row;
}

export async function cancelReservation(client: PoolClient, scope: Scope, id: string, now: Date) {
  const { rowCount } = await client.query(
    `UPDATE naver_virtual.sens_requests SET canceled_at=$5
     WHERE account_id=$1 AND product=$2 AND service_id=$3 AND request_id=$4
       AND scheduled_at>$5 AND canceled_at IS NULL`, [...scope, id, now]);
  return Boolean(rowCount);
}
