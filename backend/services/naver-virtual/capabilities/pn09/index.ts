import { timingSafeEqual } from 'node:crypto';
import content from '../../../../../db/seed/ansungjalbu/content.json' with { type: 'json' };
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { PersonaCapability } from '../../app.ts';
import { record } from '../../../../packages/naver/contracts/pn01/wire.ts';
import { financialCenterPath, payPaths } from '../../../../packages/naver/contracts/pn09/wire.ts';
import type { Recommendation, Settlement } from '../../../../packages/naver/contracts/pn09/wire.ts';
import { approvalBody, cancellationBody, cancellationResult, formError, pageSize, parseApproval, parseCancellation, payDate, settlementPage } from './pay-wire.ts';

const scope = "(SELECT current_setting('app.persona_account_id', true))";
const tables = ['pn09_payment', 'pn09_pay_attempt', 'pn09_settlement', 'pn09_recommendation'];
const migration = {
  id: 'pn09_001_merchant',
  up: `
    CREATE TABLE naver_virtual.pn09_payment (
      account_id text NOT NULL, generation text NOT NULL, payment_id text NOT NULL,
      pay_hist_id text NOT NULL, merchant_pay_key text NOT NULL, merchant_transaction_key text NOT NULL,
      product_name text NOT NULL, use_date text NOT NULL CHECK (use_date ~ '^[0-9]{8}$'),
      amount integer NOT NULL CHECK (amount > 0), remaining integer NOT NULL CHECK (remaining BETWEEN 0 AND amount),
      reserved_at timestamptz NOT NULL, approved_at timestamptz,
      cancellation_count integer NOT NULL DEFAULT 0 CHECK (cancellation_count >= 0),
      PRIMARY KEY (account_id,payment_id)
    );
    CREATE TABLE naver_virtual.pn09_pay_attempt (
      account_id text NOT NULL, operation text NOT NULL CHECK (operation IN ('approve','cancel')),
      attempt_key text NOT NULL, response jsonb NOT NULL,
      PRIMARY KEY (account_id,operation,attempt_key)
    );
    CREATE TABLE naver_virtual.pn09_settlement (
      account_id text NOT NULL, generation text NOT NULL, payment_id text NOT NULL, pay_hist_id text NOT NULL,
      projection jsonb NOT NULL, PRIMARY KEY (account_id,pay_hist_id)
    );
    CREATE INDEX pn09_settlement_payment ON naver_virtual.pn09_settlement(account_id,payment_id,pay_hist_id);
    CREATE TABLE naver_virtual.pn09_recommendation (
      account_id text NOT NULL, generation text NOT NULL, ref text NOT NULL, projection jsonb NOT NULL,
      PRIMARY KEY (account_id,ref)
    );
    ${tables.map(table => `
      ALTER TABLE naver_virtual.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY pn09_account ON naver_virtual.${table} USING (account_id=${scope}) WITH CHECK (account_id=${scope});
      GRANT SELECT ON naver_virtual.${table} TO nvirtual_run;
    `).join('')}
    GRANT UPDATE (approved_at,remaining,cancellation_count) ON naver_virtual.pn09_payment TO nvirtual_run;
    GRANT INSERT ON naver_virtual.pn09_pay_attempt TO nvirtual_run;
  `,
  down: 'DROP TABLE naver_virtual.pn09_recommendation, naver_virtual.pn09_settlement, naver_virtual.pn09_pay_attempt, naver_virtual.pn09_payment;',
};
interface PaymentRow {
  pay_hist_id: string; merchant_pay_key: string; merchant_transaction_key: string; product_name: string;
  use_date: string; amount: number; remaining: number;
  reserved_at: Date; approved_at: Date | null; cancellation_count: number;
}
type Outcome = { status: number; response: { code: string; message: string; body?: unknown } };

function outcome(code: string, message: string, status = 200): Outcome {
  return { status, response: { code, message } };
}
function success(body: unknown): Outcome {
  return { status: 200, response: { code: 'Success', message: '성공', body } };
}
function send(reply: FastifyReply, result: Outcome) {
  return reply.code(result.status).send(result.response);
}

