import type { Pool, PoolClient } from 'pg';
import content from '../../../db/seed/ansungjalbu/content.json' with { type: 'json' };
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import { seedSupplement } from '../../../frontend/src/data/db/generated/supplement.ts';
import type { PosRecipePart } from '../../../frontend/src/contracts/pos';
import { createSeedContext, type SeedContext } from '../../packages/db/seed-context.ts';
import { historyForSeed, insertSeedRows, seedId, seoulSeedTime, type SeedDay } from '../../packages/db/seed-history.ts';
import { eventLine } from '../pos/catalog.ts';
import { menuSeedFileId } from './reality/01/menu-photo-seed.ts';
import { saveRecipeVersion } from './recipes.ts';
import { withStoreTransaction } from './store-transaction.ts';

export const syntheticStoreId = '33123a19-6780-4d38-9bca-ce96efcf8559';
export const syntheticReceiptLineId = '33123a19-6780-4d38-9bca-ce96efcf8557';

interface MenuSeedRow {
  store_id: string;
  menu_id: string;
  kind: 'menu' | 'retail';
  name: string;
  category: 'drink' | 'dessert' | 'retail';
  price: number;
  sale_status: 'selling' | 'sold_out';
  inventory_item_id: string | null;
  deleted_at: string | null;
}

const menuCategories = {
  커피: 'coffee', 티: 'tea', 논커피: 'beverage', 에이드: 'beverage', 디저트: 'dessert',
} as const;

function canonicalSeedCategory(menu: typeof content.menu[number]) {
  if (menu.id === 'm-yuja-chamomile') return 'tea';
  if (menu.category === '시즌') return 'beverage';
  const category = menuCategories[menu.category as keyof typeof menuCategories];
  if (!category) throw new Error('Unknown café seed menu category');
  return category;
}

