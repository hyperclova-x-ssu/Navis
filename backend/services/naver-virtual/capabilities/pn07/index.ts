import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { PersonaCapability } from '../../app.ts';
import { campaignAudiences } from '../../../../packages/naver/contracts/pn07/index.ts';
import type { CampaignAudience, CampaignAudiences, CampaignSend } from '../../../../packages/naver/contracts/pn07/index.ts';
import {
  fields, fingerprint, kstDay, oneOf, partnerError, partnerPrefix, ref, shiftDay, text,
} from '../../../../packages/naver/contracts/pn03/partner.ts';
import { registerPartnerErrors, lockAccount, scoped } from '../pn03/partner-db.ts';
import { attachMarketingCoupon, couponLock } from '../pn05/coupons.ts';

const path = `${partnerPrefix}/talktalk/marketing`;

async function readAudiences(client: PoolClient, account: string, today: string) {
  const month = today.slice(0, 7);
  const { rows } = await client.query<{ audience: CampaignAudience; count: number }>(`
    SELECT audience, SUM(observed - excluded_negative)::int AS count FROM naver_virtual.pn07_observations
    WHERE account_id = $1 AND observed_on <= $2 AND (audience = 'benefit-subscribers'
      OR observed_on >= ($2::date - INTERVAL '3 months')::date)
    GROUP BY audience
  `, [account, today]);
  const { rows: [quota] } = await client.query<{ assigned: number }>(`
    SELECT SUM(assigned)::int AS assigned FROM naver_virtual.pn07_quota
    WHERE account_id = $1 AND month = $2 AND assigned_on <= $3
    HAVING COUNT(*) > 0
  `, [account, month, today]);
  return {
    eligible: new Map(rows.map(row => [row.audience, row.count])),
    response: {
      items: campaignAudiences.map(audience => ({ audience })),
      ...(quota ? { quota: { month, assigned: quota.assigned } } : {}),
    } satisfies CampaignAudiences,
  };
}

