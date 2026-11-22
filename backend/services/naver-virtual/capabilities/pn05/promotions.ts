import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { PersonaCapability } from '../../app.ts';
import type { OrderPromotion, PromotionWrite } from '../../../../packages/naver/contracts/pn05/index.ts';
import {
  day, emptyBody, fields, fingerprint, flag, integer, kstDay, page, partnerError, partnerPrefix, ref, shiftDay, text,
} from '../../../../packages/naver/contracts/pn03/partner.ts';
import { lockAccount } from '../pn03/partner-db.ts';

const path = `${partnerPrefix}/order/promotions`;
const columns = 'ref, name, starts_on::text, ends_on::text, amount_per_stamp, coupons, instructions, ended_at';
type Row = {
  ref: string; name: string; starts_on: string; ends_on: string; amount_per_stamp: number;
  coupons: PromotionWrite['coupons']; instructions: string | null; ended_at: Date | null;
};

function project(row: Row, today: string): OrderPromotion {
  const state = row.ended_at !== null || today > row.ends_on ? 'ended' : today < row.starts_on ? 'upcoming' : 'active';
  return {
    ref: row.ref, name: row.name, from: row.starts_on, to: row.ends_on, state,
    orderAmountPerStamp: row.amount_per_stamp, coupons: row.coupons,
    ...(row.instructions !== null ? { instructions: row.instructions } : {}),
  };
}

async function get(client: PoolClient, account: string, promotionRef: string) {
  const { rows: [row] } = await client.query<Row>(
    `SELECT ${columns} FROM naver_virtual.pn05_order_promotions WHERE account_id = $1 AND ref = $2`, [account, promotionRef],
  );
  if (!row) partnerError(404, '주문 프로모션을 찾을 수 없어요.');
  return row;
}

function promotionInput(body: unknown): PromotionWrite {
  const input = fields(body, ['name', 'from', 'to', 'orderAmountPerStamp', 'coupons'], ['instructions']);
  if (!Array.isArray(input.coupons) || input.coupons.length < 1 || input.coupons.length > 10) {
    partnerError(400, '스탬프 혜택을 선택해 주세요.');
  }
  const coupons = input.coupons.map((value) => {
    const coupon = fields(value, ['stampCount', 'name', 'validDays', 'canCombine', 'canUseAlone'], ['instructions']);
    return {
      stampCount: integer(coupon.stampCount, 1, 10), name: text(coupon.name, 18, 2),
      validDays: integer(coupon.validDays, 30, 999), canCombine: flag(coupon.canCombine), canUseAlone: flag(coupon.canUseAlone),
      ...(coupon.instructions === undefined ? {} : { instructions: text(coupon.instructions, 100, 5) }),
    };
  }).sort((a, b) => a.stampCount - b.stampCount);
  if (new Set(coupons.map((coupon) => coupon.stampCount)).size !== coupons.length) {
    partnerError(400, '같은 적립 횟수에 지급하는 혜택을 확인해 주세요.');
  }
  return {
    name: text(input.name, 20, 2), from: day(input.from), to: day(input.to),
    orderAmountPerStamp: integer(input.orderAmountPerStamp, 1000, 99_999_999), coupons,
    ...(input.instructions === undefined ? {} : { instructions: text(input.instructions, 500, 5) }),
  };
}

async function checkWindow(client: PoolClient, account: string, from: string, to: string, existingRef: string | null) {
  const { rows: [span] } = await client.query<{ valid: boolean }>(
    "SELECT $2::date >= $1::date AND $2::date < ($1::date + INTERVAL '1 year') AS valid", [from, to],
  );
  if (!span.valid) partnerError(400, '프로모션 기간은 1일에서 1년까지 설정할 수 있어요.');
  const { rowCount } = await client.query(`
    SELECT 1 FROM naver_virtual.pn05_order_promotions
    WHERE account_id = $1 AND ref IS DISTINCT FROM $4 AND starts_on <= $3
      AND LEAST(ends_on, COALESCE((ended_at AT TIME ZONE 'Asia/Seoul')::date, ends_on)) >= $2
    LIMIT 1
  `, [account, from, to, existingRef]);
  if (rowCount) partnerError(409, '프로모션 기간이 서로 겹쳐요.');
}

