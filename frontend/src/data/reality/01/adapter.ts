import type { CouponSales } from '../../../../../backend/services/pos/reality/02/coupon-sales';
import { TODAY } from '../../db/time';
import { defineBinding, PortError, type DomainAdapter } from '../00/port';
import { menuCommandRequest, menuPath, projectMenuTables, type MenuCommand, type MenuDto } from './menu-dto';

const receiptBase = '/inventory';
const saved = 'data.management.notice.saved';
const deleted = 'data.management.notice.deleted';

function bind<T extends MenuCommand['type']>(type: T, noticeKey = saved) {
  return defineBinding<T>({
    type, receiptBase, noticeKey,
    request(command, ctx) {
      const revision = 'menuId' in command ? ctx.revision(`menu:${command.menuId}`) : undefined;
      return menuCommandRequest(command, revision);
    },
  });
}

export const menuAdapter: DomainAdapter = {
  domain: 'menu',
  sources: ['menu', 'pos.sales', 'pos.receipts'],
  tables: ['menuItem', 'recipeLine', 'menuOption'],
  errorKeys: {
    MENU_NAME_REQUIRED: 'data.management.error.MENU_NAME_REQUIRED',
    CATEGORY_INVALID: 'data.management.error.CATEGORY_INVALID',
    PRICE_INVALID: 'data.management.error.PRICE_INVALID',
    MENU_NOT_FOUND: 'data.management.error.NOT_FOUND',
    NAME_EXISTS: 'data.management.error.NAME_EXISTS',
    SALE_STATUS_INVALID: 'data.management.error.STATUS_INVALID',
    DUPLICATE_INGREDIENT: 'data.management.error.DUPLICATE_INGREDIENT',
    UNIT_MISMATCH: 'data.management.error.UNIT_PRECISION',
    STALE_REVISION: 'data.management.error.STALE_REVISION',
    IDEMPOTENCY_MISMATCH: 'data.management.error.IDEMPOTENCY_MISMATCH',
  },
  async load({ reads, signal }) {
    const { items, asOf, sourceRevision, complete } = await reads.all<MenuDto>(
      { resource: 'menu', path: menuPath, query: { limit: 50 } }, { signal },
    );
    let sold: Map<string, number> | undefined;
    if (items.length) {
      try {
        const sales = await reads.one<Pick<CouponSales, 'businessDate' | 'soldToday'>>({
          resource: 'menu-sales-today', path: '/pos/coupon-sales', query: { businessDate: TODAY, view: 'today' },
        }, { signal });
        if (sales.businessDate === TODAY && Array.isArray(sales.soldToday)) {
          sold = new Map(sales.soldToday.map(row => [row.menuId, row.quantity]));
        }
      } catch (error) {
        if (signal.aborted || !(error instanceof PortError) || error.status === 401 || error.status === 403) throw error;
      }
    }
    return {
      asOf, sourceRevision, complete,
      tables: projectMenuTables(items, asOf, sold),
      revisions: Object.fromEntries(items.map(menu => [`menu:${menu.menuId}`, menu.revision])),
    };
  },
  commands: [
    bind('menu.create'), bind('menu.update'), bind('menu.setSaleStatus'), bind('menu.setRecipe'), bind('menu.setOptions'),
    bind('menu.delete', deleted),
    defineBinding({
      type: 'menu.setPhoto', receiptBase, noticeKey: saved,
      async request(command, ctx) {
        const revision = ctx.revision(`menu:${command.menuId}`);
        if (!command.customPhotoUrl || revision === undefined) return menuCommandRequest(command, revision);
        const { fileId } = await ctx.files.uploadDataUrl('menu-photo', command.customPhotoUrl);
        return menuCommandRequest(command, revision, fileId);
      },
    }),
  ],
};
