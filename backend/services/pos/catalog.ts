import { randomUUID } from 'node:crypto';
import { fingerprint, integer, object, PosError, uuid, type PosTx } from './wire.ts';

type CatalogOption = {
  optionId: string; name: string; extraPrice: number; extraCost: number | null; recipeVersion: string;
};
export interface MenuSnapshot {
  name: string;
  basePrice: number;
  baseCost: number | null;
  recipeVersion: string;
  saleStatus: 'selling' | 'sold_out';
  groups: readonly { required: boolean; options: readonly CatalogOption[] }[];
}
type SourceOption = Omit<CatalogOption, 'recipeVersion'> & { recipeVersion: string | null };
type SourceMenu = Omit<MenuSnapshot, 'recipeVersion' | 'groups'> & {
  recipeVersion: string | null;
  groups: readonly { required: boolean; options: readonly SourceOption[] }[];
};
export type ReadPosCatalog = (input: { storeId: string; actorId: string; menuIds: readonly string[] }) => Promise<unknown>;

interface RequestedLine { menuId: string; qty: number; optionIds: string[] }
export interface BillInput { type: 'dine_in' | 'takeout'; lines: RequestedLine[]; discount: number }
export interface SaleLine {
  orderLineId: string;
  allocationId: string;
  menuId: string;
  name: string;
  qty: number;
  basePrice: number;
  baseCost: number | null;
  optionPrice: number;
  optionCost: number | null;
  recipeVersion: string;
  options: CatalogOption[];
  gross: number;
  discount: number;
  amount: number;
}
export interface BillQuote {
  quoteRevision: number;
  lines: SaleLine[];
  gross: number;
  discount: number;
  payable: number;
}
export interface BillDraft { request: BillInput; quote: BillQuote; postpaid?: true; fixedDiscounts?: true }

export function parseBill(value: unknown): BillInput {
  const input = object(value, ['type', 'lines', 'discount']);
  if (input.type !== 'dine_in' && input.type !== 'takeout') throw new PosError(400, 'ORDER_TYPE_INVALID');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 25) throw new PosError(400, 'INVALID_REQUEST');
  const lines = input.lines.map((row) => {
    const line = object(row, ['menuId', 'qty', 'optionIds']);
    const optionIds = line.optionIds === undefined ? [] : line.optionIds;
    if (!Array.isArray(optionIds) || optionIds.length > 20) throw new PosError(400, 'INVALID_OPTION');
    const ids = optionIds.map(uuid).sort();
    if (new Set(ids).size !== ids.length) throw new PosError(400, 'INVALID_OPTION');
    return { menuId: uuid(line.menuId), qty: integer(line.qty, 1, 99, 'QTY_LIMIT'), optionIds: ids };
  });
  return { type: input.type, lines, discount: input.discount === undefined ? 0 : integer(input.discount, 0) };
}

/** Split integer KRW by remaining capacity, breaking equal remainders by stable allocation identity. */
export function apportion(amount: number, weighted: readonly { id: string; weight: number }[]): number[] {
  const total = weighted.reduce((sum, row) => sum + BigInt(row.weight), 0n);
  if (total === 0n) return weighted.map(() => 0);
  const calculated = weighted.map(({ id, weight }, index) => {
    const part = BigInt(weight) * BigInt(amount);
    return { id, index, share: Number(part / total), remainder: part % total };
  });
  let left = amount - calculated.reduce((sum, line) => sum + line.share, 0);
  const sorted = [...calculated].sort((a, b) => a.remainder === b.remainder
    ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  for (const line of sorted) {
    if (!left) break;
    line.share++;
    left--;
  }
  return calculated.map(({ share }) => share);
}

function sourceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PosError(503, 'CATALOG_UNAVAILABLE');
  return value as Record<string, unknown>;
}

function sourceText(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new PosError(503, 'CATALOG_UNAVAILABLE');
  return value;
}

function sourceVersion(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new PosError(503, 'CATALOG_UNAVAILABLE');
  return value;
}

async function liveSnapshots(tx: PosTx, menuIds: string[], readCatalog: ReadPosCatalog) {
  try {
    const { items } = sourceObject(await readCatalog({ storeId: tx.storeId, actorId: tx.actorId, menuIds }));
    if (!Array.isArray(items) || items.length > menuIds.length) throw new PosError(503, 'CATALOG_UNAVAILABLE');
    const result = new Map<string, SourceMenu>();
    for (const item of items) {
      const row = sourceObject(item);
      const menuId = uuid(row.menuId);
      if (result.has(menuId) || !menuIds.includes(menuId) || !Array.isArray(row.groups)
          || (row.saleStatus !== 'selling' && row.saleStatus !== 'sold_out')) throw new PosError(503, 'CATALOG_UNAVAILABLE');
      const optionIds = new Set<string>();
      result.set(menuId, {
        name: sourceText(row.name), basePrice: integer(row.basePrice, 1),
        baseCost: row.baseCost === null ? null : integer(row.baseCost, 0),
        recipeVersion: sourceVersion(row.recipeVersion), saleStatus: row.saleStatus,
        groups: row.groups.map((group) => {
          const entry = sourceObject(group);
          if (typeof entry.required !== 'boolean' || !Array.isArray(entry.options)) throw new PosError(503, 'CATALOG_UNAVAILABLE');
          return { required: entry.required, options: entry.options.map((option) => {
            const value = sourceObject(option);
            const optionId = uuid(value.optionId);
            if (optionIds.has(optionId) || optionId === menuId) throw new PosError(503, 'CATALOG_UNAVAILABLE');
            optionIds.add(optionId);
            return { optionId, name: sourceText(value.name), extraPrice: integer(value.extraPrice, 0),
              extraCost: value.extraCost === null ? null : integer(value.extraCost, 0), recipeVersion: sourceVersion(value.recipeVersion) };
          }) };
        }),
      });
    }
    return result;
  } catch {
    throw new PosError(503, 'CATALOG_UNAVAILABLE');
  }
}

