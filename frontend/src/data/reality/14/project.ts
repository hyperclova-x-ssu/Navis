import { createTranslator } from '../../../i18n/translator';
import { addDays, weekdayOf } from '../../db/time';
import { formatMaskedCustomer } from '../../customer-display';
import { couponBenefit } from '../../marketing/benefit';
import { belowPercent, benefitComparison, expiryDiscount, PUBLIC_ISSUE_LIMIT, QUIET_THRESHOLD_PERCENT,
  RECOMMENDED_EXPIRY_RATE, roundPercent, SECOND_DISCOUNT_HOURS } from '../../marketing/calc';
import { routeNameKey } from '../../marketing/derive';
import type { CouponRow, CouponStatusModel, ExpiryCouponModel, ExpiryItem, MarketingTables,
  QuietSlot, SlotBenefitId, SlotCouponModel, SlotRecipient } from '../../marketing/types';
import type { MenuDto } from '../01/menu-dto';
import type { CouponSales } from '../../../../../backend/services/pos/reality/02/coupon-sales';
import { baseQuantity, type StockBatchDto, type StockForecastDto, type StockItemDto } from '../03/stock-dto';
import type { MemberDto } from '../05/dto';
import type { CouponDto, CouponTermsDto, CouponUsageDto, NaverLedgerDto } from './dto';

export interface RealCouponData {
  readonly coupons: readonly CouponDto[];
  readonly businessDate: string;
  readonly localAt: string;
  readonly status: CouponStatusModel;
  readonly slots: SlotCouponModel | null;
  readonly expiry: ExpiryCouponModel;
  readonly naver: NaverLedgerDto | null;
  readonly missing: readonly ('slot-coupon' | 'expiry-coupon' | 'coupon-status')[];
}

export const raw = (text: string) => ({ raw: text });
const enDate = createTranslator('en').format.date;
export const hasMarketingConsent = (member: MemberDto) => member.consent.contactAllowed && member.consent.marketingAllowed;

const terms = (dto: CouponTermsDto) => ({ benefitType: dto.benefitType, benefitValue: dto.benefitValue, targetMenuId: dto.targetRef, endsOn: dto.endsOn });

export function realCouponRow(dto: CouponDto): CouponRow {
  return {
    ...terms(dto), couponId: dto.couponId, origin: dto.origin, name: raw(dto.name), status: dto.status,
    startsOn: dto.startsOn, daysLeft: dto.daysLeft, endingSoon: dto.endingSoon, issued: dto.issued, used: dto.used,
    reminderRecipients: dto.reminderTargets, canPause: dto.canPause, canResume: dto.canResume, canExtend: dto.canExtend, canNotify: dto.canNotify,
    routes: dto.codes.map(code => ({ codeId: code.codeId, code: code.code, route: code.route, routeNameKey: routeNameKey(code.route),
      issued: code.activated ? code.issueCount : 0, used: code.used, active: code.activated && !code.unpublishedAt, videoId: null })),
  };
}

export function couponFields(coupons: readonly CouponDto[]): Pick<MarketingTables,
  'coupon' | 'couponCode' | 'couponRedemptionAgg' | 'couponTarget' | 'couponReminder' | 'messageSend' | 'couponUsageBeforeMonth' | 'expiryForecast'> {
  return {
    coupon: coupons.map(row => ({ ...terms(row), couponId: row.couponId, name: raw(row.name), status: row.status, origin: row.origin,
      startsOn: row.startsOn, originRef: row.originRef, validHours: row.validHours, maxDiscountRate: row.basis?.maxRatePercent ?? null,
      createdAt: row.createdAt, futureIssueCount: row.futureIssueCount ?? undefined })),
    couponCode: coupons.flatMap(row => row.codes.map(code => ({ codeId: code.codeId, couponId: row.couponId, code: code.code,
      route: code.route, issueCount: code.issueCount, videoId: null, activatedAt: code.activatedAt,
      issuedTerms: code.issuedTerms ? terms(code.issuedTerms) : undefined, unpublishedAt: code.unpublishedAt ?? undefined }))),
    couponRedemptionAgg: coupons.flatMap(row => row.codes.map(({ codeId, used, discountSum }) => ({ codeId, used, discountSum }))),
    couponTarget: [], couponReminder: [], messageSend: [], couponUsageBeforeMonth: undefined, expiryForecast: [],
  };
}

