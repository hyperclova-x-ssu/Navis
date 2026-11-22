import { cafeMemberId } from '../../data/db/cafe-identity';
import type { PosCatalog, PosState, PosUiState } from '../../contracts/pos';
import { seedCatalog, seedToday } from '../../data/db/cafe-fixtures';
import manifest from '../../data/db/generated/manifest.json';
import { freezePos } from '../domain/common';
import { dataSourceFor } from '../../data/reality/00/registry';
import { POS_BUSINESS_DATE } from '../clock';

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
/**
 * REAL-PLAN F02: an operating store starts with no sales. The service's records for the business day are projected over this
 * (`data/reality/02/project.ts`), so the café sample day is never mixed into a real store. Fixture builds keep the sample day.
 */
const empty: PosState = freezePos({
  ...seedToday.pos, businessDate: POS_BUSINESS_DATE, seq: 0, orders: [], bills: [], billAllocations: [], payments: [], refunds: [], cancellations: [], receipts: [], cashReceipts: [],
  tableSessions: [], reservationPrompts: [], commandLedger: [], drawer: { opening: 0, actual: null, memo: '', movements: [] },
});
export const createPosSeed = (): PosState => dataSourceFor('pos') === 'http' || pos.businessDate !== POS_BUSINESS_DATE ? empty : pos;
