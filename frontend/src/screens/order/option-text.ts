import type { PosCatalogItem, PosOption, PosOptionGroup } from '../../contracts/pos';
import { formatPosMoney } from '../../ui';

/** A price delta as the owner reads it on a tile, e.g. "+500원". Free options print nothing. */
export const optionDelta = (option: Pick<PosOption, 'extraPrice'>): string => option.extraPrice ? `+${formatPosMoney(option.extraPrice)}` : '';

/** "오트 귀리우유 +600원" — one string for a choice chip or a cart-line caption. */
export const optionLabel = (option: Pick<PosOption, 'name' | 'extraPrice'>): string => [option.name, optionDelta(option)].filter(Boolean).join(' ');

/** Cart-line caption: every chosen option, price deltas included, in the order the menu defines its groups. */
export const optionCaption = (options: readonly Pick<PosOption, 'name' | 'extraPrice'>[]): string => options.map(optionLabel).join(' · ');

/** One order line as a caption: "카페라떼 (ICE · 오트 귀리우유 +600원) ×2". Options sit in brackets so they never read as another line. */
export const lineSummary = (name: string, options: readonly Pick<PosOption, 'name' | 'extraPrice'>[], qty: number): string =>
  `${name}${options.length ? ` (${optionCaption(options)})` : ''} ×${qty}`;

export const activeOptions =(group: PosOptionGroup): readonly PosOption[] => group.options.filter(option => !option.archivedAt);

/** The menu's groups that still have something to choose; an archived-out group never shows an empty title. */
export const choosableGroups = (item: PosCatalogItem): readonly PosOptionGroup[] => item.groups.filter(group => activeOptions(group).length > 0);

/** Chosen options in the order the menu lists its groups (온도 → 사이즈 → 추가), not in id order. */
export function orderedOptions<T extends Pick<PosOption, 'optionId'>>(item: PosCatalogItem | undefined, options: readonly T[]): readonly T[] {
  if (!item) return options;
  const rank = new Map(item.groups.flatMap(group => group.options).map((option, index) => [option.optionId, index] as const));
  return [...options].sort((a, b) => (rank.get(a.optionId) ?? Infinity) - (rank.get(b.optionId) ?? Infinity));
}

/** The same one-line option text for an order, bill or receipt line: group order, price deltas, no quantity. */
export const lineOptionCaption = (items: readonly PosCatalogItem[], menuId: string, options: readonly Pick<PosOption, 'optionId' | 'name' | 'extraPrice'>[]): string =>
  optionCaption(orderedOptions(items.find(item => item.menuId === menuId), options));

/** "카페라떼 (ICE · 오트 귀리우유 +600원) ×1" for an order, bill or receipt line. */
export const lineLabel = (items: readonly PosCatalogItem[], menuId: string, name: string, options: readonly Pick<PosOption, 'optionId' | 'name' | 'extraPrice'>[], qty: number): string =>
  lineSummary(name, orderedOptions(items.find(item => item.menuId === menuId), options), qty);

/** Korean object particle for a word ("샷을", "온도를"). */
export const objectParticle = (name: string): string => {
  const last = name.charCodeAt(name.length - 1) - 0xac00;
  return last >= 0 && last <= 11171 && last % 28 ? '을' : '를';
};

/** Keep the active choices of an existing cart line when it is edited. */
export function retainActiveOptions(item: PosCatalogItem, current: readonly string[] = []): string[] {
  const active = new Set(item.groups.flatMap(group => activeOptions(group).map(option => option.optionId)));
  return current.filter(id => active.has(id));
}
