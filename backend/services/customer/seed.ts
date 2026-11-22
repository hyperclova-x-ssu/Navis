import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import content from '../../../db/seed/ansungjalbu/content.json' with { type: 'json' };
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import { seedSupplement } from '../../../frontend/src/data/db/generated/supplement.ts';
import { createSeedContext, type SeedContext } from '../../packages/db/seed-context.ts';
import { historyForSeed, insertSeedRows, seedId, seoulSeedTime, shiftSeedDate, type SeedDay } from '../../packages/db/seed-history.ts';
import { demoIdentity } from '../account/identity.ts';
import { customOrderExamples } from '../pos/reality/08/seed.ts';
import { withCustomerStore } from './claims.ts';
import { bumpBookingRevision, upsertBookingCandidate } from './reality/06/records.ts';
import { bumpRevision, lockCalendarStaff } from './reality/07/records.ts';
import { minutes, titleKey } from './reality/07/wire.ts';

type SeedCustomer = { customer_id: string; phone_last4: string; consent_sms: boolean };
type SeedMember = { member_id: string; customer_id: string; member_code: string; joined_on: string };
const closureTitle = '매장 정기 점검 휴무';

export async function seed(pool: Pool, context = createSeedContext()) {
  const { rows, businessDate } = context;
  const { storeId } = demoIdentity;
  const customers = new Map<string, SeedCustomer>(
    (rows.customer as SeedCustomer[]).map(customer => [customer.customer_id, customer]),
  );
  const members = (rows.member_profile as SeedMember[]).map(member => {
    const customer = customers.get(member.customer_id);
    if (!customer) throw new Error('Missing café customer for seeded member');
    return { ...member, phone: '0100000' + customer.phone_last4, consent_sms: customer.consent_sms };
  });
  await withCustomerStore(pool, storeId, async db => {
    await db.query(`
      INSERT INTO customer.member (store_id, member_id, member_code, name, phone, marketing_allowed, created_at)
      SELECT $1, member_id, member_code, '손님 ' || member_code, phone, consent_sms,
        joined_on::timestamp AT TIME ZONE 'Asia/Seoul'
      FROM jsonb_to_recordset($2) AS input(member_id uuid, member_code text, phone text,
        consent_sms boolean, joined_on date)
      ON CONFLICT DO NOTHING
    `, [storeId, JSON.stringify(members)]);
    await seedHistory(db, storeId, context);
    const closure = await db.query(`
      INSERT INTO customer.calendar_event
        (store_id, event_id, kind, category_id, title, title_key, starts_on, closure_kind, closure_ends_on, revision)
      VALUES ($1, 'ca44a795-1e6d-49bd-af4e-f21d2d836a86', 'event', 'store-operations',
        $3, $4, $2::date + 10, 'temporary', $2::date + 10, 1)
      ON CONFLICT DO NOTHING
    `, [storeId, businessDate, closureTitle, titleKey(closureTitle)]);
    if (closure.rowCount) await bumpRevision({ db, storeId }, ['calendar']);
  });
  const tomorrow = new Date(Date.parse(businessDate + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  const receivedAt = new Date(Math.min(Date.parse(context.cutoff), Date.parse(businessDate + 'T10:00:00+09:00')));
  for (const [index, hour] of ['14', '15', '16'].entries()) {
    await upsertBookingCandidate(pool, {
      storeId, dedupeKey: createHash('sha256').update(`cafe-seed:phone-request:${index}`).digest('hex'),
      usageAt: `${tomorrow}T${hour}:00:00+09:00`, partySize: index + 2, contact: `0100000420${index + 1}`,
    }, receivedAt);
  }
}

async function seedHistory(db: PoolClient, storeId: string, context: SeedContext) {
  const { rows, cutoff, businessDate } = context;
  const scope = { db, storeId }, store = { store_id: storeId };
  const sales = historyForSeed(context);
  const seenVisits = new Set<string>();
  await insertSeedRows(db, 'customer.member_visit', 'store_id, settlement_id, member_id, visited_at, reversed_at',
    sales.flatMap(sale => {
      if (!sale.at || !sale.bill.member_id || sale.correction?.kind === 'cancel') return [];
      const dayKey = sale.bill.member_id + ':' + sale.businessDate;
      if (seenVisits.has(dayKey)) return [];
      seenVisits.add(dayKey);
      return [{ ...store, settlement_id: sale.settlementId, member_id: sale.bill.member_id,
        visited_at: sale.at, reversed_at: null }];
    }));

  const offset = (Date.parse(businessDate) - Date.parse('2026-11-17')) / 86_400_000;
  const bookingSales = new Map(sales.filter(sale => sale.bill.reservation_id).map(sale => [sale.bill.reservation_id, sale]));
  const reservations = (rows.reservation as Array<{ reservation_id: string; start_at: string }>)
    .filter(booking => booking.start_at <= cutoff)
    .map(booking => {
      const sale = bookingSales.get(booking.reservation_id)!;
      const status = sale.correction?.kind === 'cancel' ? 'canceled' : sale.at ? 'completed' : 'confirmed';
      return { ...store, ...booking, starts_at: booking.start_at, status,
        first_order_id: status !== 'canceled' ? sale.order.order_id : null,
        first_bill_id: status !== 'canceled' ? sale.bill.bill_id : null };
    });
  // Completed links are kept in the historical POS/customer IDs. The
  // reservation constraint permits first-order bindings only while confirmed.
  const upcoming = seedSupplement.bookings.map(booking => ({
    ...store, reservation_id: seedId(booking.reservationId), status: booking.status,
    starts_at: new Date(`${shiftSeedDate(booking.date, offset)}T${booking.start}:00+09:00`).toISOString(),
    party_size: booking.partySize, source: 'direct', member_id: booking.memberId, request: booking.request,
    table_id: seedCatalog.tables.find(table => table.tableId === booking.tableId)?.dbId,
    assignment_mode: 'auto', capacity_override: false, confirmed_by: 'person',
    first_order_id: null, first_bill_id: null,
  })).filter(booking => booking.starts_at > cutoff);
  await insertSeedRows(db, 'customer.reservation',
    'store_id, reservation_id, starts_at, status, party_size, source, member_id, table_id, assignment_mode, capacity_override, confirmed_by, first_order_id, first_bill_id',
    reservations.map(booking => booking.status === 'confirmed' ? booking : { ...booking, first_order_id: null, first_bill_id: null }));
  await insertSeedRows(db, 'customer.reservation',
    'store_id, reservation_id, starts_at, status, party_size, source, member_id, request, table_id, assignment_mode, capacity_override, confirmed_by',
    upcoming);

  await lockCalendarStaff(scope);
  const staff = await insertSeedRows(db, 'customer.staff', 'store_id, staff_id, name, revision',
    seedSupplement.staff.map(person => ({ ...store, staff_id: seedId(person.staffId), name: person.name, revision: 1 })));
  const days = (rows.business_day as SeedDay[]).map(day => day.business_date);
  for (let offset = 1; offset <= 6; offset++) days.push(shiftSeedDate(context.end, offset));
  const shifts = await insertSeedRows(db, 'customer.staff_shift',
    'store_id, schedule_id, staff_id, shift_date, kind, start_minute, end_minute, break_minutes, revision',
    days.flatMap(day => seedSupplement.shifts.filter(shift => new Date(shift.date).getUTCDay() === new Date(day).getUTCDay())
      .map(shift => ({ ...store, schedule_id: seedId(`shift:${shift.staffId}:${day}:${shift.start}`),
        staff_id: seedId(shift.staffId), shift_date: day, kind: 'work', start_minute: minutes(shift.start),
        end_minute: minutes(shift.end), break_minutes: 0, revision: 1 }))));
  const manualEvents = (rows.calendar_event as Array<{ event_id: string; title: string; category: string; date: string;
    time: string | null; closure_kind: string | null; closure_end_date: string | null }>).map(event => ({
    ...store, ...event, category_id: event.closure_kind ? 'store-operations' : event.category, title_key: titleKey(event.title),
    starts_on: event.date, start_minute: minutes(event.time), closure_ends_on: event.closure_end_date, revision: 1,
  }));
  const events = await insertSeedRows(db, 'customer.calendar_event',
    'store_id, event_id, kind, category_id, title, title_key, starts_on, start_minute, memo, closure_kind, closure_ends_on, revision', manualEvents);
  const projection = (source: string, sourceId: string, day: string | null, time: string | null) => ({
    ...store, source, source_id: sourceId, source_revision: 1,
    starts_on: day, ends_on: day, start_minute: minutes(time),
  });
  const pickups = customOrderExamples(context).flatMap(({ pickup }) => pickup ? [pickup] : []);
  const booked = await insertSeedRows(db, 'customer.booking_pickup', 'store_id, custom_order_id, revision, pickup, date',
    pickups.map(pickup => ({ ...store, custom_order_id: pickup.customOrderId, revision: 2, pickup, date: pickup.date })));
  if (booked) await bumpBookingRevision({ ...scope, at: new Date(cutoff) });
  const projected = await insertSeedRows(db, 'customer.calendar_projection',
    'store_id, source, source_id, source_revision, starts_on, ends_on, start_minute', [
      ...[...reservations, ...upcoming].map(booking => {
        const local = seoulSeedTime(booking.starts_at);
        return booking.status === 'confirmed'
          ? projection('reservation', booking.reservation_id, local.slice(0, 10), local.slice(11, 16))
          : projection('reservation', booking.reservation_id, null, null);
      }),
      ...pickups.map(pickup => ({ ...projection('custom-pickup', pickup.customOrderId, pickup.date, pickup.time), source_revision: 2 })),
      ...(rows.purchase_order as Array<{ po_id: string; due_date: string; expected_time: string; created_at: string }>)
        .filter(order => order.created_at <= cutoff)
        .map(order => {
          const delivery = new Date(`${order.due_date}T${order.expected_time}:00+09:00`).toISOString();
          return delivery > cutoff ? projection('purchase-order', order.po_id, order.due_date, order.expected_time)
            : projection('purchase-order', order.po_id, null, null);
        }),
      ...seedSupplement.taxPayments.filter(tax => tax.amount > 0)
        .map(tax => projection('tax-due', seedId(tax.id), shiftSeedDate(tax.dueOn, offset), null)),
    ]);
  if (staff) await bumpRevision(scope, ['staff']);
  if (shifts) await bumpRevision(scope, ['shifts']);
  if (events) await bumpRevision(scope, ['calendar']);
  if (projected) await bumpRevision(scope, ['projections']);

  await seedPasses(db, storeId, context);
}

async function seedPasses(db: PoolClient, storeId: string, { rows, businessDate }: SeedContext) {
  const products = (rows.membership_product as Array<{ product_id: string; name: string; kind: string;
    uses: number; valid_days: number; daily_limit: number | null; price: number }>).map((product, index) => {
    const menu = seedCatalog.menu.find(item => item.menuId === content.memberships[index]?.menu);
    if (!menu) throw new Error('Café membership fixture has no menu');
    return { store_id: storeId, ...product, total_uses: product.uses, sold_price: product.price, menu_ids: [menu.dbId] };
  });
  await insertSeedRows(db, 'customer.membership_product',
    'store_id, product_id, name, kind, sold_price, total_uses, valid_days, daily_limit, menu_ids', products);
  const memberIds = new Map((rows.member_profile as SeedMember[]).map(member => [member.customer_id, member.member_id]));
  const offset = (Date.parse(businessDate) - Date.parse('2026-11-17')) / 86_400_000;
  const passes = (rows.membership as { membership_id: string; customer_id: string; product_id: string }[]).map(pass => ({
    ...pass, member_id: memberIds.get(pass.customer_id),
  }));
  passes.push(...seedSupplement.activePasses.map(pass => ({
    membership_id: seedId(pass.membershipId), customer_id: pass.customerId, product_id: pass.productId,
    member_id: pass.memberId, starts_on: shiftSeedDate(pass.startsOn, offset), ends_on: shiftSeedDate(pass.endsOn, offset),
    uses_left: pass.usesLeft,
  })));
  await insertSeedRows(db, 'customer.membership',
    'store_id, membership_id, status, starts_on, ends_on, uses_total, uses_left, member_id, product_id, sale_settlement_id, sold_terms',
    passes.map(pass => {
      const product = products.find(item => item.product_id === pass.product_id)!;
      return { store_id: storeId, ...pass, status: 'active', uses_total: product.uses,
        sale_settlement_id: seedId('pre-window-pass:' + pass.membership_id),
        sold_terms: { productId: product.product_id, name: product.name, kind: product.kind,
          soldPrice: product.price, totalUses: product.uses, validDays: product.valid_days, dailyLimit: product.daily_limit,
          menuIds: product.menu_ids } };
    }));
}
