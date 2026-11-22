import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { createSeedContext } from '../../../../packages/db/seed-context.ts';
import { seedCoupons } from './seed.ts';

it('imports enough issued coupons to account for each code’s recognized redemptions at the gate cutoff', async () => {
  const context = createSeedContext({ now: new Date('2026-11-22T03:00:00Z') });
  const codes = new Map<string, number>();
  const used = new Map<string, number>();
  const db = {
    async query(sql: string, values: string[]) {
      if (sql.includes('INSERT INTO marketing.coupon_code (')) {
        const rows: { code_id: string; issue_count: number }[] = JSON.parse(values[0]!);
        for (const row of rows) codes.set(row.code_id, row.issue_count);
      }
      if (sql.includes('INSERT INTO marketing.coupon_redemption (')) {
        const rows: { code_id: string; state: string }[] = JSON.parse(values[0]!);
        for (const row of rows) if (row.state === 'committed') used.set(row.code_id, (used.get(row.code_id) ?? 0) + 1);
      }
      return { rowCount: 0 };
    },
  } as unknown as PoolClient;
  await seedCoupons(db, '11111111-1111-4111-8111-111111111111', context);

  expect(used.size).toBeGreaterThan(0);
  for (const [codeId, redemptions] of used) expect(codes.get(codeId)).toBeGreaterThanOrEqual(redemptions);
});
