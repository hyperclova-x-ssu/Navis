import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { PersonaCapability } from '../../app.ts';
import type { CouponBenefit, CouponIssue, PlaceCoupon, PlaceCouponWrite } from '../../../../packages/naver/contracts/pn05/index.ts';
import {
  day, emptyBody, fields, fingerprint, flag, integer, kstDay, oneOf, page, partnerError, partnerPrefix, ref, shiftDay, text,
} from '../../../../packages/naver/contracts/pn03/partner.ts';
import { lockAccount } from '../pn03/partner-db.ts';

export const couponLock = 'pn05-place-coupons';
const couponsPath = `${partnerPrefix}/place/coupons`;
const couponProjection = 'ref, coupon_type, name, benefit, audience, display_from::text, display_to::text, quantity, conditions';
type CouponRow = {
  ref: string; coupon_type: PlaceCoupon['type']; name: string; benefit: CouponBenefit;
  audience: PlaceCoupon['audience']; display_from: string | null; display_to: string | null;
  quantity: number | null; conditions: string | null;
};
type IssueRow = { ref: string; masked_number: string; issued_on: string; expires_on: string; used: boolean };
const issueProjection = 'ref, masked_number, issued_on::text, expires_on::text, used';

function projectCoupon(row: CouponRow): PlaceCoupon {
  return {
    ref: row.ref, type: row.coupon_type, name: row.name, benefit: row.benefit, audience: row.audience,
    ...(row.audience !== 'marketing-message' ? {
      displayPeriod: row.display_from && row.display_to ? { from: row.display_from, to: row.display_to } : null,
      quantity: row.quantity,
    } : {}),
    ...(row.conditions === null ? {} : { conditions: row.conditions }),
  };
}

function projectIssue(row: IssueRow): CouponIssue {
  return { ref: row.ref, maskedNumber: row.masked_number, issuedOn: row.issued_on, expiresOn: row.expires_on, used: row.used };
}

function discountValue(type: 'amount' | 'percent', value: unknown) {
  if (type === 'amount') return integer(value, 1, Number.MAX_SAFE_INTEGER);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    partnerError(400, '할인율을 확인해 주세요.');
  }
  return value;
}

function couponInput(body: unknown): PlaceCouponWrite {
  const input = fields(body, ['type', 'name', 'benefit', 'audience'], ['displayPeriod', 'quantity', 'conditions']);
  const audience = oneOf(input.audience, ['all', 'benefit-subscribers', 'marketing-message']);
  if (audience === 'marketing-message' && (Object.hasOwn(input, 'displayPeriod') || Object.hasOwn(input, 'quantity'))) {
    partnerError(400, '마케팅 메시지 전용 쿠폰에는 노출 기간과 발행 수량을 설정할 수 없어요.');
  }
  const benefitData = fields(input.benefit, ['type'], ['value', 'item']);
  const type = oneOf(benefitData.type, ['amount', 'percent', 'gift']);
  const benefit = type === 'gift'
    ? { type, item: text(fields(benefitData, ['type', 'item']).item, Infinity) }
    : { type, value: discountValue(type, fields(benefitData, ['type', 'value']).value) };
  let displayPeriod = null;
  if (input.displayPeriod != null) {
    const period = fields(input.displayPeriod, ['from', 'to']);
    displayPeriod = { from: day(period.from), to: day(period.to) };
    if (displayPeriod.from > displayPeriod.to) partnerError(400, '쿠폰 노출 기간을 확인해 주세요.');
  }
  return {
    type: oneOf(input.type, ['place', 'booking', 'order']), name: text(input.name, Infinity), benefit, audience, displayPeriod,
    quantity: input.quantity == null ? null : integer(input.quantity, 1, 2_147_483_647),
    conditions: input.conditions == null ? null : text(input.conditions, Infinity),
  };
}

