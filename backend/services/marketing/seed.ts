import type { Pool, PoolClient } from 'pg';
import content from '../../../db/seed/ansungjalbu/content.json' with { type: 'json' };
import { seedSupplement } from '../../../frontend/src/data/db/generated/supplement.ts';
import { createSeedContext, type SeedContext } from '../../packages/db/seed-context.ts';
import { historyForSeed, insertSeedRows, seedId, seoulSeedTime } from '../../packages/db/seed-history.ts';
import { comparisonStoreId } from '../account/seed.ts';
import { demoIdentity } from '../account/identity.ts';
import { advanceSource } from './reality/13/revision.ts';
import { seedOfficialLocal } from './reality/13/seed.ts';
import { seedCoupons } from './reality/14/seed.ts';
import { redactReviewContact } from './reality/15/wire.ts';
import { inStore } from './transaction.ts';

const proposals = [
  ['40be4548-56ab-46ca-98bd-4898bcc11e66', '책방 영수증 혜택', '책방 영수증을 가져온 손님에게 음료 할인 혜택을 함께 안내해요.'],
  ['5f46a596-1121-4576-ad9a-06f29de73f85', '주말 독서 모임', '주말 독서 모임 손님에게 카페 방문 안내를 함께 전해요.'],
  ['979f6dd3-997b-4039-875e-7a1dfae9177f', '동네 산책 지도', '두 매장이 함께 들어간 동네 산책 지도를 카운터에 놓아요.'],
] as const;

export async function seed(pool: Pool, context = createSeedContext()) {
  await seedOfficialLocal(pool);
  const cafe = demoIdentity.storeId;
  await inStore(pool, cafe, async db => {
    await seedSales(db, cafe, context);
    if (context.operatingHistory) {
      await seedCoupons(db, cafe, context);
      await seedLocalAndInbox(db, cafe, context);
    }
  }, { serialize: true });
  await inStore(pool, comparisonStoreId, async db => {
    let inserted = false;
    for (const [id, title, terms] of proposals) {
      const result = await db.query(`
        INSERT INTO marketing.community_offer
          (id, sender_store_id, recipient_store_id, title, terms, starts_on, ends_on, respond_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::date + 7, $6::date + 14, $6::date + 6,
          ($6::date + time '12:00') AT TIME ZONE 'Asia/Seoul')
        ON CONFLICT (id) DO NOTHING
      `, [id, comparisonStoreId, cafe, title, terms, context.businessDate]);
      if (result.rowCount) inserted = true;
    }
    if (inserted) {
      await advanceSource(db, comparisonStoreId, 'community');
      await db.query("SELECT set_config('app.store_id', $1, true)", [cafe]);
      await advanceSource(db, cafe, 'community');
    }
  }, { serialize: true });
}

async function seedLocalAndInbox(db: PoolClient, storeId: string, context: SeedContext) {
  const store = { store_id: storeId };
  const local = await insertSeedRows(db, 'marketing.local_change',
    'store_id, id, kind, title, region, authority, date_kind, reference_date, imported_at',
    seedSupplement.localChanges.map(change => ({
      ...store, id: seedId(change.id), kind: 'owner-record', title: change.title,
      region: '서울 동작구 상도동', authority: '사장님 기록', date_kind: 'recorded-date',
      reference_date: seoulSeedTime(context.cutoff).slice(0, 10), imported_at: context.cutoff,
    })));
  if (local) await advanceSource(db, storeId, 'local-changes');

  // Manual inquiries are owner records. The connected review and TalkTalk lists keep their separate Persona sources.
  const threads = (context.rows.inquiry_thread as { thread_id: string; external_id: string; received_at: string }[]);
  const byRef = new Map(threads.map(row => [row.external_id, row]));
  const inquiries = content.inquiries.flatMap((inquiry, index) => {
      const thread = byRef.get('FICTIONAL-INQUIRY-' + index);
      if (!thread || thread.received_at > context.cutoff) return [];
      return [{ ...store, id: thread.thread_id, kind: 'inquiry', revision: 1,
        status: inquiry.status === 'done' ? 'done' : 'waiting', source: 'manual', updated_at: thread.received_at,
        data: { type: 'message', title: inquiry.channel + ' 문의', text: redactReviewContact(inquiry.text),
          sourceUrl: null, draft: null, reply: null },
      }];
    });
  await insertSeedRows(db, 'marketing.reply_notice_record',
    'store_id, id, kind, revision, status, source, data, updated_at', inquiries);
  await db.query(`
    UPDATE marketing.reply_notice_record AS existing
    SET updated_at = ((existing.updated_at AT TIME ZONE $3)::date + (seed.updated_at AT TIME ZONE $3)::time) AT TIME ZONE $3
    FROM jsonb_to_recordset($2::jsonb) seed(id uuid, status text, data jsonb, updated_at timestamptz)
    WHERE existing.store_id = $1 AND existing.id = seed.id AND existing.kind = 'inquiry'
      AND existing.revision = 1 AND existing.source = 'manual' AND existing.status = seed.status AND existing.data = seed.data
      AND (existing.updated_at AT TIME ZONE $3)::time = TIME '14:00'
  `, [storeId, JSON.stringify(inquiries), content.store.timezone]);
}

