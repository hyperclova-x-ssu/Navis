import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FastifyReply } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import { calendarDate, record } from '../../../../packages/naver/contracts/pn01/wire.ts';
import { bookingRefundRequired, bookingStatuses, partnerPath, validBookingRefund } from '../../../../packages/naver/contracts/pn02/wire.ts';
import type { BookingCancel, Booking, BookingProduct, BookingStatus, Order, OrderStatus } from '../../../../packages/naver/contracts/pn02/wire.ts';
import { bookingCanChange, bookingStatusAfter, orderStatusAfter, parseUsageAt } from './rules.ts';

const scope = "(SELECT current_setting('app.persona_account_id', true))";
const tables = ['pn02_booking', 'pn02_order', 'pn02_booking_product'];
const migration = {
  id: 'pn02_001_bookings_orders',
  up: `
  CREATE TABLE naver_virtual.pn02_booking (
    account_id text NOT NULL, generation text NOT NULL, ref text NOT NULL, product text NOT NULL,
    usage_at timestamptz NOT NULL, masked_name text, masked_phone text,
    lookup_name text, lookup_phone text,
    status text NOT NULL CHECK (status IN ('requested','confirmed','cancelled','completed','no-show')),
    npay_linked boolean NOT NULL, paid boolean NOT NULL DEFAULT false,
    after_use_eligible boolean NOT NULL DEFAULT false, payment_requested_at timestamptz, refund_requested_at timestamptz,
    PRIMARY KEY(account_id, ref)
  );
  CREATE INDEX pn02_booking_usage ON naver_virtual.pn02_booking(account_id,usage_at,ref);
  CREATE TABLE naver_virtual.pn02_order (
    account_id text NOT NULL, generation text NOT NULL, ref text NOT NULL,
    preparation_minutes integer CHECK (preparation_minutes > 0),
    status text NOT NULL CHECK (status IN ('received','preparing','picked-up')),
    PRIMARY KEY(account_id, ref)
  );
  CREATE TABLE naver_virtual.pn02_booking_product (
    account_id text PRIMARY KEY, generation text NOT NULL, projection jsonb NOT NULL
  );
  ${tables.map(table => `
    ALTER TABLE naver_virtual.${table} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY pn02_account ON naver_virtual.${table} USING (account_id=${scope}) WITH CHECK (account_id=${scope});
    GRANT SELECT${table === 'pn02_booking_product' ? '' : ', UPDATE'} ON naver_virtual.${table} TO nvirtual_run;
  `).join('')}
  `,
  down: 'DROP TABLE naver_virtual.pn02_booking_product, naver_virtual.pn02_order, naver_virtual.pn02_booking;',
};

interface BookingRow {
  ref: string; product: string; usage_at: Date; masked_name: string | null; masked_phone: string | null;
  status: BookingStatus; npay_linked: boolean; payment_amount: number | null;
}
interface OrderRow { ref: string; preparation_minutes: number | null; status: OrderStatus }

const seoul = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' });
const hash = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const cancellation = {
  id: 'pn02_002_cancellation_terms',
  up: 'ALTER TABLE naver_virtual.pn02_booking ADD COLUMN cancel_reason text, ADD COLUMN refund_condition jsonb',
  down: 'ALTER TABLE naver_virtual.pn02_booking DROP COLUMN cancel_reason, DROP COLUMN refund_condition',
};

