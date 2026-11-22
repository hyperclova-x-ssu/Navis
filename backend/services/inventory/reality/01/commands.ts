import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { saveRecipeComponents } from '../../recipes.ts';
import { readMenuState, type MenuRow, type MenuState } from './read.ts';
import { category as menuCategory, MenuError, recipePart, type IngredientPart, type MenuCommand, type MenuPatch, type OptionGroup } from './wire.ts';

export type VerifyMenuPhoto = (input: { storeId: string; actorId: string; fileId: string }) => Promise<boolean>;
type CommandContext = { storeId: string; actorId: string; key: string; now: () => Date; verifyPhoto?: VerifyMenuPhoto };

type Receipt = {
  resourceId: string; revision: number; receiptId: string; undoUntil?: string;
  affectedSources: string[]; changed: boolean;
};
type RecipePointer = { component_id: string; version: string };
type Inverse = { state: MenuState; recipes: RecipePointer[] } | { created: true };
type Applied = { fingerprint: string; result: Receipt; inverse: Inverse | null };
type Operation = 'created' | 'updated' | 'archived' | 'restored';
type Effect = { menuId: string; revision: number; operation?: Operation; inverse?: Inverse };

const undoMs = 6000;
const affectedSources = ['menu', 'pos', 'stock', 'margin', 'marketing', 'insight'];

