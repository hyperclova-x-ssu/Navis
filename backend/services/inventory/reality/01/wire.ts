export const uuidPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
export const idempotencyPattern = /^[A-Za-z0-9_:.~-]{1,160}$/;

export class MenuError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly reason: string,
    readonly field?: string,
  ) {
    super(reason);
  }
}

export type Category = 'coffee' | 'tea' | 'beverage' | 'dessert';
export type CategoryInput = Category | 'drink';
export type SaleStatus = 'selling' | 'sold_out';
export type BaseUnit = 'g' | 'mL' | 'pcs';
export type Unit = BaseUnit | 'kg' | 'L';
export type RecipeLine = { recipeLineId: string; itemId: string; quantity: number; unit: Unit };
export type RecipeLineInput = Omit<RecipeLine, 'recipeLineId'> & { recipeLineId?: string };
export type IngredientPart = { itemId: string; quantityBase: number; unitDimension: BaseUnit };
export type MenuOption = {
  optionId: string; groupId: string; name: string; extraPrice: number;
  extraRecipe: IngredientPart[]; archivedAt?: string;
};
export type OptionGroup = {
  groupId: string; menuId: string; name: string; required: boolean; options: MenuOption[]; archivedAt?: string;
};
export type CreateMenu = { name: string; category: CategoryInput; price: number; memo?: string | null };
export type MenuPatch = Partial<CreateMenu & {
  prepMin: number; saleStatus: SaleStatus; photoKey: string | null; photoFileId: string | null;
}>;
export type MenuCommand =
  | { type: 'create'; input: CreateMenu }
  | { type: 'update'; menuId: string; expectedRevision: number; patch: MenuPatch }
  | { type: 'options'; menuId: string; expectedRevision: number; groups: OptionGroup[] }
  | { type: 'recipe'; menuId: string; expectedRevision: number; lines: RecipeLineInput[] }
  | { type: 'archive'; menuId: string; expectedRevision: number }
  | { type: 'undo'; receiptId: string };

export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MenuError(400, 'INVALID_REQUEST');
  const field = Object.keys(value).find(key => !keys.includes(key));
  if (field) throw new MenuError(400, 'READ_ONLY_FIELD', field);
  return value as Record<string, unknown>;
}

export function uuid(value: unknown, field: string) {
  if (!isUuid(value)) throw new MenuError(400, 'INVALID_REQUEST', field);
  return value.toLowerCase();
}

function optionIdentity(value: unknown, prefix: 'group' | 'option', field: string) {
  return uuid(typeof value === 'string' && value.startsWith(`${prefix}-`) ? value.slice(prefix.length + 1) : value, field);
}

function integer(value: unknown, min: number, max: number, reason: string, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new MenuError(400, reason, field);
  }
  return value;
}

function name(value: unknown, field = 'name') {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 160 || result.includes('\0')) {
    throw new MenuError(400, field === 'name' ? 'MENU_NAME_REQUIRED' : 'EMPTY_NAME', field);
  }
  return result;
}

export function category(value: unknown): Category {
  if (value === 'drink') return 'beverage';
  if (value !== 'coffee' && value !== 'tea' && value !== 'beverage' && value !== 'dessert') {
    throw new MenuError(400, 'CATEGORY_INVALID', 'category');
  }
  return value;
}

// Preserve old request fingerprints when a client retries a command issued before the cutover.
const commandCategory = (value: unknown): CategoryInput => value === 'drink' ? value : category(value);

export function saleStatus(value: unknown): SaleStatus {
  if (value !== 'selling' && value !== 'sold_out') throw new MenuError(400, 'SALE_STATUS_INVALID', 'saleStatus');
  return value;
}

function memo(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) throw new MenuError(400, 'INVALID_MEMO', 'memo');
  return value.trim() || null;
}

const maxWon = 999_999_999_999;
const createFields = ['name', 'category', 'price', 'memo'];
const price = (value: unknown) => integer(value, 1, maxWon, 'PRICE_INVALID', 'price');
const expected = (value: unknown) => integer(value, 1, 2_147_483_647, 'EXPECTED_REVISION_REQUIRED', 'expectedRevision');