async function storedSnapshots({ db, storeId }: PosTx, menuIds: string[]) {
  const { rows } = await db.query<{ menuId: string; snapshot: MenuSnapshot }>(`
    SELECT menu_id AS "menuId", snapshot FROM pos.catalog_menu
    WHERE store_id = $1 AND menu_id = ANY($2::uuid[])
  `, [storeId, menuIds]);
  return new Map(rows.map((row) => [row.menuId, row.snapshot]));
}

export async function quoteBill(tx: PosTx, request: BillInput, previous?: BillQuote, readCatalog?: ReadPosCatalog,
  fixedDiscounts = false): Promise<BillQuote> {
  const menuIds = [...new Set(request.lines.map((line) => line.menuId))];
  const menu = readCatalog ? await liveSnapshots(tx, menuIds, readCatalog) : await storedSnapshots(tx, menuIds);
  const lines = request.lines.map(({ menuId, qty, optionIds }, index): SaleLine => {
    const item = menu.get(menuId);
    if (!item) throw new PosError(400, 'ITEM_REMOVED');
    if (item.saleStatus !== 'selling') throw new PosError(400, 'SOLD_OUT');
    const options = item.groups.flatMap((group) => {
      const selected = group.options.filter((option) => optionIds.includes(option.optionId));
      if (group.required && selected.length !== 1) throw new PosError(400, 'REQUIRED_OPTION');
      return selected;
    }).sort((a, b) => a.optionId.localeCompare(b.optionId)).map((option): CatalogOption => {
      if (option.recipeVersion === null) throw new PosError(409, 'CATALOG_RECIPE_UNAVAILABLE');
      return { ...option, recipeVersion: option.recipeVersion };
    });
    if (options.length !== optionIds.length) throw new PosError(400, 'INVALID_OPTION');
    if (item.recipeVersion === null) throw new PosError(409, 'CATALOG_RECIPE_UNAVAILABLE');
    const optionPrice = options.reduce((sum, option) => sum + option.extraPrice, 0);
    const optionCost = nullableSum(options.map((option) => option.extraCost));
    const gross = (item.basePrice + optionPrice) * qty;
    return {
      orderLineId: previous?.lines[index]?.orderLineId ?? randomUUID(),
      allocationId: previous?.lines[index]?.allocationId ?? randomUUID(),
      menuId, name: item.name, qty, basePrice: item.basePrice, baseCost: item.baseCost,
      optionPrice, optionCost, recipeVersion: item.recipeVersion, options, gross, discount: 0, amount: gross,
    };
  });
  const allocations = fixedDiscounts
    ? lines.map((_, index) => previous?.lines[index]?.discount ?? 0)
    : apportion(request.discount, lines.map((line) => ({ id: line.allocationId, weight: line.gross })));
  return quoteFromLines(lines.map((line, index) => ({ ...line, discount: allocations[index], amount: line.gross - allocations[index] })));
}

export function quoteFromLines(lines: SaleLine[]): BillQuote {
  const gross = lines.reduce((sum, line) => sum + line.gross, 0);
  const discount = lines.reduce((sum, line) => sum + line.discount, 0);
  if (!Number.isSafeInteger(gross) || gross <= discount || lines.some(line => line.amount < 0)) throw new PosError(400, 'INVALID_AMOUNT');
  const quote = { lines, gross, discount, payable: gross - discount };
  const quoteRevision = Number.parseInt(fingerprint(quote).slice(0, 13), 16);
  return { quoteRevision, ...quote };
}

export function nullableSum(values: readonly (number | null)[]): number | null {
  if (values.includes(null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function saleCost(line: SaleLine, qty: number) {
  const unitCost = nullableSum([line.baseCost, line.optionCost]);
  return unitCost === null ? null : unitCost * qty;
}

export function eventLine(line: SaleLine, quantity: number) {
  return {
    allocationId: line.allocationId, orderLineId: line.orderLineId, menuId: line.menuId,
    recipeVersion: line.recipeVersion, quantity,
    options: line.options.map(({ optionId, recipeVersion }) => ({ optionId, recipeVersion })),
  };
}
