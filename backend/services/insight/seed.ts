import type { Pool } from 'pg';
import manifest from '../../../frontend/src/data/db/generated/manifest.json' with { type: 'json' };
import { seedSupplement } from '../../../frontend/src/data/db/generated/supplement.ts';
import { createSeedContext } from '../../packages/db/seed-context.ts';
import { groupSeedRows, historyForSeed, insertSeedRows, seedId, seoulSeedTime } from '../../packages/db/seed-history.ts';
import { demoIdentity } from '../account/identity.ts';
import { fingerprint, inStore } from './scope.ts';

export async function seed(pool: Pool, context = createSeedContext()) {
  const { storeId } = demoIdentity;
  const store = { store_id: storeId };
  const { name, address, hours } = manifest.store;
  const storeHours = `평일 ${hours.mon.join('~')} · 토요일 ${hours.sat.join('~')} · 일요일 ${hours.sun.join('~')}`;
  const sales = historyForSeed(context).filter(sale => sale.at !== null);
  await inStore(pool, storeId, async db => {
    await insertSeedRows(db, 'insight.sales_recognition',
      'store_id, settlement_id, business_date, sale_hour, amount, fingerprint', sales.map(sale => {
        const businessDate = sale.businessDate;
        const saleHour = Number(seoulSeedTime(sale.at!).slice(11, 13));
        const amount = sale.quote.payable;
        const lines = sale.lines.map(line => ({ allocationId: line.allocationId, menuId: line.menuId, quantity: line.qty }))
          .sort((a, b) => a.allocationId.localeCompare(b.allocationId));
        return { ...store, settlement_id: sale.settlementId, business_date: businessDate, sale_hour: saleHour,
          amount, fingerprint: fingerprint({ businessDate, saleHour, amount, lines }) };
      }));
    await insertSeedRows(db, 'insight.sales_line', 'store_id, settlement_id, allocation_id, menu_id, quantity',
      sales.flatMap(sale => sale.lines.map(line => ({
        ...store, settlement_id: sale.settlementId, allocation_id: line.allocationId, menu_id: line.menuId, quantity: line.qty,
      }))));
    const corrections = sales.filter(sale => sale.correction);
    await insertSeedRows(db, 'insight.sales_correction', 'store_id, correction_id, settlement_id, amount_delta, fingerprint',
      corrections.map(({ correction, settlementId, businessDate, changes }) => {
        const { correction_id, kind, amount } = correction!;
        const lines = changes.map(({ allocationId, menuId, quantity }) => ({ allocationId, menuId, quantity }))
          .sort((a, b) => a.allocationId.localeCompare(b.allocationId));
        return { ...store, correction_id, settlement_id: settlementId, amount_delta: -amount,
          fingerprint: fingerprint({ settlementId, businessDate, kind, amountDelta: -amount, lines }) };
      }));
    await insertSeedRows(db, 'insight.sales_restoration', 'store_id, settlement_id, correction_id, allocation_id, quantity',
      corrections.filter(sale => sale.correction!.kind === 'cancel').flatMap(sale => sale.changes.map(line => ({
        ...store, settlement_id: sale.settlementId, correction_id: sale.correction!.correction_id,
        allocation_id: line.allocationId, quantity: line.quantity,
      }))));
    const steps = groupSeedRows(context.rows.manual_step as Array<{ manual_id: string; body: string }>, step => step.manual_id);
    const manuals = await insertSeedRows(db, 'insight.manuals_grants_record', 'store_id, id, kind, data, revision, updated_at',
      [...(context.rows.manual as Array<{ manual_id: string; section: string; category: string; title: string;
        cautions: string; is_published: boolean; updated_at: string }>).map(manual => ({
        ...store, id: manual.manual_id, kind: 'manual', revision: 1, updated_at: manual.updated_at,
        data: { section: manual.section, category: manual.category, title: manual.title, body: '',
          cautions: manual.cautions, isPublished: manual.is_published, checklistVersion: 1,
          checklist: ['opening', 'closing'].includes(manual.category),
          steps: steps.get(manual.manual_id)?.map(step => ({ body: step.body })) ?? [] },
      })), {
        ...store, id: seedId('cafe-store-guide'), kind: 'manual', revision: 1, updated_at: context.cutoff,
        data: {
          section: 'store-info', category: 'store-info', title: '영업시간 및 운영 정보', body: '', cautions: '',
          isPublished: true, checklistVersion: 1, checklist: false,
          steps: [{ body: `${name}\n${address}\n영업시간 ${storeHours}` }],
        },
      }]);
    if (manuals) await db.query(`
      INSERT INTO insight.manuals_grants_revision (store_id, revision)
      VALUES ($1, 1) ON CONFLICT (store_id) DO UPDATE SET revision = insight.manuals_grants_revision.revision + 1
    `, [storeId]);
    await insertSeedRows(db, 'insight.environment_reading', 'store_id, reading_id, measured_at, temperature_c, humidity_pct',
      seedSupplement.environment.map(reading => ({
        ...store, reading_id: seedId(reading.id), measured_at: context.cutoff,
        temperature_c: reading.temperature, humidity_pct: reading.humidity,
      })));
  });
}