function normalizedName(name: string) {
  return name.normalize('NFKC').replace(/[\s·・.,'"\-_()[\]{}]+/g, '').toLowerCase();
}

async function checkName(db: PoolClient, storeId: string, name: string, menuId: string) {
  const normalized = normalizedName(name);
  if (!normalized) throw new MenuError(400, 'MENU_NAME_REQUIRED', 'name');
  const { rows } = await db.query<{ name: string }>(`
    SELECT name FROM inventory.menu_item
    WHERE store_id = $1 AND menu_id <> $2 AND kind = 'menu' AND deleted_at IS NULL
  `, [storeId, menuId]);
  if (rows.some(row => normalizedName(row.name) === normalized)) throw new MenuError(409, 'NAME_EXISTS', 'name');
}

async function checkPhoto(ctx: CommandContext, fileId: string) {
  if (!ctx.verifyPhoto) throw new MenuError(503, 'PHOTO_SERVICE_UNAVAILABLE', 'photoFileId');
  if (!await ctx.verifyPhoto({ storeId: ctx.storeId, actorId: ctx.actorId, fileId })) {
    throw new MenuError(404, 'PHOTO_NOT_FOUND', 'photoFileId');
  }
}

function applyPatch(current: MenuState, patch: MenuPatch): MenuState {
  const state = { ...current, ...patch };
  if (patch.category !== undefined) state.category = menuCategory(patch.category);
  if (patch.photoKey !== undefined || patch.photoFileId !== undefined) {
    state.photoKey = patch.photoKey ?? null;
    state.photoFileId = patch.photoFileId ?? null;
  }
  return state;
}

function retainArchivedOptions(current: OptionGroup[], next: OptionGroup[], at: string): OptionGroup[] {
  const groups = new Map(next.map(group => [group.groupId, group]));
  for (const group of current) {
    const update = groups.get(group.groupId);
    if (!update) {
      groups.set(group.groupId, {
        ...group,
        archivedAt: group.archivedAt ?? at,
        options: group.options.map(option => ({ ...option, archivedAt: option.archivedAt ?? at })),
      });
      continue;
    }
    const options = new Set(update.options.map(option => option.optionId));
    const removed = group.options.filter(option => !options.has(option.optionId));
    groups.set(group.groupId, {
      ...update, options: [...update.options, ...removed.map(option => ({ ...option, archivedAt: option.archivedAt ?? at }))],
    });
  }
  return [...groups.values()];
}

function checkOptions(current: OptionGroup[], next: OptionGroup[]) {
  const groups = new Map(current.map(group => [group.groupId, group]));
  const options = new Map(current.flatMap(group => group.options.map(option => [option.optionId, { group, option }] as const)));
  for (const group of next) {
    if (groups.get(group.groupId)?.archivedAt || options.has(group.groupId)) {
      throw new MenuError(400, 'INVALID_OPTION', 'groups');
    }
    for (const option of group.options) {
      const old = options.get(option.optionId);
      if (groups.has(option.optionId) || old && (old.group.groupId !== group.groupId || old.option.archivedAt)) {
        throw new MenuError(400, 'INVALID_OPTION', 'groups');
      }
    }
  }
}

async function checkIngredients(
  db: PoolClient, storeId: string, parts: readonly { part: IngredientPart; field: string }[],
) {
  if (!parts.length) return;
  const ids = [...new Set(parts.map(({ part }) => part.itemId))];
  const { rows } = await db.query<{ item_id: string; base_unit: string }>(`
    SELECT item_id, base_unit
    FROM inventory.inventory_item
    WHERE store_id = $1 AND item_id = ANY($2::uuid[]) AND base_unit IS NOT NULL AND archived_at IS NULL
  `, [storeId, ids]);
  const units = new Map(rows.map(item => [item.item_id, item.base_unit]));
  for (const { part, field } of parts) {
    const unit = units.get(part.itemId);
    if (!unit) throw new MenuError(404, 'ITEM_NOT_FOUND', `${field}.itemId`);
    if (unit !== part.unitDimension) throw new MenuError(400, 'UNIT_MISMATCH', `${field}.${field.startsWith('lines.') ? 'unit' : 'unitDimension'}`);
  }
}

const storedIngredients = (parts: IngredientPart[]) => parts.map(
  ({ itemId, quantityBase }) => ({ item_id: itemId, quantity_base: quantityBase }),
);

function writeState(db: PoolClient, storeId: string, menuId: string, revision: number, state: MenuState) {
  return db.query(`
    UPDATE inventory.menu_item
    SET revision = $3, name = $4, category = $5, price = $6, memo = $7, prep_min = $8, sale_status = $9,
        photo_key = $10, photo_file_id = $11, deleted_at = $12, option_groups = $13, recipe_lines = $14
    WHERE store_id = $1 AND menu_id = $2
  `, [storeId, menuId, revision, state.name, state.category, state.price, state.memo, state.prepMin, state.saleStatus,
    state.photoKey, state.photoFileId, state.deletedAt, JSON.stringify(state.groups),
    state.recipeLines === null ? null : JSON.stringify(state.recipeLines)]);
}

async function restore(
  db: PoolClient, ctx: CommandContext, receiptId: string, at: Date,
): Promise<Effect> {
  const { storeId, actorId } = ctx;
  const { rows: [original] } = await db.query<Applied>(`
    SELECT result, inverse FROM inventory.menu_command WHERE store_id = $1 AND actor_id = $2 AND receipt_id = $3
  `, [storeId, actorId, receiptId]);
  if (!original) throw new MenuError(404, 'RECEIPT_NOT_FOUND');
  const { result, inverse } = original;
  if (!result.undoUntil) throw new MenuError(409, 'UNDO_UNAVAILABLE');
  if (at >= new Date(result.undoUntil)) throw new MenuError(409, 'UNDO_EXPIRED');
  const row = await readMenuState(db, storeId, result.resourceId);
  if (!inverse || !row || row.revision !== result.revision) throw new MenuError(409, 'UNDO_UNAVAILABLE');
  const { menuId, revision, ...state } = row;
  const atIso = at.toISOString();
  if ('created' in inverse) {
    state.deletedAt = atIso;
  } else {
    const before = inverse.state;
    if (state.name !== before.name || state.deletedAt && !before.deletedAt) {
      await checkName(db, storeId, before.name, menuId);
    }
    if (before.photoFileId && (before.photoFileId !== state.photoFileId || state.deletedAt)) {
      await checkPhoto(ctx, before.photoFileId);
    }
    before.groups = retainArchivedOptions(state.groups, before.groups, atIso);
    Object.assign(state, before);
    await db.query(`
      UPDATE inventory.recipe_current c SET version = r.version
      FROM jsonb_to_recordset($3::jsonb) AS r(component_id uuid, version text)
      WHERE c.store_id = $1 AND c.menu_id = $2 AND c.component_id = r.component_id
    `, [storeId, menuId, JSON.stringify(inverse.recipes)]);
  }
  if (ctx.now() >= new Date(result.undoUntil)) throw new MenuError(409, 'UNDO_EXPIRED');
  await writeState(db, storeId, menuId, revision + 1, state);
  await db.query(`
    UPDATE inventory.menu_command SET inverse = NULL, undone_at = $3 WHERE store_id = $1 AND receipt_id = $2
  `, [storeId, receiptId, at]);
  return { menuId, revision: revision + 1, operation: state.deletedAt ? 'archived' : row.deletedAt ? 'restored' : 'updated' };
}

async function edit(
  db: PoolClient, ctx: CommandContext, current: MenuRow,
  command: Extract<MenuCommand, { expectedRevision: number }>, at: Date,
): Promise<Effect> {
  const { storeId } = ctx;
  const { menuId, revision, ...state } = current;
  const { rows: recipes } = await db.query<RecipePointer>(`
    SELECT component_id, version FROM inventory.recipe_current WHERE store_id = $1 AND menu_id = $2
  `, [storeId, menuId]);
  const atIso = at.toISOString();
  let next = { ...state };

  if (command.type === 'update') {
    next = applyPatch(state, command.patch);
    if (next.name !== state.name) await checkName(db, storeId, next.name, menuId);
    if (next.photoFileId && next.photoFileId !== state.photoFileId) await checkPhoto(ctx, next.photoFileId);
  } else if (command.type === 'archive') {
    next.deletedAt = atIso;
  } else if (command.type === 'recipe') {
    const known = new Map(state.recipeLines?.map(line => [line.itemId, line.recipeLineId]));
    const lineIds = new Set<string>();
    next.recipeLines = command.lines.map(({ recipeLineId, ...line }) => {
      const previous = known.get(line.itemId);
      const id = recipeLineId ?? previous ?? line.itemId;
      if ((previous && previous !== id) || lineIds.has(id)) throw new MenuError(400, 'INVALID_RECIPE_LINE', 'lines');
      lineIds.add(id);
      return { ...line, recipeLineId: id };
    });
    if (!isDeepStrictEqual(next.recipeLines, state.recipeLines)) {
      const parts = command.lines.map(recipePart);
      await checkIngredients(db, storeId, parts.map((part, i) => ({ part, field: `lines.${i}` })));
      await saveRecipeComponents(db, storeId, menuId, [{ componentId: menuId, ingredients: storedIngredients(parts) }]);
    }
  } else {
    checkOptions(state.groups, command.groups);
    next.groups = retainArchivedOptions(state.groups, command.groups, atIso);
    const previous = new Map(state.groups.flatMap(group => group.options.map(option => [option.optionId, option] as const)));
    const changed = command.groups.flatMap((group, i) => group.options.flatMap((option, j) =>
      isDeepStrictEqual(previous.get(option.optionId)?.extraRecipe, option.extraRecipe)
        ? [] : [{ option, field: `groups.${i}.options.${j}.extraRecipe` }],
    ));
    await checkIngredients(db, storeId, changed.flatMap(({ option, field }) =>
      option.extraRecipe.map((part, i) => ({ part, field: `${field}.${i}` })),
    ));
    await saveRecipeComponents(db, storeId, menuId, changed.map(({ option }) => ({
      componentId: option.optionId, ingredients: storedIngredients(option.extraRecipe),
    })));
  }

  if (isDeepStrictEqual(next, state)) return { menuId, revision };
  await writeState(db, storeId, menuId, revision + 1, next);
  return { menuId, revision: revision + 1, operation: command.type === 'archive' ? 'archived' : 'updated', inverse: { state, recipes } };
}

async function apply(db: PoolClient, ctx: CommandContext, command: MenuCommand, at: Date): Promise<Effect> {
  const { storeId } = ctx;
  if (command.type === 'create') {
    const menuId = randomUUID();
    const { name, category, price, memo } = command.input;
    await checkName(db, storeId, name, menuId);
    await db.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [storeId]);
    await db.query(`
      INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status, memo, recipe_lines)
      VALUES ($1, $2, 'menu', $3, $4, $5, 'selling', $6, '[]')
    `, [storeId, menuId, name, menuCategory(category), price, memo]);
    await saveRecipeComponents(db, storeId, menuId, [{ componentId: menuId, ingredients: [] }]);
    return { menuId, revision: 1, operation: 'created', inverse: { created: true } };
  }
  if (command.type === 'undo') return restore(db, ctx, command.receiptId, at);
  const current = await readMenuState(db, storeId, command.menuId);
  if (!current || current.deletedAt) throw new MenuError(404, 'MENU_NOT_FOUND');
  if (command.expectedRevision !== current.revision) throw new MenuError(409, 'STALE_REVISION');
  return edit(db, ctx, current, command, at);
}

export async function runMenuCommand(db: PoolClient, ctx: CommandContext, command: MenuCommand): Promise<Receipt> {
  const { storeId, actorId, key } = ctx;
  const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
  // Two simultaneous menu attempts must see one receipt and one store-ordered effect.
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('navis:inventory:menu:' || $1, 0))`, [storeId]);
  const { rows: [saved] } = await db.query<Applied>(`
    SELECT fingerprint, result FROM inventory.menu_command WHERE store_id = $1 AND actor_id = $2 AND idempotency_key = $3
  `, [storeId, actorId, key]);
  if (saved) {
    if (saved.fingerprint !== fingerprint) throw new MenuError(409, 'IDEMPOTENCY_MISMATCH');
    return saved.result;
  }

  const at = ctx.now();
  const { menuId, revision, operation, inverse } = await apply(db, ctx, command, at);
  const receiptId = randomUUID();
  const result: Receipt = {
    resourceId: menuId, revision, receiptId, changed: operation !== undefined,
    affectedSources: operation ? affectedSources : [],
    ...(inverse ? { undoUntil: new Date(ctx.now().getTime() + undoMs).toISOString() } : {}),
  };
  await db.query(`
    INSERT INTO inventory.menu_command (store_id, receipt_id, menu_id, actor_id, idempotency_key, fingerprint, result, inverse)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [storeId, receiptId, menuId, actorId, key, fingerprint, JSON.stringify(result), inverse ? JSON.stringify(inverse) : null]);

  if (operation) {
    const payload = { storeId, menuId, revision, operation };
    await db.query(`
      WITH sequence AS (
        INSERT INTO inventory.outbox_scope (scope_key, last_seq) VALUES ($1, 1)
        ON CONFLICT (scope_key) DO UPDATE SET last_seq = inventory.outbox_scope.last_seq + 1
        RETURNING last_seq
      )
      INSERT INTO inventory.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
      SELECT $2, $1::uuid, $1, last_seq, 'inventory.catalog_changed.v1', $3, $4, $5 FROM sequence
    `, [storeId, randomUUID(), menuId, at, JSON.stringify(payload)]);
  }
  return result;
}