const invalid = outcome('InvalidParameter', '입력값이 올바르지 않습니다.', 400);
const missing = outcome('RequireParameter', '필수 입력값이 누락되었습니다.', 400);
const invalidMerchant = outcome('InvalidMerchant', '가맹점 인증에 실패했습니다.', 401);
const unavailable = outcome('Fail', '결제 서비스에 연결할 수 없습니다.', 503);
// https://docs.pay.naver.com/docs/common/http-status-code
function payError(error: unknown, _request: FastifyRequest, reply: FastifyReply) {
  const status = error instanceof Error && 'statusCode' in error ? error.statusCode : 503;
  return send(reply, typeof status === 'number' && status >= 400 && status < 500 ? invalid : unavailable);
}
const credentials = [
  ['x-naver-client-id', 'clientId'],
  ['x-naver-client-secret', 'clientSecret'],
  ['x-naverpay-chain-id', 'chainId'],
] as const;
type CredentialLookup = (request: FastifyRequest, name: string) => string | undefined;
function authenticated(request: FastifyRequest, lookup: CredentialLookup) {
  return credentials.every(([header, name]) => {
    const present = request.headers[header];
    const expected = lookup(request, name);
    return typeof present === 'string' && !!expected && Buffer.byteLength(present) === Buffer.byteLength(expected)
      && timingSafeEqual(Buffer.from(present), Buffer.from(expected));
  });
}

async function payment(client: PoolClient, account: string, id: string) {
  const { rows } = await client.query<PaymentRow>(`
    SELECT pay_hist_id,merchant_pay_key,merchant_transaction_key,product_name,use_date,amount,remaining,
      reserved_at,approved_at,cancellation_count
    FROM naver_virtual.pn09_payment WHERE account_id=$1 AND payment_id=$2 FOR UPDATE
  `, [account, id]);
  return rows[0];
}

// https://docs.pay.naver.com/docs/common/idempotency
// Npay's duplicate 409 returns the original response and echoes the official header.
async function payAttempt(client: PoolClient, account: string, operation: 'approve' | 'cancel', key: string | undefined,
  run: () => Promise<Outcome>,
) {
  if (key === undefined) return run();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['pn09', account, operation, key])]);
  const { rows } = await client.query<{ response: Outcome['response'] }>(
    'SELECT response FROM naver_virtual.pn09_pay_attempt WHERE account_id=$1 AND operation=$2 AND attempt_key=$3',
    [account, operation, key]);
  if (rows[0]) return { status: 409, response: rows[0].response };
  const result = await run();
  await client.query('INSERT INTO naver_virtual.pn09_pay_attempt VALUES ($1,$2,$3,$4)',
    [account, operation, key, JSON.stringify(result.response)]);
  return result;
}

const cancelMessages = {
  AlreadyCanceled: '이미 전체 취소된 결제입니다.',
  OverRemainAmount: '취소 요청 금액이 잔여 결제 금액을 초과합니다.',
  RestAmountDiff: '예상 잔여 금액이 일치하지 않습니다.',
  TaxScopeAmountError: '과세, 면세, 컵 보증금의 합이 취소 금액과 일치하지 않습니다.',
  TaxScopeAmtGreaterThanRemainError: '취소할 수 있는 과면세 금액을 초과합니다.',
};

const newPaymentId = 'PN09BOOKED01';
const settledPaymentId = 'PN09SETTLED01';

const seoulDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
function noticeStatus(endDate: string | undefined, now: Date) {
  return endDate && endDate < seoulDate.format(now) ? { status: 'closed' as const } : {};
}

const recommendationRef = 'recipe-patent-2026';
// Field provenance: https://mybiz.pay.naver.com/subvention/detail/ripc_4956
// Original notice and actual dates: https://pms.ripc.org/pms/biz/applicant/notice/info.do?bizYear=2026&noticeSeq=4956
const recommendation: Recommendation = {
  title: '서울 소상공인 레시피 특허 출원 후속지원',
  officialNoticeUrl: 'https://pms.ripc.org/pms/biz/applicant/notice/info.do?bizYear=2026&noticeSeq=4956',
  startDate: '2026-09-29', endDate: '2026-10-08',
  overview: '음식·음료 레시피의 국내 특허 출원을 사업체당 한 건 지원하는 서울지식재산센터 공고입니다.',
  eligibility: '2026년 서울지식재산센터의 상표출원 또는 IP창출종합패키지 지원을 받은 사업자등록 소상공인 대상입니다.',
  applicationMethod: '지역지식재산센터 사업관리시스템에서 공고를 찾아 온라인으로 신청합니다.',
  documents: ['후속지원 활용계획서'],
};

