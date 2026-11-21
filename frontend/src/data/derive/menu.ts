import { TODAY } from '../db/time';
import { deriveRecipeCost } from './stock';
import { ready, type Projector } from '../models/util';
import type { DataSnapshot } from '../db/types';
import { memoSelector } from './common';
export const selectMenus = memoSelector((q: { readonly query?: string }) => q.query ?? '', (s, q) => ({
  rows: s.tables.menuItem.filter((m) => m.kind === 'menu' && !m.deletedAt).map((m) => ({ ...m, prepMin: m.prepMin ?? 3, saleStatus: m.saleStatus ?? 'selling', photoKey: m.photoKey ?? null, customPhotoUrl: m.customPhotoUrl ?? null,
    optionGroups: (m.optionGroups ?? []).filter(g => !g.archivedAt).map(g => ({ ...g, options: g.options.filter(o => !o.archivedAt) })), ...deriveRecipeCost(s, m.menuId) })).filter((m) => !q.query || JSON.stringify(m.name).includes(q.query)),
  date: TODAY,
}));
export type MenuModel = ReturnType<typeof selectMenus> & { readonly total: number };
export const projectMenu: Projector<'menu'> = (ctx, condition, variant) => {
  const model = selectMenus(ctx.snapshot, {});
  if (!model.rows.length) return { status: 'empty', featureId: 'menu', variant, messageKey: 'data.state.menu.no-menus', actionKey: 'data.management.action.addMenu' };
  return ready('menu', condition, variant, { ...model, total: model.rows.length });
};
export const readMenus = (s: DataSnapshot) => selectMenus(s, {});