async function allowExposure(client: PoolClient, account: string, input: PlaceCouponWrite, today: string) {
  if (input.audience === 'marketing-message') return;
  const from = input.displayPeriod?.from ?? today;
  const to = input.displayPeriod?.to ?? 'infinity';
  const { rows: [limits] } = await client.query<{ full: boolean; benefit_full: boolean }>(`
    WITH exposed AS (
      SELECT COALESCE(display_from, '-infinity') AS starts, COALESCE(display_to, 'infinity') AS ends, audience
      FROM naver_virtual.pn05_place_coupons
      WHERE account_id = $1 AND deleted_at IS NULL AND audience <> 'marketing-message'
    ), days AS (
      SELECT $2::date AS date UNION SELECT starts FROM exposed WHERE starts BETWEEN $2 AND $3
    ), counts AS (
      SELECT COUNT(audience) AS total, COUNT(*) FILTER (WHERE audience = 'benefit-subscribers') AS benefits
      FROM days LEFT JOIN exposed ON date BETWEEN starts AND ends GROUP BY date
    )
    SELECT COALESCE(MAX(total) >= 10,false) AS full, COALESCE(MAX(benefits) >= 1,false) AS benefit_full FROM counts
  `, [account, from, to]);
  if (limits.full || (input.audience === 'benefit-subscribers' && limits.benefit_full)) {
    partnerError(409, '해당 기간에 노출할 수 있는 쿠폰 수를 확인해 주세요.');
  }
}

// Coupon attachment 21111. Caller takes couponLock and commits attachment with the campaign.
export async function attachMarketingCoupon(client: PoolClient, account: string, couponRef: string, now: Date) {
  const result = await client.query(`
    UPDATE naver_virtual.pn05_place_coupons SET last_sent_at = $3
    WHERE account_id = $1 AND ref = $2 AND deleted_at IS NULL AND audience = 'marketing-message'
  `, [account, couponRef, now]);
  if (!result.rowCount) partnerError(409, '마케팅 메시지에 첨부할 수 있는 쿠폰을 선택해 주세요.');
}

