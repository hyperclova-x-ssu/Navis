import type { PersonaCapability } from '../../app.ts';
import { registerPartnerErrors, scoped } from '../pn03/partner-db.ts';
import { registerCoupons, seedCoupons } from './coupons.ts';
import { registerMembership } from './membership.ts';
import { registerPromotions, seedPromotions } from './promotions.ts';

export const personaCapability: PersonaCapability = {
  id: 'pn05',
  migrations: [{
    id: '20261123000500_pn05_benefits',
    up: `
      CREATE TABLE naver_virtual.pn05_place_coupons (
        account_id text NOT NULL, ref text NOT NULL,
        coupon_type text NOT NULL CHECK (coupon_type IN ('place','booking','order')),
        name text NOT NULL, benefit jsonb NOT NULL,
        audience text NOT NULL CHECK (audience IN ('all','benefit-subscribers','marketing-message')),
        display_from date, display_to date, quantity integer CHECK (quantity > 0), conditions text,
        created_at timestamptz NOT NULL, deleted_at timestamptz, last_sent_at timestamptz,
        PRIMARY KEY (account_id, ref),
        CHECK ((display_from IS NULL AND display_to IS NULL) OR (display_from IS NOT NULL AND display_to >= display_from)),
        CHECK (audience <> 'marketing-message' OR (display_from IS NULL AND display_to IS NULL AND quantity IS NULL))
      );
      CREATE INDEX pn05_coupon_exposure ON naver_virtual.pn05_place_coupons (account_id, display_from, display_to)
        WHERE deleted_at IS NULL AND audience <> 'marketing-message';
      CREATE TABLE naver_virtual.pn05_place_issues (
        account_id text NOT NULL, ref text NOT NULL, coupon_ref text NOT NULL, masked_number text NOT NULL,
        issued_on date NOT NULL, expires_on date NOT NULL CHECK (expires_on >= issued_on), used boolean NOT NULL,
        PRIMARY KEY (account_id, ref),
        FOREIGN KEY (account_id, coupon_ref) REFERENCES naver_virtual.pn05_place_coupons (account_id, ref)
      );
      CREATE INDEX pn05_issues_view ON naver_virtual.pn05_place_issues (account_id, coupon_ref, issued_on DESC, ref);
      CREATE TABLE naver_virtual.pn05_order_promotions (
        account_id text NOT NULL, ref text NOT NULL, name text NOT NULL,
        starts_on date NOT NULL, ends_on date NOT NULL CHECK (ends_on >= starts_on), ended_at timestamptz,
        amount_per_stamp integer NOT NULL CHECK (amount_per_stamp BETWEEN 1000 AND 99999999), coupons jsonb NOT NULL,
        instructions text, PRIMARY KEY (account_id, ref)
      );
      CREATE INDEX pn05_promotion_period ON naver_virtual.pn05_order_promotions (account_id, starts_on DESC, ref);
      CREATE TABLE naver_virtual.pn05_membership_benefits (
        account_id text NOT NULL, ref text NOT NULL,
        provider text NOT NULL CHECK (provider IN ('도도포인트','OKPOS 단골플러스','페이히어')),
        type text NOT NULL CHECK (type IN ('points','stamps','coupon')), benefit text NOT NULL,
        valid_days integer CHECK (valid_days > 0), visible boolean, paused boolean,
        issued integer CHECK (issued >= 0), used integer CHECK (used BETWEEN 0 AND issued),
        PRIMARY KEY (account_id, ref), CHECK (paused IS NULL OR provider = '페이히어')
      );
      ${scoped('pn05_place_coupons', 'SELECT, INSERT, UPDATE')}
      ${scoped('pn05_place_issues', 'SELECT, UPDATE')}
      ${scoped('pn05_order_promotions', 'SELECT, INSERT, UPDATE')}
      ${scoped('pn05_membership_benefits', 'SELECT, UPDATE')}
    `,
    down: 'DROP TABLE naver_virtual.pn05_membership_benefits, naver_virtual.pn05_order_promotions, naver_virtual.pn05_place_issues, naver_virtual.pn05_place_coupons',
  }, {
    id: '20261123000501_pn05_drop_membership_counters',
    up: 'ALTER TABLE naver_virtual.pn05_membership_benefits DROP COLUMN issued, DROP COLUMN used',
    down: 'ALTER TABLE naver_virtual.pn05_membership_benefits ADD COLUMN issued integer CHECK (issued >= 0), ADD COLUMN used integer CHECK (used BETWEEN 0 AND issued)',
  }],
  async seed(client, { accountId, now, previousGeneration }) {
    if (previousGeneration) {
      await client.query('DELETE FROM naver_virtual.pn05_place_issues WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn05_place_coupons WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn05_order_promotions WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn05_membership_benefits WHERE account_id = $1', [accountId]);
    }
    await seedCoupons(client, accountId, now);
    await seedPromotions(client, accountId, now);
    // Navis is the cafe POS. Only the three named membership products can supply their own rows (1100).
  },
  register(app, context) {
    registerPartnerErrors(app);
    registerCoupons(app, context);
    registerPromotions(app, context);
    registerMembership(app, context);
  },
};