const paymentProjection = {
  id: 'pn02_003_payment_projection',
  up: `
    ALTER TABLE naver_virtual.pn02_booking ADD COLUMN payment_amount integer;
    -- Both existing Npay fixtures use the synthetic product price.
    UPDATE naver_virtual.pn02_booking SET payment_amount = 4500 WHERE npay_linked;
    ALTER TABLE naver_virtual.pn02_booking
      ADD CONSTRAINT pn02_payment_amount CHECK (
        (npay_linked AND payment_amount IS NOT NULL AND payment_amount >= 0)
        OR (NOT npay_linked AND payment_amount IS NULL)
      ),
      DROP COLUMN paid, DROP COLUMN after_use_eligible, DROP COLUMN payment_requested_at;
  `,
  down: `
    ALTER TABLE naver_virtual.pn02_booking DROP CONSTRAINT pn02_payment_amount,
      ADD COLUMN paid boolean NOT NULL DEFAULT false,
      ADD COLUMN after_use_eligible boolean NOT NULL DEFAULT false,
      ADD COLUMN payment_requested_at timestamptz;
    UPDATE naver_virtual.pn02_booking SET paid = npay_linked AND status IN ('confirmed', 'cancelled');
    ALTER TABLE naver_virtual.pn02_booking DROP COLUMN payment_amount;
  `,
};

function parseCancellation(body: unknown): BookingCancel | undefined {
  if (!record(body) || Object.keys(body).some(key => key !== 'cancelReason' && key !== 'refund') ||
      typeof body.cancelReason !== 'string' || !body.cancelReason.trim() || body.cancelReason.includes('\0')) return;
  const cancelReason = body.cancelReason.trim();
  const { refund } = body;
  if (refund === undefined) return { cancelReason };
  if (!validBookingRefund(refund, Number.MAX_SAFE_INTEGER)) return;
  // Canonical key order keeps equivalent retry payloads on the same fingerprint.
  return { cancelReason, refund: refund.type === 'full' ? { type: refund.type } : { type: refund.type, value: refund.value } };
}

const active = (status: BookingStatus) => status === 'requested' || status === 'confirmed';

function projectBooking(row: BookingRow): Booking {
  return {
    bookingNumber: row.ref, product: row.product, usageAt: seoul.format(row.usage_at).replace(' ', 'T') + '+09:00',
    status: row.status, npayLinked: row.npay_linked,
    ...(row.payment_amount !== null && { paymentAmount: row.payment_amount }),
    ...(active(row.status) && row.masked_name ? { maskedName: row.masked_name } : {}),
    ...(active(row.status) && row.masked_phone ? { maskedPhone: row.masked_phone } : {}),
  };
}

function projectOrder(row: OrderRow): Order {
  return { orderNumber: row.ref, status: row.status, preparationMinutes: row.preparation_minutes };
}

async function getBooking(client: PoolClient, accountId: string, ref: string, lock = false): Promise<BookingRow | undefined> {
  const { rows } = await client.query<BookingRow>(`
    SELECT ref,product,usage_at,masked_name,masked_phone,status,npay_linked,payment_amount
    FROM naver_virtual.pn02_booking WHERE account_id=$1 AND ref=$2 ${lock ? 'FOR UPDATE' : ''}
  `, [accountId, ref]);
  return rows[0];
}

async function getOrder(client: PoolClient, accountId: string, ref: string, lock = false): Promise<OrderRow | undefined> {
  const { rows } = await client.query<OrderRow>(`
    SELECT ref,preparation_minutes,status FROM naver_virtual.pn02_order WHERE account_id=$1 AND ref=$2 ${lock ? 'FOR UPDATE' : ''}
  `, [accountId, ref]);
  return rows[0];
}

class FulfillmentProblem extends Error {
  readonly statusCode: 400 | 404 | 409;
  readonly code: string;

  constructor(statusCode: 400 | 404 | 409, code: string) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function problem(statusCode: 400 | 404 | 409, code: string): never {
  throw new FulfillmentProblem(statusCode, code);
}

function fulfillmentError(error: unknown, _request: unknown, reply: FastifyReply) {
  if (!(error instanceof FulfillmentProblem)) throw error;
  return reply.code(error.statusCode).send({ code: error.code });
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ code: 'INVALID_REQUEST' });
}

function empty(value: unknown, optional = false) {
  return (optional && value === undefined) || (record(value) && Object.keys(value).length === 0);
}

function selector(params: unknown): string | undefined {
  return record(params) && typeof params.ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(params.ref) ? params.ref : undefined;
}