export async function seed(pool: Pool, context = { ...createSeedContext(), operatingHistory: false }): Promise<void> {
  const { rows, businessDate, archivedMenuIds, operatingHistory } = context;
  const days = (rows.business_day as SeedDay[]).filter(day => operatingHistory || day.business_date === businessDate);
  // The JS generator infers empty row arrays from its dynamic table registry.
  const cafeId = (rows.store[0] as { store_id: string }).store_id;
  const menuRows: MenuSeedRow[] = rows.menu_item;
  const menuIds = new Map<string, string>(seedCatalog.menu.map(menu => [menu.dbId, menu.menuId]));
  const contentMenus = new Map(content.menu.map(menu => [menu.id, menu]));
  const { businessDayStart, timezone } = seedCatalog.store;
  const catalogItems = new Map<string, (typeof seedCatalog.items)[number]>(seedCatalog.items.map((item) => [item.itemId, item]));
  const legacyPhotoKeys: Readonly<Record<string, string>> = {
    'm-americano': 'menu-photo-01',
    'm-cafe-latte': 'menu-photo-03',
  };

  await withStoreTransaction(pool, cafeId, async (client) => {
    await client.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [cafeId]);
    await client.query(`
      INSERT INTO inventory.business_day (store_id, business_date, starts_at, ends_at)
      SELECT $1, d.business_date, (d.business_date + $3::time) AT TIME ZONE $4,
        (d.business_date + 1 + $3::time) AT TIME ZONE $4
      FROM jsonb_to_recordset($2::jsonb) d(business_date date)
      ON CONFLICT DO NOTHING
    `, [cafeId, JSON.stringify(days), businessDayStart, timezone]);
    const itemData = new Map((rows.inventory_item as { item_id: string; restock_threshold: number }[])
      .map(item => [item.item_id, item]));
    const ingredients = seedCatalog.items.map((item) => ({
      ...itemData.get(item.dbId)!, store_id: cafeId,
      recipe_key: item.itemId, base_unit: item.unitDimension,
      threshold_base: itemData.get(item.dbId)!.restock_threshold,
    }));
    const itemColumns = 'store_id, item_id, recipe_key, base_unit';
    await insertSeedRows(client, 'inventory.inventory_item', operatingHistory
      ? itemColumns + ', sku, name, display_unit, threshold_base, track_restock, track_expiry, updated_at'
      : itemColumns, ingredients);
    if (operatingHistory) await client.query(`
      UPDATE inventory.inventory_item i SET sku = seed.sku, name = seed.name,
        display_unit = coalesce(i.display_unit, seed.display_unit), threshold_base = coalesce(i.threshold_base, seed.threshold_base),
        track_restock = seed.track_restock, track_expiry = seed.track_expiry, updated_at = seed.updated_at
      FROM jsonb_to_recordset($2::jsonb) seed(item_id uuid, sku text, name text, display_unit text,
        threshold_base bigint, track_restock boolean, track_expiry boolean, updated_at timestamptz)
      WHERE i.store_id = $1 AND i.item_id = seed.item_id AND i.revision = 1
        AND i.sku IS NULL AND i.name IS NULL AND i.archived_at IS NULL
    `, [cafeId, JSON.stringify(ingredients)]);
    const { rows: [categorySchema] } = await client.query<{ migrated: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'inventory' AND table_name = 'menu_item' AND column_name = 'seasonal') AS migrated
    `);
    const menuColumns = 'store_id, menu_id, kind, name, category, price, sale_status, inventory_item_id, deleted_at';
    const classifiedMenus = menuRows.map(row => {
      const menu = contentMenus.get(menuIds.get(row.menu_id) ?? '');
      return menu ? { ...row, category: canonicalSeedCategory(menu), seasonal: menu.seasonal } : row;
    });
    await insertSeedRows(client, 'inventory.menu_item', menuColumns + (categorySchema.migrated ? ', seasonal' : ''),
      categorySchema.migrated ? classifiedMenus : menuRows);
    if (categorySchema.migrated) await client.query(`
      UPDATE inventory.menu_item AS existing SET category = incoming.category, seasonal = incoming.seasonal
      FROM jsonb_to_recordset($2::jsonb) incoming(menu_id uuid, name text, category text, seasonal text)
      WHERE existing.store_id = $1 AND existing.menu_id = incoming.menu_id
        AND existing.category = 'drink' AND existing.seasonal IS NULL AND existing.revision = 1
        AND existing.name = incoming.name AND existing.deleted_at IS NULL
    `, [cafeId, JSON.stringify(classifiedMenus)]);
    for (const menu of seedCatalog.menu) {
      if (archivedMenuIds.includes(menu.dbId)) continue;
      await saveRecipeVersion(client, cafeId, menu.dbId, menu.dbId, menu.recipeBase, { seed: true });
      for (const group of menu.groups) {
        for (const option of group.options) {
          await saveRecipeVersion(client, cafeId, menu.dbId, option.optionId, option.extraRecipe, { seed: true });
        }
      }
      const recipeLines = menu.recipeBase.map((part) => {
        const item = catalogItems.get(part.itemId)!;
        const multiplier = item.displayUnit === 'L' || item.displayUnit === 'kg' ? 1000 : 1;
        return { recipeLineId: item.dbId, itemId: item.dbId, quantity: part.quantityBase / multiplier, unit: item.displayUnit };
      });
      const groups = menu.groups.map(({ groupId, name, required, options }) => ({
        groupId, name, required, menuId: menu.dbId,
        options: options.map(({ optionId, name, extraPrice, extraRecipe }) => ({
          optionId, groupId, name, extraPrice,
          extraRecipe: (extraRecipe as readonly PosRecipePart[]).map(part => ({ ...part, itemId: catalogItems.get(part.itemId)!.dbId })),
        })),
      }));
      await client.query(`
        UPDATE inventory.menu_item
        SET memo = $3, prep_min = $4, recipe_lines = $5, option_groups = $6
        WHERE store_id = $1 AND menu_id = $2 AND revision = 1 AND recipe_lines IS NULL
      `, [cafeId, menu.dbId, menu.memo, menu.prepMin,
        JSON.stringify(recipeLines), JSON.stringify(groups)]);
      // Upgrade the old fixture photos on reseed while preserving owner edits.
      await client.query(`
        UPDATE inventory.menu_item SET photo_file_id = $3, photo_key = NULL
        WHERE store_id = $1 AND menu_id = $2 AND revision = 1 AND deleted_at IS NULL
          AND photo_file_id IS NULL AND (photo_key IS NULL OR photo_key = $4)
      `, [cafeId, menu.dbId, menuSeedFileId(cafeId, menu.menuId), legacyPhotoKeys[menu.menuId] ?? null]);
    }

    if (operatingHistory) {
      await seedStockHistory(client, cafeId, context);
      await insertSeedRows(client, 'inventory.stock_batch',
        'store_id, batch_id, item_id, quantity_base, remaining_base, expires_on, received_at',
        seedSupplement.expiryBatches.map(lot => ({
          store_id: cafeId, batch_id: seedId(lot.id), item_id: catalogItems.get(lot.itemId)!.dbId,
          quantity_base: lot.quantityBase, remaining_base: lot.quantityBase, expires_on: businessDate, received_at: context.cutoff,
        })));
    } else {
      await insertSeedRows(client, 'inventory.stock_daily_opening', 'store_id, business_date, item_id, channel, quantity_base',
        (rows.stock_daily_opening as { business_date: string }[]).filter(opening => opening.business_date === businessDate));
    }

    const milk = seedCatalog.items.find((item) => item.itemId === 'i-milk')!;
    const supplier = seedCatalog.suppliers.find((item) => item.dbId === milk.purchase.supplierDbId)!;
    const poId = '33123a19-6780-4d38-9bca-ce96efcf8558';
    await client.query(`
      INSERT INTO inventory.supplier (store_id, supplier_id, name)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
    `, [cafeId, supplier.dbId, supplier.name]);
    if (operatingHistory) {
      const suppliers = content.suppliers.map(source => ({
        supplier_id: seedCatalog.suppliers.find(row => row.supplierId === source.id)!.dbId,
        contact: source.test_contact.email, phone: source.test_contact.phone,
        memo: `${source.test_contact.name} · 시험용 연락처`,
      }));
      await client.query(`
        UPDATE inventory.supplier AS existing SET contact = seed.contact, phone = seed.phone, memo = seed.memo
        FROM jsonb_to_recordset($2::jsonb) seed(supplier_id uuid, contact text, phone text, memo text)
        WHERE existing.store_id = $1 AND existing.supplier_id = seed.supplier_id
          AND existing.archived_at IS NULL AND existing.revision = 1
          AND existing.contact IS NULL AND existing.phone IS NULL AND existing.memo IS NULL
      `, [cafeId, JSON.stringify(suppliers)]);
    }
    await client.query(`
      INSERT INTO inventory.purchase_order (store_id, po_id, supplier_id, ordered_on)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
    `, [cafeId, poId, supplier.dbId, businessDate]);
    await client.query(`
      INSERT INTO inventory.purchase_order_line
        (store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price)
      VALUES ($1, $2, $3, $4, 10, $5, $6, $7) ON CONFLICT DO NOTHING
    `, [cafeId, syntheticReceiptLineId, poId, milk.dbId, milk.purchase.unit, milk.purchase.basePerUnit, milk.purchase.unitPrice]);
  });

  await withStoreTransaction(pool, syntheticStoreId, async (client) => {
    await client.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [syntheticStoreId]);
    await client.query(`
      INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status)
      VALUES ($1, '33123a19-6780-4d38-9bca-ce96efcf8561', 'menu', 'Synthetic store tea', 'drink', 3100, 'sold_out')
      ON CONFLICT DO NOTHING
    `, [syntheticStoreId]);
  });
}

async function seedStockHistory(db: PoolClient, storeId: string, context: SeedContext) {
  const { rows, cutoff } = context;
  await insertSeedRows(db, 'inventory.stock_daily_opening',
    'store_id, business_date, item_id, channel, quantity_base', rows.stock_daily_opening);
  await insertSeedRows(db, 'inventory.supplier', 'store_id, supplier_id, name', rows.supplier);
  // The operational terms table accepts dimension units only. Historical PO
  // lines retain the generator's per-can multiplier and exact won price.
  const purchaseItems = (rows.purchase_item as Array<{ purchase_unit: string; base_per_unit: number }>)
    .filter(term => term.base_per_unit === (['kg', 'L'].includes(term.purchase_unit) ? 1000 : 1));
  await insertSeedRows(db, 'inventory.purchase_item',
    'store_id, purchase_item_id, item_id, supplier_id, purchase_unit, base_per_unit, minimum_qty, order_step, unit_price, lead_days',
    purchaseItems);
  const orders = (rows.purchase_order as { po_id: string; created_at: string }[]).filter(order => order.created_at <= cutoff);
  const orderIds = new Set(orders.map(order => order.po_id));
  await insertSeedRows(db, 'inventory.purchase_order',
    'store_id, po_id, supplier_id, ordered_on, due_date, expected_time', orders);
  await insertSeedRows(db, 'inventory.purchase_order_line',
    'store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price, item_name_snapshot',
    (rows.purchase_order_line as { po_id: string }[]).filter(line => orderIds.has(line.po_id)));
  await insertSeedRows(db, 'inventory.goods_receipt',
    'store_id, receipt_id, pol_id, qty, qty_remaining, received_at, idempotency_key',
    (rows.goods_receipt as { received_at: string; qty: number }[]).filter(receipt => receipt.received_at <= cutoff)
      .map(receipt => ({ ...receipt, qty_remaining: receipt.qty })));
  await insertSeedRows(db, 'inventory.stock_movement',
    'store_id, movement_id, item_id, business_date, kind, delta_base, channel, receipt_id, at, reason',
    (rows.stock_movement as { at: string }[]).filter(move => move.at <= cutoff).map(move => ({
      ...move, business_date: seoulSeedTime(move.at).slice(0, 10),
    })));

  const recipes = new Map<string, Array<{ item_id: string; quantity_base: number }>>();
  for (const recipe of rows.recipe_line as { menu_id: string; inventory_item_id: string; quantity_base: number }[]) {
    const ingredients = recipes.get(recipe.menu_id) ?? [];
    ingredients.push({ item_id: recipe.inventory_item_id, quantity_base: recipe.quantity_base });
    recipes.set(recipe.menu_id, ingredients);
  }
  const sales = historyForSeed(context).filter(sale => sale.at !== null);
  const base = (sale: typeof sales[number]) => ({
    billId: sale.bill.bill_id, orderId: sale.order.order_id, settlementId: sale.settlementId,
    businessDate: sale.businessDate, ...(sale.payment && { paymentId: sale.payment.payment_id }),
    ...(sale.bill.member_id && { memberId: sale.bill.member_id }),
  });
  await insertSeedRows(db, 'inventory.sale_usage', 'store_id, settlement_id, business_date, sale, recorded_at',
    sales.map(sale => ({
      store_id: storeId, settlement_id: sale.settlementId, business_date: sale.businessDate, recorded_at: sale.at,
      sale: { ...base(sale), lines: sale.lines.map(line => eventLine(line, line.qty)),
        amount: sale.quote.payable, cost: sale.cost, incompleteMarginCoverage: false },
    })));
  await insertSeedRows(db, 'inventory.sale_usage_line',
    'store_id, settlement_id, allocation_id, line_identity, recognized_quantity, restored_quantity, ingredients',
    sales.flatMap(sale => sale.lines.map(line => {
      const { allocationId, quantity, ...identity } = eventLine(line, line.qty);
      return { store_id: storeId, settlement_id: sale.settlementId, allocation_id: allocationId, line_identity: identity,
        recognized_quantity: quantity, restored_quantity: sale.correction?.kind === 'cancel' ? quantity : 0,
        ingredients: recipes.get(line.menuId) ?? [] };
    })));
  await insertSeedRows(db, 'inventory.sale_usage_correction', 'store_id, correction_id, settlement_id, correction, recorded_at',
    sales.flatMap(sale => sale.correction ? [{
      store_id: storeId, correction_id: sale.correction.correction_id, settlement_id: sale.settlementId, recorded_at: sale.correction.at,
      correction: { ...base(sale), correctionId: sale.correction.correction_id, kind: sale.correction.kind, target: 'recognized_sale',
        usageEffect: sale.correction.kind === 'cancel' ? 'restore' : 'keep', amountDelta: -sale.correction.amount,
        costDelta: sale.changes.reduce((sum, line) => sum + line.cost, 0),
        lines: sale.changes.map(({ allocationId, orderLineId, menuId, recipeVersion, options, quantity }) =>
          ({ allocationId, orderLineId, menuId, recipeVersion, options, quantity })), incompleteMarginCoverage: false },
    }] : []));
}