export const personaCapability: PersonaCapability = {
  id: 'pn09', migrations: [migration],
  async seed(client, { accountId, generation, previousGeneration, now }) {
    if (previousGeneration !== undefined) {
      await client.query('DELETE FROM naver_virtual.pn09_pay_attempt WHERE account_id=$1', [accountId]);
      for (const table of tables.filter(table => table !== 'pn09_pay_attempt')) {
        await client.query(`DELETE FROM naver_virtual.${table} WHERE account_id=$1 AND generation<>$2`, [accountId, generation]);
      }
    }
    const menu = content.menu;
    const latte = menu.find(item => item.name === '카페라떼')!;
    const americano = menu.find(item => item.name === '아메리카노')!;
    const historical = new Date(now.getTime() - 4 * 86_400_000);
    await client.query(`
      INSERT INTO naver_virtual.pn09_payment
      (account_id,generation,payment_id,pay_hist_id,merchant_pay_key,merchant_transaction_key,
       product_name,use_date,amount,remaining,reserved_at,approved_at)
      VALUES ($1,$2,$3,'PN09BOOKED01-A','merchant-order-01','merchant-transaction-01',$4,$11,$5,$5,$6,NULL),
             ($1,$2,$7,'PN09SETTLED01-A','merchant-order-02','merchant-transaction-02',$8,$12,$9,$9-500,$10,$10)
      ON CONFLICT DO NOTHING
    `, [accountId, generation, newPaymentId, latte.name, latte.price, now, settledPaymentId, americano.name,
      americano.price, historical, payDate(now), payDate(historical)]);
    await client.query(`UPDATE naver_virtual.pn09_payment SET cancellation_count=1
      WHERE account_id=$1 AND payment_id=$2`, [accountId, settledPaymentId]);
    const settlement: Settlement = {
      paymentId: settledPaymentId, payHistId: 'PN09SETTLED01-A', merchantPayKey: 'merchant-order-02',
      productName: americano.name, payDate: payDate(historical), settleBasisDate: payDate(historical),
      settleExpectDate: payDate(new Date(historical.getTime() + 2 * 86_400_000)),
      settleCompleteDate: payDate(new Date(historical.getTime() + 2 * 86_400_000)), settleType: '정산',
      paySettleAmount: americano.price, totalCommissionAmount: -90, totalPayCommissionAmount: -90,
      settleExpectAmount: americano.price - 90,
    };
    await client.query('INSERT INTO naver_virtual.pn09_settlement VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [accountId, generation, settledPaymentId, settlement.payHistId, JSON.stringify(settlement)]);
    const cancellationDate = payDate(new Date(now.getTime() - 86_400_000));
    const settledCancellation: Settlement = {
      ...settlement, payHistId: 'PN09SETTLED01-C1', settleType: '정산 후 취소',
      payDate: cancellationDate, settleBasisDate: cancellationDate, settleExpectDate: payDate(now), settleCompleteDate: payDate(now),
      paySettleAmount: -500, totalCommissionAmount: 15, totalPayCommissionAmount: 15, settleExpectAmount: -485,
    };
    await client.query('INSERT INTO naver_virtual.pn09_settlement VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [accountId, generation, settledPaymentId, settledCancellation.payHistId, JSON.stringify(settledCancellation)]);
    await client.query('INSERT INTO naver_virtual.pn09_recommendation VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [accountId, generation, recommendationRef, JSON.stringify(recommendation)]);
  },
  register(app, context) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, raw, done) => done(null, raw));

    // Published merchant routes and forms:
    // https://docs.pay.naver.com/docs/onetime-payment/payment/apply/
    // https://docs.pay.naver.com/docs/onetime-payment/payment/cancel/
    for (const action of ['approve', 'cancel'] as const) {
      app.post(payPaths[action], { config: { personaOperation: 'pn09.pay.' + action }, bodyLimit: 4096,
        errorHandler: payError }, async (request, reply) => {
        if (!authenticated(request, context.providerCredential)) return send(reply, invalidMerchant);
        const formType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        const rawKey = request.headers['x-naverpay-idempotency-key'];
        if (formType !== 'application/x-www-form-urlencoded'
          || (rawKey !== undefined && (typeof rawKey !== 'string' || !rawKey.trim() || rawKey.length > 64 || rawKey.includes(',')))
          || !record(request.query) || Object.keys(request.query).length) return send(reply, invalid);
        if (rawKey !== undefined) reply.header('X-NaverPay-Idempotency-Key', rawKey);
        const cancellation = action === 'cancel' ? parseCancellation(request.body) : null;
        const form = action === 'approve' ? parseApproval(request.body) : cancellation;
        if (!form) return send(reply, formError(action, request.body) === 'RequireParameter' ? missing : invalid);
        const account = context.accountId(request);
        const result = await context.transaction(request, client => payAttempt(client, account, action, rawKey, async () => {
          const row = await payment(client, account, form.paymentId);
          if (action === 'approve') {
            if (!row) return outcome('Fail', '결제 번호를 찾을 수 없습니다.', 404);
            if (row.approved_at) return outcome('AlreadyComplete', '이미 결제가 완료되었습니다.');
            const now = context.now();
            if (now.getTime() - row.reserved_at.getTime() > 600_000) return outcome('TimeExpired', '결제 승인 가능 시간이 지났습니다.');
            await client.query('UPDATE naver_virtual.pn09_payment SET approved_at=$3 WHERE account_id=$1 AND payment_id=$2',
              [account, form.paymentId, now]);
            return success(approvalBody({ paymentId: form.paymentId, payHistId: row.pay_hist_id, amount: row.amount,
              productName: row.product_name, merchantPayKey: row.merchant_pay_key, admissionAt: now,
              merchantPayTransactionKey: row.merchant_transaction_key, useDate: row.use_date }));
          }
          if (!cancellation) return invalid;
          if (!row?.approved_at || (cancellation.merchantPayTransactionKey !== undefined
            && cancellation.merchantPayTransactionKey !== row.merchant_transaction_key)) {
            return outcome('InvalidPaymentId', '승인된 원결제를 찾을 수 없습니다.', 404);
          }
          const code = cancellationResult(cancellation, row.remaining);
          if (code !== 'Success') return outcome(code, cancelMessages[code]);
          const rest = row.remaining - cancellation.cancelAmount;
          const count = row.cancellation_count + 1;
          const history = form.paymentId + '-C' + count;
          await client.query(`
            UPDATE naver_virtual.pn09_payment SET remaining=$3,cancellation_count=$4 WHERE account_id=$1 AND payment_id=$2
          `, [account, form.paymentId, rest, count]);
          return success(cancellationBody(cancellation, history, rest, context.now()));
        }));
        return send(reply, result);
      });
    }
    // https://docs.pay.naver.com/docs/settlement/settlement-api/settle-by-case/
    for (const [selector, column] of [['payment-id', 'payment_id'], ['pay-hist-id', 'pay_hist_id']] as const) {
      app.get(payPaths.settlement + '/' + selector + '/:searchkey', {
        config: { personaOperation: 'pn09.pay.settlement' }, errorHandler: payError,
      }, async (request, reply) => {
        if (!authenticated(request, context.providerCredential)) return send(reply, invalidMerchant);
        const params = request.params;
        const key = record(params) ? params.searchkey : undefined;
        const query = request.query;
        if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 50 || !record(query)
          || Object.keys(query).some(name => name !== 'pageNumber' && name !== 'orderingType')
          || (query.orderingType !== undefined && query.orderingType !== 'DEFAULT' && query.orderingType !== 'PAYMENT_ID_PAY_HIST_ID')) return send(reply, invalid);
        const page = query.pageNumber === undefined ? 1 : Number(query.pageNumber);
        if (query.pageNumber !== undefined && (typeof query.pageNumber !== 'string' || !/^\d+$/.test(query.pageNumber))) {
          return send(reply, invalid);
        }
        if (!Number.isSafeInteger(page) || page < 1 || page > 2147483647) return send(reply, invalid);
        const account = context.accountId(request);
        const body = await context.transaction(request, async client => {
          const { rows } = await client.query<{ projection: Settlement; count: number }>(`
            SELECT projection,COUNT(*) OVER()::int AS count FROM naver_virtual.pn09_settlement
            WHERE account_id=$1 AND ${column}=$2 ORDER BY payment_id,pay_hist_id LIMIT $3 OFFSET $4
          `, [account, key, pageSize, (page - 1) * pageSize]);
          return settlementPage(rows.map(row => row.projection), page, rows[0]?.count ?? 0);
        });
        return send(reply, success(body));
      });
    }

    // Owner recommendation list and detail: https://help.admin.pay.naver.com/faq/content.help?faqId=13148
    // https://mybiz.pay.naver.com/subvention/search
    app.get(financialCenterPath, { config: { personaOperation: 'pn09.financial-center.list' } }, async (request, reply) => {
      if (!record(request.query) || Object.keys(request.query).length) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      return context.transaction(request, async client => {
        const { rows } = await client.query<{ ref: string; projection: Recommendation }>(`
          SELECT ref,projection FROM naver_virtual.pn09_recommendation WHERE account_id=$1 ORDER BY ref
        `, [context.accountId(request)]);
        if (rows.length) reply.header('Link', rows.map(row => '<' + financialCenterPath + '/' + row.ref + '>; rel="item"').join(', '));
        return rows.map(({ projection: { title, officialNoticeUrl, startDate, endDate } }) => ({
          title, officialNoticeUrl, startDate, endDate, ...noticeStatus(endDate, context.now()),
        }));
      });
    });
    app.get(financialCenterPath + '/:ref', { config: { personaOperation: 'pn09.financial-center.read' } }, async (request, reply) => {
      const params = request.params;
      const ref = record(params) ? params.ref : undefined;
      if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ref) || !record(request.query) || Object.keys(request.query).length) {
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      const recommendation = await context.transaction(request, async client => {
        const { rows } = await client.query<{ projection: Recommendation }>(`
          SELECT projection FROM naver_virtual.pn09_recommendation WHERE account_id=$1 AND ref=$2
        `, [context.accountId(request), ref]);
        return rows[0]?.projection;
      });
      return (recommendation && { ...recommendation, ...noticeStatus(recommendation.endDate, context.now()) }) ?? reply.code(404).send({ code: 'NOT_FOUND' });
    });
  },
};