const bookingQueryFields = ['bookingNumber', 'name', 'phone', 'date', 'status'];

export const personaCapability: PersonaCapability = {
  id: 'pn02', migrations: [migration, cancellation, paymentProjection],
  async seed(client, { accountId, generation, cafe }) {
    for (const table of tables) await client.query(`DELETE FROM naver_virtual.${table} WHERE account_id=$1 AND generation<>$2`, [accountId, generation]);
    const product: BookingProduct = { name: '매장 방문' };
    await client.query('INSERT INTO naver_virtual.pn02_booking_product VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [accountId, generation, JSON.stringify([product])]);
    const today = new Date(cafe.businessDate + 'T00:00:00Z');
    const tomorrow = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
    const fixtures = [
      ['booking-01', tomorrow + 'T12:00:00+09:00', 'requested', false, null],
      ['booking-02', tomorrow + 'T13:00:00+09:00', 'confirmed', true, 4500],
      ['booking-03', tomorrow + 'T14:00:00+09:00', 'confirmed', false, null],
      ['booking-04', cafe.businessDate + 'T10:00:00+09:00', 'completed', true, 4500],
      ['booking-05', cafe.businessDate + 'T10:30:00+09:00', 'no-show', false, null],
      ['booking-06', cafe.businessDate + 'T11:00:00+09:00', 'cancelled', false, null],
    ] as const;
    for (const [index, [ref, usage, status, npay, amount]] of fixtures.entries()) {
      const canFulfill = active(status);
      const suffix = String(index + 1).padStart(4, '0');
      await client.query(`
        INSERT INTO naver_virtual.pn02_booking(account_id,generation,ref,product,usage_at,status,npay_linked,payment_amount,
          masked_name,masked_phone,lookup_name,lookup_phone)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING
      `, [accountId, generation, ref, product.name, usage, status, npay, amount,
        canFulfill ? '카**' : null, canFulfill ? '010-****-' + suffix : null,
        canFulfill ? hash([accountId, '카페손님' + (index + 1)]) : null,
        canFulfill ? hash([accountId, '0100000' + suffix]) : null]);
    }
    await client.query(`
      INSERT INTO naver_virtual.pn02_order(account_id,generation,ref,preparation_minutes,status)
      VALUES($1,$2,'order-01',NULL,'received'),($1,$2,'order-02',7,'preparing') ON CONFLICT DO NOTHING
    `, [accountId, generation]);
  },
  register(app, context) {
    // https://help.naver.com/service/11712/contents/7579?lang=ko
    // https://help.naver.com/service/30026/contents/20636?lang=ko (booking data purpose)
    app.get(partnerPath + '/bookings', { config: { personaOperation: 'pn02.bookings.list' } }, async (request, reply) => {
      const query = request.query;
      if (!record(query) || Object.entries(query).some(([key, value]) => !bookingQueryFields.includes(key)
        || typeof value !== 'string' || !value.trim() || value.length > 100)) return invalid(reply);
      const { bookingNumber, name, phone, date, status } = query as Record<string, string | undefined>;
      if ((date !== undefined && !calendarDate(date)) || (status !== undefined && !bookingStatuses.some(value => value === status))
        || (phone !== undefined && !/^\d{8,15}$/.test(phone.replaceAll('-', '')))) return invalid(reply);
      const accountId = context.accountId(request);
      return context.transaction(request, async client => {
        const { rows } = await client.query<BookingRow>(`
          SELECT ref,product,usage_at,masked_name,masked_phone,status,npay_linked,payment_amount FROM naver_virtual.pn02_booking WHERE account_id=$1
          AND ($2::text IS NULL OR ref=$2) AND ($3::text IS NULL OR status=$3)
          AND ($4::date IS NULL OR (usage_at AT TIME ZONE 'Asia/Seoul')::date=$4)
          AND ($5::text IS NULL OR (status IN ('requested','confirmed') AND lookup_name=$5))
          AND ($6::text IS NULL OR (status IN ('requested','confirmed') AND lookup_phone=$6))
          ORDER BY usage_at,ref LIMIT 5000
        `, [accountId, bookingNumber ?? null, status ?? null, date ?? null,
          name ? hash([accountId, name.normalize('NFC').trim()]) : null,
          phone ? hash([accountId, phone.replaceAll('-', '')]) : null]);
        return rows.map(projectBooking);
      });
    });
    // https://help.naver.com/service/30026/contents/20628?lang=ko&osType=COMMONOS
    app.get(partnerPath + '/bookings/:ref', { config: { personaOperation: 'pn02.bookings.read' } }, async (request, reply) => {
      const ref = selector(request.params);
      if (!ref || !empty(request.query)) return invalid(reply);
      const row = await context.transaction(request, client => getBooking(client, context.accountId(request), ref));
      return row ? projectBooking(row) : reply.code(404).send({ code: 'NOT_FOUND' });
    });

    // Change: https://help.naver.com/service/11712/contents/7581?lang=ko
    // Confirm: https://help.naver.com/service/30026/contents/20630?lang=ko&osType=COMMONOS
    // Cancel: https://help.naver.com/service/30026/contents/20659?lang=ko&osType=COMMONOS
    // Paid owner cancel and refund: https://help.naver.com/service/11712/contents/18720?lang=ko&osType=COMMONOS
    for (const action of ['change', 'confirm', 'cancel'] as const) {
      app.route({
        method: action === 'change' ? 'PATCH' : 'POST', url: partnerPath + '/bookings/:ref' + (action === 'change' ? '' : '/' + action),
        config: { personaOperation: 'pn02.bookings.' + action },
        errorHandler: fulfillmentError,
        async handler(request, reply) {
          const ref = selector(request.params);
          if (!ref || !empty(request.query)) return invalid(reply);
          const patch = record(request.body) ? request.body : {};
          const usage = action === 'change' ? parseUsageAt(patch.usageAt) : null;
          const cancel = action === 'cancel' ? parseCancellation(request.body) : undefined;
          if (action === 'change' ? (!usage || Object.keys(patch).length !== 1) :
              action === 'cancel' ? !cancel : !empty(request.body, true)) return invalid(reply);
          const accountId = context.accountId(request);
          await context.effect(request, hash(cancel ? [ref, action, cancel] : [ref, action, usage]), async client => {
            const row = await getBooking(client, accountId, ref, true);
            if (!row) problem(404, 'NOT_FOUND');
            const now = context.now();
            if (action === 'change') {
              if (row.npay_linked) problem(409, 'CONFLICT');
              if (!bookingCanChange(row.status, false, String(patch.usageAt), now)) {
                problem(409, 'CONFLICT');
              }
              await client.query('UPDATE naver_virtual.pn02_booking SET usage_at=$3 WHERE account_id=$1 AND ref=$2', [accountId, ref, usage]);
            } else {
              const status = bookingStatusAfter(row.status, action, row.npay_linked);
              if (!status || (action === 'confirm' && row.usage_at <= now)) problem(409, 'CONFLICT');
              const needsRefund = bookingRefundRequired({ status: row.status, npayLinked: row.npay_linked });
              if (cancel && (Boolean(cancel.refund) !== needsRefund
                || (cancel.refund && !validBookingRefund(cancel.refund, row.payment_amount ?? undefined)))) problem(400, 'INVALID_REQUEST');
              await client.query(`
                UPDATE naver_virtual.pn02_booking SET status=$3,
                  cancel_reason=COALESCE($4, cancel_reason),
                  refund_condition=COALESCE($5, refund_condition),
                  masked_name=CASE WHEN $3='cancelled' THEN NULL ELSE masked_name END,
                  masked_phone=CASE WHEN $3='cancelled' THEN NULL ELSE masked_phone END,
                  lookup_name=CASE WHEN $3='cancelled' THEN NULL ELSE lookup_name END,
                  lookup_phone=CASE WHEN $3='cancelled' THEN NULL ELSE lookup_phone END,
                  refund_requested_at=CASE WHEN $5::jsonb IS NOT NULL THEN $6 ELSE refund_requested_at END
                WHERE account_id=$1 AND ref=$2
              `, [accountId, ref, status, cancel?.cancelReason ?? null, cancel?.refund ?? null, now]);
            }
            return ref;
          });
          const edited = await context.transaction(request, client => getBooking(client, accountId, ref));
          return edited ? projectBooking(edited) : reply.code(404).send({ code: 'NOT_FOUND' });
        },
      });
    }

    // General-type booking and orders: https://help.naver.com/service/11712/contents/17285?lang=ko
    app.get(partnerPath + '/booking-products', { config: { personaOperation: 'pn02.booking-products.list' } }, async (request, reply) => {
      if (!empty(request.query)) return invalid(reply);
      return context.transaction(request, async client => {
        const { rows } = await client.query<{ projection: BookingProduct[] }>(
          'SELECT projection FROM naver_virtual.pn02_booking_product WHERE account_id=$1', [context.accountId(request)]);
        return rows[0]?.projection.map(({ name }) => ({ name })) ?? [];
      });
    });

    // Linked POS order and pickup controls: https://new.smartplace.naver.com/introduction/solution-market/payNPos
    app.get(partnerPath + '/orders', { config: { personaOperation: 'pn02.orders.list' } }, async (request, reply) => {
      if (!empty(request.query)) return invalid(reply);
      return context.transaction(request, async client => {
        const { rows } = await client.query<OrderRow>(
          'SELECT ref,preparation_minutes,status FROM naver_virtual.pn02_order WHERE account_id=$1 ORDER BY ref LIMIT 5000', [context.accountId(request)]);
        return rows.map(projectOrder);
      });
    });
    app.get(partnerPath + '/orders/:ref', { config: { personaOperation: 'pn02.orders.read' } }, async (request, reply) => {
      const ref = selector(request.params);
      if (!ref || !empty(request.query)) return invalid(reply);
      const row = await context.transaction(request, client => getOrder(client, context.accountId(request), ref));
      return row ? projectOrder(row) : reply.code(404).send({ code: 'NOT_FOUND' });
    });
    // Per-order prep time: https://help.naver.com/service/30026/contents/20628?lang=ko&osType=COMMONOS
    for (const action of ['prepare', 'pickup'] as const) {
      app.post(partnerPath + '/orders/:ref/' + action, {
        config: { personaOperation: 'pn02.orders.' + action }, errorHandler: fulfillmentError,
      }, async (request, reply) => {
        const ref = selector(request.params);
        if (!ref || !empty(request.query)) return invalid(reply);
        let minutes: number | null = null;
        if (action === 'prepare') {
          const value = record(request.body) && Object.keys(request.body).length === 1 ? request.body.preparationMinutes : undefined;
          if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2147483647) return invalid(reply);
          minutes = value;
        } else if (!empty(request.body, true)) {
          return invalid(reply);
        }
        const accountId = context.accountId(request);
        await context.effect(request, hash([ref, action, minutes]), async client => {
          const row = await getOrder(client, accountId, ref, true);
          if (!row) problem(404, 'NOT_FOUND');
          const status = orderStatusAfter(row.status, action);
          if (!status) problem(409, 'CONFLICT');
          await client.query(`
            UPDATE naver_virtual.pn02_order SET status=$3,preparation_minutes=COALESCE($4,preparation_minutes) WHERE account_id=$1 AND ref=$2
          `, [accountId, ref, status, minutes]);
          return ref;
        });
        const edited = await context.transaction(request, client => getOrder(client, accountId, ref));
        return edited ? projectOrder(edited) : reply.code(404).send({ code: 'NOT_FOUND' });
      });
    }
  },
};
