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
export interface BillDraft { request: BillInput; quote: BillQuote }

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

export async function quoteBill({ db, storeId }: PosTx, request: BillInput, previous?: BillQuote): Promise<BillQuote> {
  const { rows } = await db.query<{ menuId: string; snapshot: MenuSnapshot }>(`
    SELECT menu_id AS "menuId", snapshot FROM pos.catalog_menu
    WHERE store_id = $1 AND menu_id = ANY($2::uuid[])
  `, [storeId, request.lines.map((line) => line.menuId)]);
  const menu = new Map(rows.map((row) => [row.menuId, row.snapshot]));
  const lines = request.lines.map(({ menuId, qty, optionIds }, index): SaleLine => {
    const item = menu.get(menuId);
    if (!item) throw new PosError(400, 'ITEM_REMOVED');
    if (item.saleStatus !== 'selling') throw new PosError(400, 'SOLD_OUT');
    const options = item.groups.flatMap((group) => {
      const selected = group.options.filter((option) => optionIds.includes(option.optionId));
      if (group.required && selected.length !== 1) throw new PosError(400, 'REQUIRED_OPTION');
      return selected;
    }).sort((a, b) => a.optionId.localeCompare(b.optionId));
    if (options.length !== optionIds.length) throw new PosError(400, 'INVALID_OPTION');
    const optionPrice = options.reduce((sum, option) => sum + option.extraPrice, 0);
    const optionCost = nullableSum(options.map((option) => option.extraCost));
    const gross = (item.basePrice + optionPrice) * qty;
    return {
      orderLineId: previous?.lines[index].orderLineId ?? randomUUID(),
      allocationId: previous?.lines[index].allocationId ?? randomUUID(),
      menuId, name: item.name, qty, basePrice: item.basePrice, baseCost: item.baseCost,
      optionPrice, optionCost, recipeVersion: item.recipeVersion, options, gross, discount: 0, amount: gross,
    };
  });
  const gross = lines.reduce((sum, line) => sum + line.gross, 0);
  if (!Number.isSafeInteger(gross) || gross <= request.discount) throw new PosError(400, 'INVALID_AMOUNT');
  const allocations = apportion(request.discount, lines.map((line) => ({ id: line.allocationId, weight: line.gross })));
  for (const [index, line] of lines.entries()) {
    line.discount = allocations[index];
    line.amount -= line.discount;
  }
  const quote = { lines, gross, discount: request.discount, payable: gross - request.discount };
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
