import { addDays, isIsoDate } from '../../db/time';
import { isNightHour } from '../../marketing/calc';
import { defineBinding, PortError, type CommandContext, type DomainAdapter, type ListPage, type LoadContext } from '../00';
import type { MenuDto } from '../01/menu-dto';
import type { CouponSales } from '../../../../../backend/services/pos/reality/02/coupon-sales';
import type { StockBatchDto, StockForecastDto, StockItemDto } from '../03/stock-dto';
import { memberDateTime, type MemberDto } from '../05/dto';
import { couponPath, type CouponDto, type CouponUsageDto, type NaverLedgerDto } from './dto';
import { couponFields, expiryModel, slotModel, statusModel, type RealCouponData } from './project';

const couponKey = (id: string) => `coupon:${id}`;
const codeKey = (id: string) => `coupon-code:${id}`;
const codePath = (id: string) => `/marketing/coupon-codes/${encodeURIComponent(id)}`;
const rowPath = (id: string) => `${couponPath}/${encodeURIComponent(id)}`;

function revision(context: CommandContext, key: string) {
  const value = context.revision(key);
  if (value === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return value;
}

async function optional<T>(operation: Promise<T>): Promise<T | null> {
  try { return await operation; }
  catch (error) {
    if (!(error instanceof PortError) || error.status === 401 || error.status === 403) throw error;
    return null;
  }
}

async function sales({ reads, signal }: LoadContext, businessDate: string) {
  const data = await reads.one<CouponSales>({ resource: 'coupon-sales', path: '/pos/coupon-sales', query: { businessDate } }, { signal });
  if (data?.businessDate !== businessDate || !Array.isArray(data.hours) || !Array.isArray(data.visits)
      || !Array.isArray(data.menuFrequency) || !Array.isArray(data.soldToday)) {
    throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  }
  return data;
}

const noticeSaved = 'data.management.notice.saved';
const receiptBase = couponPath;

export const couponsAdapter: DomainAdapter = {
  domain: 'coupons',
  sources: ['coupons', 'slot-coupon', 'expiry-coupon', 'coupon-status', 'customers', 'members', 'stock', 'inventory', 'menu', 'pos.sales', 'pos.receipts'],
  tables: ['realCoupons'],
  clear: () => ({ realCoupons: undefined }),
  merge(snapshot, tables) {
    if (!Object.hasOwn(tables, 'realCoupons') && !Object.hasOwn(tables, 'marketing')) return tables;
    const model = Object.hasOwn(tables, 'realCoupons') ? tables.realCoupons : snapshot.tables.realCoupons;
    return { ...tables, marketing: { ...(tables.marketing ?? snapshot.tables.marketing), ...couponFields(model?.coupons ?? []) } };
  },
  errorKeys: {
    NO_CONSENT: 'data.marketing.error.noConsent', NO_RECIPIENTS: 'data.marketing.error.noRecipients',
    NO_REMINDER_RECIPIENTS: 'data.marketing.error.noReminderRecipients', EXPIRY_ALREADY_MADE: 'data.marketing.error.expiryAlreadyMade',
    NO_EXPIRY_STOCK: 'data.marketing.error.noExpiryStock', COST_UNKNOWN: 'data.state.expiry-coupon.partial',
    COUPON_NOT_ACTIVE: 'data.marketing.error.couponNotActive', OVER_LIMIT: 'data.marketing.error.overLimit',
    PERCENT_RANGE: 'data.marketing.error.percentRange', AMOUNT_RANGE: 'data.marketing.error.amountRange',
    SET_PRICE_RANGE: 'data.marketing.error.setPriceRange', OVER_PRICE: 'data.marketing.error.overPrice',
    NIGHT_SEND_NOT_ALLOWED: 'widget.slot-coupon.nightBlocked',
  },
  async load(context) {
    const { reads, signal } = context;
    const options = { signal };
    const path = { resource: 'coupons', path: couponPath, query: { status: 'all', limit: 200 } };
    const page = await reads.page<CouponDto>(path, options) as ListPage<CouponDto> & { readonly businessDate?: string };
    const businessDate = page.businessDate;
    if (!isIsoDate(businessDate)) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
    const listed = page.nextCursor === null ? { ...page, complete: true } : await reads.all<CouponDto>(path, options);
    const [usage, naver, items, lots, menus, members, forecast, salesData] = await Promise.all([
      optional(reads.one<CouponUsageDto>({ resource: 'coupon-usage', path: `${couponPath}/usage`,
        query: { from: businessDate.slice(0, 8) + '01', to: businessDate } }, options)),
      optional(reads.one<NaverLedgerDto>({ resource: 'naver-coupons', path: '/marketing/naver-coupons' }, options)),
      optional(reads.all<StockItemDto>({ resource: 'coupon-stock', path: '/inventory/items', query: { businessDate, limit: 200 } }, options)),
      optional(reads.all<StockBatchDto>({ resource: 'coupon-lots', path: '/inventory/stock-batches', query: { expiresOn: businessDate, limit: 200 } }, options)),
      optional(reads.all<MenuDto>({ resource: 'coupon-menus', path: '/inventory/menu', query: { limit: 100 } }, options)),
      optional(reads.all<MemberDto>({ resource: 'coupon-customers', path: '/customers', query: { marketingEligible: 'true', limit: 100 } }, options)),
      optional(reads.one<StockForecastDto>({ resource: 'coupon-stock-forecast', path: `/inventory/forecasts/${businessDate}/weekday-4w-v1` }, options)),
      optional(sales(context, businessDate)),
    ]);
    const coupons = listed.items;
    const slotReady = !!salesData && !!menus?.complete && !!members?.complete;
    const expiryReady = !!items?.complete && !!lots?.complete && !!menus?.complete;
    const realCoupons: RealCouponData = {
      coupons, businessDate, localAt: memberDateTime(listed.asOf).replace(' ', 'T'),
      status: statusModel(coupons, businessDate, usage), naver,
      slots: slotModel(businessDate, coupons, salesData, members?.complete ? members.items : [], menus?.complete ? menus.items : []),
      expiry: expiryModel(businessDate, coupons, expiryReady ? items.items : [], lots?.items ?? [],
        menus?.items ?? [], members?.complete ? members.items : [], salesData ? forecast : null,
        new Map(salesData?.soldToday.map(({ menuId, quantity }) => [menuId, quantity]))),
      missing: [...(!slotReady ? ['slot-coupon' as const] : []),
        ...(!expiryReady || forecast?.status !== 'ready' || forecast.stale || !salesData ? ['expiry-coupon' as const] : []),
        ...(!usage ? ['coupon-status' as const] : [])],
    };
    return {
      tables: { realCoupons }, asOf: listed.asOf, sourceRevision: Math.max(listed.sourceRevision, usage?.sourceRevision ?? 0),
      complete: listed.complete,
      revisions: Object.fromEntries(coupons.flatMap(row => [[couponKey(row.couponId), row.revision], ...row.codes.map(code => [codeKey(code.codeId), code.revision])])),
    };
  },
  commands: [
    defineBinding({ type: 'coupon.sendSlot', noticeKey: 'data.notices.notice.scheduled', request: (command, context) => {
      const model = context.snapshot.tables.realCoupons?.slots;
      const slots = command.slotIds.map(id => model?.openSlots.find(slot => slot.slotId === id));
      if (!slots.length || slots.some(slot => !slot)) throw new PortError(409, 'CONFLICT', 'SLOT_ALREADY_HANDLED');
      const eligible = new Set(slots.flatMap(slot => slot!.regularIds));
      if (!command.recipientIds.length || command.recipientIds.some(id => !eligible.has(id))) throw new PortError(400, 'VALIDATION', 'NO_CONSENT');
      if (!model?.benefits.options.some(value => value.id === command.benefit)) throw new PortError(400, 'VALIDATION', 'BENEFIT_INVALID');
      const at = context.snapshot.tables.realCoupons!.localAt;
      const hour = Number(at.slice(11, 13));
      if (command.sendAt && isNightHour(Number(command.sendAt.slice(11, 13)))) throw new PortError(400, 'VALIDATION', 'NIGHT_SEND_NOT_ALLOWED', 'sendAt');
      const sendAt = command.sendAt ?? (isNightHour(hour) ? `${addDays(at.slice(0, 10), 1)}T08:00` : undefined);
      return { method: 'POST', path: `${couponPath}/slot`, body: {
        slots: slots.map(slot => ({ slotId: slot!.slotId, date: slot!.date, startHour: slot!.startHour, endHour: slot!.endHour })),
        benefitId: command.benefit, recipientIds: command.recipientIds, ...(command.messageEdits ? { body: command.messageEdits } : {}), ...(sendAt ? { sendAt } : {}),
      } };
    } }),
    defineBinding({ type: 'coupon.createExpiry', receiptBase, noticeKey: 'data.marketing.notice.couponCreated', request: (command, context) => {
      const item = context.snapshot.tables.realCoupons?.expiry.items.find(row => row.itemId === command.itemId || row.lotId === command.itemId);
      if (!item) throw new PortError(400, 'VALIDATION', 'NO_EXPIRY_STOCK', 'itemId');
      if (item.handled) throw new PortError(409, 'CONFLICT', 'EXPIRY_ALREADY_MADE', 'itemId');
      return { method: 'POST', path: `${couponPath}/expiry`, body: { itemId: item.itemId, batchId: item.lotId, menuId: item.menuId, benefit: command.benefit, route: command.route } };
    } }),
    defineBinding({ type: 'coupon.markPosted', noticeKey: 'data.marketing.notice.counting', request: ({ codeId }) => ({
      method: 'POST', path: `${codePath(codeId)}/mark-posted`, body: {},
    }) }),
    ...(['pause', 'resume', 'extend'] as const).map(action => defineBinding({
      type: `coupon.${action}`, receiptBase, noticeKey: noticeSaved, request: ({ couponId }, context) => ({
        method: 'POST', path: `${rowPath(couponId)}/${action}`, expectedRevision: revision(context, couponKey(couponId)),
      }),
    })),
    defineBinding({ type: 'coupon.update', receiptBase, noticeKey: noticeSaved, request: ({ couponId, benefitValue, quantity }, context) => ({
      method: 'PATCH', path: rowPath(couponId), body: { benefitValue, quantity }, expectedRevision: revision(context, couponKey(couponId)),
    }) }),
    defineBinding({ type: 'coupon.endEarly', receiptBase, noticeKey: 'data.marketing.notice.couponEnded', request: ({ couponId }, context) => ({
      method: 'POST', path: `${rowPath(couponId)}/end`, body: { confirmed: true }, expectedRevision: revision(context, couponKey(couponId)),
    }) }),
    defineBinding({ type: 'coupon.unpublish', receiptBase, noticeKey: 'data.marketing.notice.couponUnpublished', request: ({ codeId }, context) => ({
      method: 'POST', path: `${codePath(codeId)}/unpublish`, body: { confirmed: true }, expectedRevision: revision(context, codeKey(codeId)),
    }) }),
    defineBinding({ type: 'coupon.notifyEnding', noticeKey: 'data.notices.notice.scheduled', request: ({ couponId }) => ({
      method: 'POST', path: `${rowPath(couponId)}/notify-ending`, body: {},
    }) }),
  ],
};