export const personaCapability: PersonaCapability = {
  id: 'pn07',
  migrations: [{
    id: '20261123000700_pn07_campaigns',
    up: `
      CREATE TABLE naver_virtual.pn07_observations (
        account_id text NOT NULL,
        audience text NOT NULL CHECK (audience IN ('benefit-subscribers','recent-visitor-reviewers')),
        observed_on date NOT NULL, observed integer NOT NULL CHECK (observed >= 0),
        excluded_negative integer NOT NULL CHECK (excluded_negative BETWEEN 0 AND observed),
        PRIMARY KEY (account_id, audience, observed_on)
      );
      CREATE TABLE naver_virtual.pn07_quota (
        account_id text NOT NULL, month text NOT NULL, assigned_on date NOT NULL, assigned integer NOT NULL CHECK (assigned >= 0),
        PRIMARY KEY (account_id, month, assigned_on)
      );
      CREATE TABLE naver_virtual.pn07_campaigns (
        account_id text NOT NULL, ref text NOT NULL, month text NOT NULL, eligible integer NOT NULL CHECK (eligible > 0),
        PRIMARY KEY (account_id, ref)
      );
      CREATE INDEX pn07_campaign_period ON naver_virtual.pn07_campaigns (account_id, month);
      ${scoped('pn07_observations', 'SELECT')}
      ${scoped('pn07_quota', 'SELECT')}
      ${scoped('pn07_campaigns', 'SELECT, INSERT')}
    `,
    down: 'DROP TABLE naver_virtual.pn07_campaigns, naver_virtual.pn07_quota, naver_virtual.pn07_observations',
  }],
  async seed(client, { accountId, now, previousGeneration }) {
    if (previousGeneration) {
      await client.query('DELETE FROM naver_virtual.pn07_campaigns WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn07_quota WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn07_observations WHERE account_id = $1', [accountId]);
    }
    const today = kstDay(now);
    const month = today.slice(0, 7);
    const monthStart = `${month}-01`;
    // Explicit synthetic observations and assignments. Reviewer counts represent distinct visitors.
    await client.query(`
      INSERT INTO naver_virtual.pn07_observations VALUES
        ($1,'benefit-subscribers',$2,10,0), ($1,'benefit-subscribers',$3,2,0),
        ($1,'recent-visitor-reviewers',$4,5,1), ($1,'recent-visitor-reviewers',$5,3,1),
        ($1,'recent-visitor-reviewers',$6,7,0)
      ON CONFLICT DO NOTHING
    `, [accountId, monthStart, shiftDay(today, 1), shiftDay(today, -10), shiftDay(today, -2), shiftDay(today, -100)]);
    if (today !== monthStart) {
      await client.query(`
        INSERT INTO naver_virtual.pn07_observations VALUES ($1,'benefit-subscribers',$2,2,0) ON CONFLICT DO NOTHING
      `, [accountId, today]);
    }
    await client.query(`
      INSERT INTO naver_virtual.pn07_quota VALUES ($1,$2,$3,16) ON CONFLICT DO NOTHING
    `, [accountId, month, monthStart]);
    if (today !== monthStart) {
      await client.query('INSERT INTO naver_virtual.pn07_quota VALUES ($1,$2,$3,2) ON CONFLICT DO NOTHING',
        [accountId, month, today]);
    }
    const tomorrow = shiftDay(today, 1);
    if (tomorrow.startsWith(month)) {
      await client.query('INSERT INTO naver_virtual.pn07_quota VALUES ($1,$2,$3,2) ON CONFLICT DO NOTHING',
        [accountId, month, tomorrow]);
    }
    const nextMonthStart = new Date(monthStart + 'T00:00:00Z');
    nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1);
    const nextMonthDay = nextMonthStart.toISOString().slice(0, 10);
    await client.query('INSERT INTO naver_virtual.pn07_quota VALUES ($1,$2,$3,20) ON CONFLICT DO NOTHING',
      [accountId, nextMonthDay.slice(0, 7), nextMonthDay]);
  },
  register(app, context) {
    registerPartnerErrors(app);
    // TalkTalk marketing 20507. The owner can read only the provider's two groups and assigned quota.
    app.get(`${path}/audiences`, { config: { personaOperation: 'pn07.audiences.list' } }, (request) => {
      fields(request.query, []);
      return context.transaction(request, async (client) => (await readAudiences(client, context.accountId(request), kstDay(context.now()))).response);
    });

    // TalkTalk marketing 20507, benefit-tab exposure and coupon attachment 21111.
    app.post(`${path}/sends`, { config: { personaOperation: 'pn07.sends.create' } }, async (request, reply) => {
      fields(request.query, []);
      const body = fields(request.body, ['audience', 'title', 'body'], ['couponRef']);
      const input: CampaignSend = {
        audience: oneOf(body.audience, campaignAudiences), title: text(body.title, Infinity), body: text(body.body, Infinity),
        ...(body.couponRef === undefined ? {} : { couponRef: ref(body.couponRef) }),
      };
      const account = context.accountId(request);
      const now = context.now();
      const today = kstDay(now);
      await context.effect(request, fingerprint(input), async (client) => {
        await lockAccount(client, 'pn07-campaigns', account);
        const { eligible, response: { quota } } = await readAudiences(client, account, today);
        const eligibleCount = eligible.get(input.audience);
        if (!eligibleCount || !quota?.assigned) partnerError(409, '발송할 수 있는 대상을 확인해 주세요.');
        if (input.couponRef) {
          await lockAccount(client, couponLock, account);
          await attachMarketingCoupon(client, account, input.couponRef, now);
        }
        const campaignRef = randomUUID();
        await client.query(`INSERT INTO naver_virtual.pn07_campaigns (account_id, ref, month, eligible)
          VALUES ($1, $2, $3, $4)`, [account, campaignRef, quota.month, eligibleCount]);
        return campaignRef;
      });
      return reply.code(204).send();
    });
  },
};