export function parseCreate(body: unknown): MenuCommand {
  const input = object(body, createFields);
  return { type: 'create', input: {
    name: name(input.name), category: commandCategory(input.category), price: price(input.price), memo: input.memo === undefined ? null : memo(input.memo),
  } };
}

export function parseUpdate(body: unknown, menuId: string): MenuCommand {
  const { expectedRevision, ...input } = object(body, [...createFields, 'expectedRevision', 'prepMin', 'saleStatus', 'photoKey', 'photoFileId']);
  const patch: MenuPatch = {};
  if (input.name !== undefined) patch.name = name(input.name);
  if (input.category !== undefined) patch.category = commandCategory(input.category);
  if (input.price !== undefined) patch.price = price(input.price);
  if (input.memo !== undefined) patch.memo = memo(input.memo);
  if (input.prepMin !== undefined) patch.prepMin = integer(input.prepMin, 1, 1440, 'PREP_MIN_INVALID', 'prepMin');
  if (input.saleStatus !== undefined) patch.saleStatus = saleStatus(input.saleStatus);
  if (input.photoKey !== undefined) {
    if (input.photoKey !== null && (typeof input.photoKey !== 'string' || !/^menu-photo-0[1-8]$/.test(input.photoKey))) {
      throw new MenuError(400, 'UNKNOWN_PHOTO', 'photoKey');
    }
    patch.photoKey = input.photoKey;
  }
  if (input.photoFileId !== undefined) patch.photoFileId = input.photoFileId === null ? null : uuid(input.photoFileId, 'photoFileId');
  if (patch.photoKey && patch.photoFileId) throw new MenuError(400, 'UNKNOWN_PHOTO', 'photoFileId');
  if (!Object.keys(patch).length) throw new MenuError(400, 'INVALID_REQUEST');
  return { type: 'update', menuId, expectedRevision: expected(expectedRevision), patch };
}

function array(value: unknown, max: number, field: string) {
  if (!Array.isArray(value) || value.length > max) throw new MenuError(400, 'INVALID_REQUEST', field);
  return value as unknown[];
}

export function recipePart({ itemId, quantity, unit }: RecipeLineInput): IngredientPart {
  if (unit === 'kg' || unit === 'L') {
    return { itemId, quantityBase: Math.round(quantity * 1000), unitDimension: unit === 'kg' ? 'g' : 'mL' };
  }
  return { itemId, quantityBase: quantity, unitDimension: unit };
}

export function parseRecipe(body: unknown): MenuCommand {
  const input = object(body, ['menuId', 'lines', 'expectedRevision']);
  const items = new Set<string>();
  const lines = array(input.lines, 100, 'lines').map((line, index): RecipeLineInput => {
    const { recipeLineId, itemId: value, quantity, unit } = object(line, ['recipeLineId', 'itemId', 'quantity', 'unit']);
    const field = `lines.${index}`;
    const itemId = uuid(value, `${field}.itemId`);
    if (items.has(itemId)) throw new MenuError(400, 'DUPLICATE_INGREDIENT', `${field}.itemId`);
    items.add(itemId);
    if (unit !== 'g' && unit !== 'kg' && unit !== 'mL' && unit !== 'L' && unit !== 'pcs') {
      throw new MenuError(400, 'UNIT_MISMATCH', `${field}.unit`);
    }
    const validQuantity = typeof quantity === 'number' && quantity > 0
      && (unit === 'kg' || unit === 'L' ? /^\d+(?:\.\d{1,3})?$/.test(String(quantity)) : Number.isSafeInteger(quantity));
    if (!validQuantity || !Number.isSafeInteger(recipePart({ itemId, quantity, unit }).quantityBase)) {
      throw new MenuError(400, 'UNIT_MISMATCH', `${field}.unit`);
    }
    return { itemId, quantity, unit, ...(recipeLineId === undefined ? {} : { recipeLineId: uuid(recipeLineId, `${field}.recipeLineId`) }) };
  });
  return { type: 'recipe', menuId: uuid(input.menuId, 'menuId'), expectedRevision: expected(input.expectedRevision), lines };
}