export function statusModel(coupons: readonly CouponDto[], businessDate: string, usage: CouponUsageDto | null): CouponStatusModel {
  const ascending = (a: CouponRow, b: CouponRow) => a.endsOn.localeCompare(b.endsOn) || a.couponId.localeCompare(b.couponId);
  const rows = coupons.filter(row => row.status !== 'ended').map(realCouponRow).sort(ascending);
  const ended = coupons.filter(row => row.status === 'ended' && row.endsOn.slice(0, 7) === businessDate.slice(0, 7))
    .map(realCouponRow).sort((a, b) => ascending(b, a));
  const total = (group: readonly CouponRow[], field: 'issued' | 'used') => group.reduce((sum, row) => sum + (row[field] ?? 0), 0);
  return { rows, ended, activeCount: rows.filter(row => row.status === 'active').length, pausedCount: rows.filter(row => row.status === 'paused').length,
    endingSoonCount: rows.filter(row => row.endingSoon).length, runningUsed: total(rows, 'used'), runningIssued: total(rows, 'issued'),
    endedUsed: total(ended, 'used'), endedIssued: total(ended, 'issued'), monthUsed: usage?.used ?? null, monthIssued: usage?.issued ?? 0 };
}

export function slotModel(day: string, coupons: readonly CouponDto[], sales: CouponSales | null,
  members: readonly MemberDto[], menus: readonly MenuDto[]): SlotCouponModel | null {
  const sent = coupons.filter(coupon => coupon.origin === 'slot');
  const handled = new Set(sent.filter(coupon => coupon.status !== 'ended').flatMap(coupon => coupon.originRef.slotIds ?? []));
  const eligible = members.filter(hasMarketingConsent);
  const window = { start: addDays(day, 1), end: addDays(day, 7) };
  const endsOn = addDays(day, 13);
  const hours = sales?.hours ?? [];
  const observedDays = new Set(hours.map(row => row.businessDate));
  const weekdayCounts = new Map<number, number>();
  for (const date of observedDays) weekdayCounts.set(weekdayOf(date), (weekdayCounts.get(weekdayOf(date)) ?? 0) + 1);
  const byHour = new Map<number, { total: number; byWeekday: number[] }>();
  for (const row of hours) {
    const count = byHour.get(row.hour) ?? { total: 0, byWeekday: Array<number>(7).fill(0) };
    count.total += row.count;
    count.byWeekday[weekdayOf(row.businessDate)] += row.count;
    byHour.set(row.hour, count);
  }
  const visits = (sales?.visits ?? []).map(row => ({ ...row, weekday: weekdayOf(row.businessDate) }));
  const slots: QuietSlot[] = [];
  const recipients = new Map<string, SlotRecipient>();
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = addDays(day, offset), weekday = weekdayOf(date), days = weekdayCounts.get(weekday) ?? 0;
    if (days < 2) continue;
    const quiet = [...byHour.entries()].sort(([a], [b]) => a - b).flatMap(([hour, own]) => {
      const count = own.byWeekday[weekday];
      const expected = count / days, average = own.total / observedDays.size;
      return belowPercent(count * observedDays.size, own.total * days)
        ? [{ hour, expected, average, percent: roundPercent(expected / average * 100) }] : [];
    });
    for (let index = 0; index < quiet.length;) {
      const start = index++;
      while (index < quiet.length && quiet[index].hour === quiet[index - 1].hour + 1) index += 1;
      const run = quiet.slice(start, index);
      const startHour = run[0].hour, endHour = run.at(-1)!.hour + 1, slotId = `slot-${date}-${startHour}`;
      const slotVisits = visits.filter(row => row.weekday === weekday && row.hour >= startHour && row.hour < endHour);
      const regularIds = eligible.flatMap(member => {
        const dates = [...new Set(slotVisits.filter(row => row.memberId === member.memberId).map(row => row.businessDate))].sort();
        if (dates.length < 2) return [];
        const previous = recipients.get(member.customerId), last = dates.at(-1)!;
        if (!handled.has(slotId)) {
          recipients.set(member.customerId, { customerId: member.customerId,
            name: raw(formatMaskedCustomer(member.name, member.memberId, member.memberCode)), consentSms: true, consentNight: false, selectable: true, reasonKey: null,
            lastVisit: previous?.lastVisit && previous.lastVisit > last ? previous.lastVisit : last, slotIds: [...(previous?.slotIds ?? []), slotId] });
        }
        return [member.customerId];
      });
      const expected = run.reduce((sum, hour) => sum + hour.expected, 0), average = run.reduce((sum, hour) => sum + hour.average, 0);
      slots.push({ slotId, date, weekday, startHour, endHour, expected, average, percent: roundPercent(expected / average * 100),
        hours: run.map(({ hour, expected: prediction, average: usual, percent }) => ({ hour, expected: prediction, average: usual, percent })),
        handled: handled.has(slotId), regularIds });
    }
  }
  if (slots.length === 0 && sent.length === 0) return null;
  const frequency = new Map(sales?.menuFrequency.map(({ menuId, count }) => [menuId, count]));
  const basis = menus.filter(menu => menu.unitCost !== null && menu.saleStatus === 'selling' && frequency.has(menu.menuId))
    .sort((a, b) => (frequency.get(b.menuId) ?? 0) - (frequency.get(a.menuId) ?? 0))[0];
  const shot = basis?.groups.filter(group => !group.archivedAt).flatMap(group => group.options)
    .find(option => !option.archivedAt && (option.optionId === 'opt-extra-shot' || option.optionId.endsWith(':shot')));
  const menu = { menuId: basis?.menuId ?? '', nameKey: 'data.management.customMenu', name: raw(basis?.name ?? ''),
    price: basis?.price ?? 0, unitCost: basis?.unitCost ?? 0, shotCost: shot?.extraCost ?? 0 };
  const comparison = benefitComparison(menu, shot?.extraCost ?? null);
  const available = comparison.options.filter(option => basis && option.marginPerCoupon >= 0 && (option.id !== 'free-shot' || shot?.extraCost != null));
  const best = [...available].sort((a, b) => b.marginPerCoupon - a.marginPerCoupon);
  const recommendedId = best[0]?.id ?? 'percent-10';
  const benefits = { options: available.map(option => ({ ...option, recommended: option.id === recommendedId })), recommendedId,
    differenceVsNext: best.length > 1 ? best[0].marginPerCoupon - best[1].marginPerCoupon : 0 };
  const [startMonth, startDay] = window.start.slice(5).split('-').map(Number);
  const [endMonth, endDay] = window.end.slice(5).split('-').map(Number);
  const [untilMonth, untilDay] = endsOn.slice(5).split('-').map(Number);
  const dates = { startMonth, startDay, endMonth, endDay, untilMonth, untilDay, startEn: enDate(window.start, 'monthDay'),
    endEn: enDate(window.end, 'monthDay'), untilEn: enDate(endsOn, 'monthDay') };
  const bodies: SlotCouponModel['message']['bodies'] = {
    'free-shot': { key: 'data.marketing.sms.slotFreeShot', params: dates },
    'percent-10': { key: 'data.marketing.sms.slotPercent', params: { ...dates, p: 10 } },
    'amount-500': { key: 'data.marketing.sms.slotAmount', params: { ...dates, amount: 500 } },
  };
  const openSlots = slots.filter(slot => !slot.handled);
  return { window, thresholdPercent: QUIET_THRESHOLD_PERCENT, slots, openSlots, slotCount: openSlots.length,
    regularsCount: recipients.size, recipients: [...recipients.values()], menu, benefits,
    message: { body: bodies[recommendedId as SlotBenefitId], bodies }, endsOn, sent: sent.map(realCouponRow),
    canSend: openSlots.length > 0 && recipients.size > 0 && benefits.options.length > 0 };
}

