import { cafeMemberId } from '../../data/db/cafe-identity';
import type { PosCatalog, PosState, PosUiState } from '../../contracts/pos';
import { seedCatalog } from '../../data/db/generated/catalog';
import manifest from '../../data/db/generated/manifest.json';
import { seedToday } from '../../data/db/generated/today';
import { freezePos } from '../domain/common';

export { posSeedLinks } from './legacy';

const catalog: PosCatalog = freezePos({
  items: seedCatalog.menu.map(menu => ({ ...menu, photoKey: null, shortageItems: [] })),
  ingredients: seedCatalog.items.map(({ itemId, unitDimension }) => ({ itemId, unitDimension })),
});

export const createPosUi = (): PosUiState => ({
  tab: manifest.store.posStartTab === 'tables' ? 'tables' : 'order', approval: null, cartUndo: null,
});
export const createPosSeedCatalog = (): PosCatalog => catalog;
const pos: PosState = freezePos({
  ...seedToday.pos,
  bills: seedToday.pos.bills.map(bill => ({
    ...bill, ...(bill.memberId ? { memberId: cafeMemberId(bill.memberId) } : {}),
    discounts: bill.discounts.map(row => row.contributionMemberId ? { ...row, contributionMemberId: cafeMemberId(row.contributionMemberId) } : row),
  })),
});
export const createPosSeed = (): PosState => pos;