function parseParts(input: unknown, path: string): IngredientPart[] {
  const items = new Set<string>();
  return array(input, 100, path).map((row, index) => {
    const field = `${path}.${index}`;
    const { itemId: value, quantityBase, unitDimension } = object(row, ['itemId', 'quantityBase', 'unitDimension']);
    const itemId = uuid(value, `${field}.itemId`);
    if (items.has(itemId)) throw new MenuError(400, 'INVALID_OPTION', field);
    items.add(itemId);
    if (unitDimension !== 'g' && unitDimension !== 'mL' && unitDimension !== 'pcs') throw new MenuError(400, 'UNIT_MISMATCH', `${field}.unitDimension`);
    return { itemId, unitDimension, quantityBase: integer(quantityBase, 1, Number.MAX_SAFE_INTEGER, 'UNIT_MISMATCH', `${field}.quantityBase`) };
  });
}

export function parseOptions(body: unknown, menuId: string): MenuCommand {
  const input = object(body, ['groups', 'expectedRevision']);
  const seen = new Set([menuId]);
  const groups = array(input.groups, 20, 'groups').map((entry, index): OptionGroup => {
    const field = `groups.${index}`;
    const group = object(entry, ['groupId', 'menuId', 'name', 'required', 'options']);
    const groupId = optionIdentity(group.groupId, 'group', `${field}.groupId`);
    if (uuid(group.menuId, `${field}.menuId`) !== menuId || seen.has(groupId) || typeof group.required !== 'boolean') {
      throw new MenuError(400, 'INVALID_OPTION', field);
    }
    seen.add(groupId);
    const options = array(group.options, 30, `${field}.options`).map((entry, index): MenuOption => {
      const path = `${field}.options.${index}`;
      const option = object(entry, ['optionId', 'groupId', 'name', 'extraPrice', 'extraCost', 'extraRecipe']);
      const optionId = optionIdentity(option.optionId, 'option', `${path}.optionId`);
      if (optionIdentity(option.groupId, 'group', `${path}.groupId`) !== groupId || seen.has(optionId)) {
        throw new MenuError(400, 'INVALID_OPTION', `${path}.optionId`);
      }
      seen.add(optionId);
      return {
        optionId, groupId, name: name(option.name, `${path}.name`),
        extraPrice: integer(option.extraPrice, 0, maxWon, 'NEGATIVE_AMOUNT', `${path}.extraPrice`),
        extraRecipe: parseParts(option.extraRecipe, `${path}.extraRecipe`),
      };
    });
    if (group.required && !options.length) throw new MenuError(400, 'REQUIRED_GROUP_EMPTY', `${field}.required`);
    return { groupId, menuId, name: name(group.name, `${field}.name`), required: group.required, options };
  });
  return { type: 'options', menuId, expectedRevision: expected(input.expectedRevision), groups };
}

export function parseArchive(body: unknown, menuId: string): MenuCommand {
  return { type: 'archive', menuId, expectedRevision: expected(object(body, ['expectedRevision']).expectedRevision) };
}

export function parseList(query: unknown) {
  const { cursor, limit, category: categoryInput, saleStatus: statusInput } = object(query, ['cursor', 'limit', 'category', 'saleStatus']);
  return {
    cursor: cursor === undefined ? null : uuid(cursor, 'cursor'),
    limit: limit === undefined ? 50 : integer(typeof limit === 'string' && /^\d{1,3}$/.test(limit) ? Number(limit) : undefined, 1, 100, 'INVALID_REQUEST', 'limit'),
    category: categoryInput === undefined ? null : category(categoryInput),
    saleStatus: statusInput === undefined ? null : saleStatus(statusInput),
  };
}