async function seedSales(db: PoolClient, storeId: string, context: SeedContext) {
  const store = { store_id: storeId };
  const contacts = new Map((context.rows.customer as Array<{ customer_id: string; consent_sms: boolean }>)
    .map(customer => [customer.customer_id, customer.consent_sms]));
  const members = await insertSeedRows(db, 'marketing.r19_member',
    'store_id, member_id, member_revision, active, contact_allowed, marketing_allowed, name_initial, event_id, updated_at',
    (context.rows.member_profile as Array<{ member_id: string; customer_id: string; created_at: string }>).map(member => ({
      ...store, member_id: member.member_id, member_revision: 1, active: true, contact_allowed: true,
      marketing_allowed: contacts.get(member.customer_id) ?? false,
      name_initial: contacts.get(member.customer_id) ? '손' : null,
      event_id: seedId('member:' + member.member_id), updated_at: member.created_at,
    })));
  const history = historyForSeed(context).filter(sale => sale.at !== null);
  const sales = await insertSeedRows(db, 'marketing.r19_sale',
    'store_id, settlement_id, business_date, occurred_at, member_id, amount, cost, incomplete_margin, event_id',
    history.map(sale => ({
      ...store, settlement_id: sale.settlementId, business_date: sale.businessDate, occurred_at: sale.at,
      member_id: sale.bill.member_id, amount: sale.quote.payable, cost: sale.cost, incomplete_margin: false,
      event_id: seedId('sale-event:' + sale.settlementId),
    })));
  const corrections = history.filter(sale => sale.correction);
  const corrected = await insertSeedRows(db, 'marketing.r19_sale_correction',
    'store_id, correction_id, settlement_id, business_date, occurred_at, kind, amount_delta, cost_delta, incomplete_margin, member_visit_voided, event_id',
    corrections.map(sale => ({
      ...store, correction_id: sale.correction!.correction_id, settlement_id: sale.settlementId, business_date: sale.businessDate,
      occurred_at: sale.correction!.at, kind: sale.correction!.kind, amount_delta: -sale.correction!.amount,
      cost_delta: sale.changes.reduce((sum, line) => sum + line.cost, 0), incomplete_margin: false,
      member_visit_voided: sale.correction!.kind === 'cancel' && !!sale.bill.member_id,
      event_id: seedId('correction-event:' + sale.correction!.correction_id),
    })));
  if (members || sales || corrected) await db.query(`
    INSERT INTO marketing.r19_projection_state (store_id, revision, updated_at) VALUES ($1, $2, $3)
    ON CONFLICT (store_id) DO UPDATE SET revision = marketing.r19_projection_state.revision + EXCLUDED.revision,
      updated_at = greatest(marketing.r19_projection_state.updated_at, EXCLUDED.updated_at)
  `, [storeId, members + sales + corrected, context.cutoff]);
  await insertSeedRows(db, 'marketing.local_sale_delta',
    'store_id, event_id, settlement_id, allocation_id, menu_id, quantity, business_date, occurred_at', [
      ...history.flatMap(sale => sale.lines.map(line => ({
        ...store, event_id: seedId('sale-event:' + sale.settlementId), settlement_id: sale.settlementId,
        allocation_id: line.allocationId, menu_id: line.menuId, quantity: line.qty,
        business_date: sale.businessDate, occurred_at: sale.at,
      }))),
      ...corrections.filter(sale => sale.correction!.kind === 'cancel').flatMap(sale => sale.changes.map(line => ({
        ...store, event_id: seedId('correction-event:' + sale.correction!.correction_id), settlement_id: sale.settlementId,
        allocation_id: line.allocationId, menu_id: line.menuId, quantity: -line.quantity,
        business_date: sale.businessDate, occurred_at: sale.correction!.at,
      }))),
    ]);
}