export function registerCoupons(app: FastifyInstance, context: Parameters<PersonaCapability['register']>[1]) {
  // Place coupon creation and owner list 20833. Deleted offers leave earlier issues intact.
  app.get(couponsPath, { config: { personaOperation: 'pn05.coupons.list' } }, (request) => {
    const [limit, offset] = page(fields(request.query, [], ['limit', 'offset']));
    return context.transaction(request, async (client) => {
      const { rows } = await client.query<CouponRow>(`
        SELECT ${couponProjection} FROM naver_virtual.pn05_place_coupons WHERE account_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, ref LIMIT $2 OFFSET $3
      `, [context.accountId(request), limit, offset]);
      return { items: rows.map(projectCoupon) };
    });
  });

  // Place coupon creation 20833 and marketing coupon 21111.
  app.post(couponsPath, { config: { personaOperation: 'pn05.coupons.create' } }, async (request) => {
    fields(request.query, []);
    const input = couponInput(request.body);
    const account = context.accountId(request);
    const now = context.now();
    const result = await context.effect(request, fingerprint(input), async (client) => {
      await lockAccount(client, couponLock, account);
      await allowExposure(client, account, input, kstDay(now));
      const couponRef = randomUUID();
      await client.query(`
        INSERT INTO naver_virtual.pn05_place_coupons
          (account_id, ref, coupon_type, name, benefit, audience, display_from, display_to, quantity, conditions, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [account, couponRef, input.type, input.name, JSON.stringify(input.benefit), input.audience,
        input.displayPeriod?.from ?? null, input.displayPeriod?.to ?? null, input.quantity, input.conditions, now]);
      return couponRef;
    });
    return context.transaction(request, async (client) => {
      const { rows: [row] } = await client.query<CouponRow>(`
        SELECT ${couponProjection} FROM naver_virtual.pn05_place_coupons WHERE account_id = $1 AND ref = $2 AND deleted_at IS NULL
      `, [account, ref(result.ref)]);
      if (!row) partnerError(404, '쿠폰을 찾을 수 없어요.');
      return projectCoupon(row);
    });
  });

  // Place coupon deletion 20837 and marketing attachment lockout 21111.
  app.delete<{ Params: { ref: string } }>(`${couponsPath}/:ref`, {
    config: { personaOperation: 'pn05.coupons.delete' },
  }, async (request, reply) => {
    fields(request.query, []);
    emptyBody(request.body);
    const account = context.accountId(request);
    const couponRef = ref(request.params.ref);
    await context.effect(request, fingerprint(couponRef), async (client) => {
      await lockAccount(client, couponLock, account);
      const { rows: [row] } = await client.query<{ last_sent_at: Date | null }>(`
        SELECT last_sent_at FROM naver_virtual.pn05_place_coupons
        WHERE account_id = $1 AND ref = $2 AND deleted_at IS NULL FOR UPDATE
      `, [account, couponRef]);
      if (!row) partnerError(404, '쿠폰을 찾을 수 없어요.');
      const now = context.now();
      if (row.last_sent_at && (now.getTime() - row.last_sent_at.getTime()) < 30 * 86_400_000) {
        partnerError(409, '마케팅 메시지 발송 후 30일이 지나면 쿠폰을 삭제할 수 있어요.');
      }
      await client.query('UPDATE naver_virtual.pn05_place_coupons SET deleted_at = $3 WHERE account_id = $1 AND ref = $2',
        [account, couponRef, now]);
      return couponRef;
    });
    return reply.code(204).send();
  });

  // Issued coupon lookup and status 20843, including still-valid issues after deletion 20837.
  app.get<{ Params: { ref: string } }>(`${couponsPath}/:ref/issues`, {
    config: { personaOperation: 'pn05.issues.list' },
  }, (request) => {
    const [limit, offset] = page(fields(request.query, [], ['limit', 'offset']));
    const couponRef = ref(request.params.ref);
    const account = context.accountId(request);
    return context.transaction(request, async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM naver_virtual.pn05_place_coupons WHERE account_id = $1 AND ref = $2',
        [account, couponRef]);
      if (!rowCount) partnerError(404, '쿠폰을 찾을 수 없어요.');
      const { rows } = await client.query<IssueRow>(`
        SELECT ${issueProjection} FROM naver_virtual.pn05_place_issues WHERE account_id = $1 AND coupon_ref = $2
        ORDER BY issued_on DESC, ref LIMIT $3 OFFSET $4
      `, [account, couponRef, limit, offset]);
      return { items: rows.map(projectIssue) };
    });
  });

  // Issued coupon use and cancellation 20843. Expiration remains the original issue date.
  app.patch<{ Params: { ref: string } }>(`${partnerPrefix}/place/coupon-issues/:ref/usage`, {
    config: { personaOperation: 'pn05.issues.update' },
  }, async (request) => {
    fields(request.query, []);
    const issueRef = ref(request.params.ref);
    const used = flag(fields(request.body, ['used']).used);
    const account = context.accountId(request);
    const result = await context.effect(request, fingerprint({ issueRef, used }), async (client) => {
      const { rows: [row] } = await client.query<IssueRow>(`
        SELECT ${issueProjection} FROM naver_virtual.pn05_place_issues WHERE account_id = $1 AND ref = $2 FOR UPDATE
      `, [account, issueRef]);
      if (!row) partnerError(404, '발급된 쿠폰을 찾을 수 없어요.');
      if (row.expires_on < kstDay(context.now())) partnerError(409, '기간이 지난 쿠폰의 사용 상태는 바꿀 수 없어요.');
      await client.query('UPDATE naver_virtual.pn05_place_issues SET used = $3 WHERE account_id = $1 AND ref = $2',
        [account, issueRef, used]);
      return issueRef;
    });
    return context.transaction(request, async (client) => {
      const { rows: [row] } = await client.query<IssueRow>(`
        SELECT ${issueProjection} FROM naver_virtual.pn05_place_issues WHERE account_id = $1 AND ref = $2
      `, [account, ref(result.ref)]);
      if (!row) partnerError(404, '발급된 쿠폰을 찾을 수 없어요.');
      return projectIssue(row);
    });
  });
}

export async function seedCoupons(client: PoolClient, account: string, now: Date) {
  const today = kstDay(now);
  await client.query(`
    INSERT INTO naver_virtual.pn05_place_coupons
      (account_id, ref, coupon_type, name, benefit, audience, display_from, display_to, quantity, created_at)
    VALUES ($1,'coupon-01','place','카페 방문 할인',$2,'all',$3,$4,100,$5),
      ($1,'coupon-02','place','첫 방문 감사 쿠폰',$6,'benefit-subscribers',$3,$4,50,$5),
      ($1,'coupon-03','place','톡톡 드립커피 증정',$7,'marketing-message',NULL,NULL,NULL,$5)
    ON CONFLICT DO NOTHING
  `, [account, { type: 'amount', value: 1000 }, shiftDay(today, -7), shiftDay(today, 7), now,
    { type: 'percent', value: 10 }, { type: 'gift', item: '드립커피 1잔' }]);
  await client.query(`
    INSERT INTO naver_virtual.pn05_place_issues VALUES
      ($1,'issue-01','coupon-01','****-**21',$2,$3,false), ($1,'issue-02','coupon-01','****-**07',$2,$4,false)
    ON CONFLICT DO NOTHING
  `, [account, shiftDay(today, -7), shiftDay(today, 7), shiftDay(today, -2)]);
}