export function registerPromotions(app: FastifyInstance, context: Parameters<PersonaCapability['register']>[1]) {
  // NAVER Order promotions 20710.
  app.get(path, { config: { personaOperation: 'pn05.promotions.list' } }, (request) => {
    const [limit, offset] = page(fields(request.query, [], ['limit', 'offset']));
    const today = kstDay(context.now());
    return context.transaction(request, async (client) => {
      const { rows } = await client.query<Row>(`
        SELECT ${columns} FROM naver_virtual.pn05_order_promotions
        WHERE account_id = $1 ORDER BY starts_on DESC, ref LIMIT $2 OFFSET $3
      `, [context.accountId(request), limit, offset]);
      return { items: rows.map((row) => project(row, today)) };
    });
  });

  // NAVER Order promotions 20710. Gift rewards and order amount per stamp.
  app.post(path, { config: { personaOperation: 'pn05.promotions.create' } }, async (request) => {
    fields(request.query, []);
    const input = promotionInput(request.body);
    const today = kstDay(context.now());
    const account = context.accountId(request);
    const effect = await context.effect(request, fingerprint(input), async (client) => {
      if (input.from <= today) partnerError(400, '프로모션 시작일은 내일부터 설정할 수 있어요.');
      await lockAccount(client, 'pn05-order-promotions', account);
      await checkWindow(client, account, input.from, input.to, null);
      const promotionRef = randomUUID();
      await client.query(`
        INSERT INTO naver_virtual.pn05_order_promotions
          (account_id, ref, name, starts_on, ends_on, amount_per_stamp, coupons, instructions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [account, promotionRef, input.name, input.from, input.to, input.orderAmountPerStamp, JSON.stringify(input.coupons),
        input.instructions ?? null]);
      return promotionRef;
    });
    return context.transaction(request, async (client) => project(await get(client, account, ref(effect.ref)), today));
  });

  // NAVER Order promotions 20710. Only running promotions can be extended or ended.
  for (const action of ['extend', 'end'] as const) {
    app.post<{ Params: { ref: string } }>(`${path}/:ref/${action}`, {
      config: { personaOperation: `pn05.promotions.${action}` },
    }, async (request) => {
      fields(request.query, []);
      const promotionRef = ref(request.params.ref);
      const to = action === 'extend' ? day(fields(request.body, ['to']).to) : null;
      if (action === 'end') emptyBody(request.body);
      const account = context.accountId(request);
      const now = context.now();
      const today = kstDay(now);
      await context.effect(request, fingerprint({ promotionRef, to }), async (client) => {
        await lockAccount(client, 'pn05-order-promotions', account);
        const row = await get(client, account, promotionRef);
        if (project(row, today).state !== 'active') partnerError(409, '진행 중인 프로모션만 바꿀 수 있어요.');
        if (to !== null) {
          if (to <= row.ends_on) partnerError(400, '기존 종료일보다 늦은 날을 선택해 주세요.');
          await checkWindow(client, account, row.starts_on, to, promotionRef);
          await client.query('UPDATE naver_virtual.pn05_order_promotions SET ends_on = $3 WHERE account_id = $1 AND ref = $2',
            [account, promotionRef, to]);
        } else {
          await client.query('UPDATE naver_virtual.pn05_order_promotions SET ended_at = $3 WHERE account_id = $1 AND ref = $2',
            [account, promotionRef, now]);
        }
        return promotionRef;
      });
      return context.transaction(request, async (client) => project(await get(client, account, promotionRef), today));
    });
  }
}

export async function seedPromotions(client: PoolClient, account: string, now: Date) {
  const today = kstDay(now);
  const coupons = [{ stampCount: 5, name: '아메리카노 1잔 무료', validDays: 60, canCombine: false, canUseAlone: true }];
  await client.query(`
    INSERT INTO naver_virtual.pn05_order_promotions (account_id, ref, name, starts_on, ends_on, amount_per_stamp, coupons)
    VALUES ($1,'promotion-01','카페 주문 스탬프',$2,$3,4500,$4) ON CONFLICT DO NOTHING
  `, [account, shiftDay(today, -7), shiftDay(today, 7), JSON.stringify(coupons)]);
}
