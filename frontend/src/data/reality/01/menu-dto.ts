import { normalizeMenuCategory, type MenuCategoryInput } from '../../../contracts';
import type { PosMenuPhotoKey, PosOptionGroup } from '../../../contracts/pos';
import type { DataCommand } from '../../commands/types';
import type { BaseUnit } from '../../db/management-types';
import type { DataTables, MenuItem } from '../../db/types';
import { PortError, type CommandRequest } from '../00/port';

export type MenuCommand = Extract<DataCommand, { type: `menu.${string}` }>;

interface MenuLineDto {
  readonly recipeLineId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly unit: BaseUnit;
  readonly cost?: number | null;
}

export interface MenuDto {
  readonly menuId: string;
  readonly name: string;
  readonly category: MenuCategoryInput;
  readonly seasonal?: string | null;
  readonly price: number;
  readonly memo: string | null;
  readonly prepMin: number;
  readonly saleStatus: 'selling' | 'sold_out';
  readonly photoKey: PosMenuPhotoKey | null;
  readonly photoFileId: string | null;
  readonly groups: readonly PosOptionGroup[];
  readonly recipeLines: readonly MenuLineDto[];
  readonly recipeVersion: string | null;
  readonly unitCost: number | null;
  readonly revision: number;
}

export interface RealMenuItem extends MenuItem {
  readonly sourceCost: { readonly unitCost: number | null };
  readonly photoFileId: string | null;
  readonly soldToday: number | null;
}

export function menuPhotoFileId(menu: MenuItem): string | undefined {
  return 'photoFileId' in menu && typeof menu.photoFileId === 'string' ? menu.photoFileId : undefined;
}

export function menuLineCost(line: { readonly cost: number | null }): number | null {
  const cost = 'sourceCost' in line ? line.sourceCost : undefined;
  return cost === null || typeof cost === 'number' ? cost : line.cost;
}

const raw = (value: string) => ({ raw: value });

export function projectMenuTables(items: readonly MenuDto[], asOf: string, sold?: ReadonlyMap<string, number>) {
  const menuItem = items.map((menu): RealMenuItem => {
    const category = normalizeMenuCategory(menu.category);
    return {
      menuId: menu.menuId, kind: 'menu', name: raw(menu.name), nameKey: 'data.management.customMenu',
      category, categoryKey: `data.management.category.${category}`, seasonal: menu.seasonal ?? null, price: menu.price,
      memo: menu.memo === null ? null : raw(menu.memo), prepMin: menu.prepMin, saleStatus: menu.saleStatus,
      photoKey: menu.photoKey, photoFileId: menu.photoFileId, optionGroups: menu.groups,
      recipe: [], sourceCost: { unitCost: menu.unitCost }, soldToday: sold ? sold.get(menu.menuId) ?? 0 : null,
      costEffectiveFrom: asOf.slice(0, 10),
    };
  });
  const recipeLine = items.flatMap(menu => menu.recipeLines.map(({ cost, ...line }) => ({
    ...line, menuId: menu.menuId, ...(cost === undefined ? {} : { sourceCost: cost }),
  })));
  const menuOption = items.flatMap(menu => menu.groups.flatMap(group => group.options.flatMap(option => (
    group.archivedAt || option.archivedAt || option.extraCost === null ? []
      : [{ optionId: option.optionId, nameKey: 'widget.menu.pos.optionName', cost: option.extraCost }]
  ))));
  return { menuItem, recipeLine, menuOption } satisfies Partial<DataTables>;
}

export const menuPath = '/inventory/menu';

function writeGroups(groups: readonly PosOptionGroup[]) {
  return groups.map(({ groupId, menuId, name, required, options }) => ({
    groupId, menuId, name, required,
    options: options.map(({ optionId, groupId, name, extraPrice, extraRecipe }) => ({
      optionId, groupId, name, extraPrice, extraRecipe,
    })),
  }));
}

export function menuCommandRequest(command: MenuCommand, expectedRevision?: number, photoFileId?: string): CommandRequest {
  if (command.type === 'menu.create') {
    const { name, category, price, memo } = command;
    return { method: 'POST', path: menuPath, body: { name, category, price, memo: memo ?? null } };
  }
  if (expectedRevision === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  const path = `${menuPath}/${encodeURIComponent(command.menuId)}`;
  const patch = (body: unknown, target = path): CommandRequest => ({ method: 'PATCH', path: target, expectedRevision, body });

  switch (command.type) {
    case 'menu.update': return patch(command.patch);
    case 'menu.setSaleStatus': return patch({ saleStatus: command.status });
    case 'menu.setOptions': return patch({ groups: writeGroups(command.groups) }, `${path}/options`);
    case 'menu.setRecipe': {
      const lines = command.lines.map(({ itemId, quantity, unit }) => ({ itemId, quantity, unit }));
      return patch({ menuId: command.menuId, lines }, '/inventory/recipes');
    }
    case 'menu.setPhoto': {
      if (command.customPhotoUrl && !photoFileId) throw new PortError(503, 'SERVICE_UNAVAILABLE', 'PHOTO_UNAVAILABLE');
      return patch(photoFileId ? { photoFileId } : { photoKey: command.photoKey });
    }
    case 'menu.delete': return { method: 'DELETE', path, expectedRevision };
  }
}