export function expiryModel(day: string, coupons: readonly CouponDto[], stock: readonly StockItemDto[], lots: readonly StockBatchDto[],
  menus: readonly MenuDto[], members: readonly MemberDto[], forecast: StockForecastDto | null, soldByMenu: ReadonlyMap<string, number>): ExpiryCouponModel {
  const created = coupons.filter(row => row.origin === 'expiry' && row.businessDate === day);
  const items: ExpiryItem[] = [];
  for (const item of stock) {
    const open = lots.filter(lot => lot.itemId === item.itemId && !lot.discardedAt && lot.expiresOn === day && (baseQuantity(lot.remainingQuantityBase) ?? 0) > 0);
    if (open.length === 0) continue;
    const handled = (id: string) => created.some(row => (row.originRef.batchId ?? row.originRef.itemId) === id);
    const lot = open.find(candidate => !handled(candidate.batchId)) ?? open[0];
    const menu = menus.filter(row => row.saleStatus === 'selling' && row.recipeLines.some(line => line.itemId === item.itemId))
      .sort((a, b) => a.recipeLines.length - b.recipeLines.length || a.menuId.localeCompare(b.menuId))[0];
    if (!menu || !item.unit) continue;
    const base = baseQuantity(lot.remainingQuantityBase)!;
    const recipeQty = menu.recipeLines.filter(line => line.itemId === item.itemId).reduce((sum, line) => sum + line.quantity, 0) || 1;
    const stockQty = Math.floor(base / recipeQty);
    const expected = forecast?.status === 'ready' && !forecast.stale
      ? forecast.results.find(row => row.scope === 'menu' && row.targetId === menu.menuId)?.expected : undefined;
    const demandLeft = expected === undefined ? 0 : Math.max(0, Math.ceil(Number(expected) - (soldByMenu.get(menu.menuId) ?? 0)));
    const qty = Math.max(0, stockQty - demandLeft);
    if (!qty && !handled(lot.batchId)) continue;
    const limits = menu.unitCost === null ? null : expiryDiscount(menu.price, menu.unitCost, 0, qty);
    const recommendedRate = limits ? Math.min(RECOMMENDED_EXPIRY_RATE, limits.maxSliderRate) : null;
    items.push({ itemId: item.itemId, lotId: lot.batchId, nameKey: 'data.management.customMenu', name: raw(item.name ?? menu.name), menuName: menu.name,
      unit: 'pcs', stock: stockQty, qty, expiresOn: day, menuId: menu.menuId, price: menu.price, unitCost: menu.unitCost,
      maxRatePercent: limits?.maxRatePercent ?? null, maxSliderRate: limits?.maxSliderRate ?? null, recommendedRate,
      atRecommended: recommendedRate === null ? null : expiryDiscount(menu.price, menu.unitCost!, recommendedRate, qty),
      handled: handled(lot.batchId), issueLimit: item.unit === 'pcs' ? Math.min(PUBLIC_ISSUE_LIMIT, base) : PUBLIC_ISSUE_LIMIT });
  }
  const target = items.find(item => !item.handled) ?? items[0] ?? null;
  const pendingPosts = created.flatMap(coupon => coupon.codes.filter(code => code.eligible).map(code => {
    const benefit = couponBenefit(coupon)!;
    const name = coupon.originRef.menuName ?? coupon.name;
    const termsText = benefit.kind === 'percent' ? `${benefit.value}% 할인`
      : benefit.kind === 'amount' ? `${benefit.value.toLocaleString('ko-KR')}원 할인` : `세트 가격 ${benefit.value.toLocaleString('ko-KR')}원`;
    return { codeId: code.codeId, couponId: coupon.couponId, code: code.code, route: code.route,
      post: raw(`오늘만! ${name} ${termsText}. 계산할 때 쿠폰 코드를 보여 주세요: ${code.code}`) };
  }));
  return { items, target, routes: { sms: { recipients: members.filter(row => hasMarketingConsent(row) && row.recentVisitCount >= 2).length },
    placeNews: { issueLimit: target?.issueLimit ?? PUBLIC_ISSUE_LIMIT } }, secondDiscountHoursBeforeClose: SECOND_DISCOUNT_HOURS,
    created: created.map(realCouponRow), pendingPosts, canCreate: items.some(item => !item.handled && item.unitCost !== null) };
}
