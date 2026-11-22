import { cafeMenuPhoto } from './cafe-menu-photos';
import { cafeMemberId } from './cafe-identity';
import { cafeMenuCategory } from '../reality/01/menu-category';
import type { PosDrawerSnapshot } from '../../contracts/pos';
import { createCustomOrderSeed } from '../iteration7/custom-orders/seed';
import { createEnvironmentSeed } from '../iteration7/environment/seed';
import { createNoticeSeed } from '../iteration7/notices/seed';
import { createStaffSeed } from '../iteration7/staff/seed';
import { createMarketingSeed } from '../marketing/seed';
import { STORE_HOURS, STORE_WEEKDAYS, storeHoursGrounding } from '../store-hours';
import { seedCatalog, seedCctvHistoryScale, seedClosingHistory, seedHistory, seedMembers, seedOperations, seedSupplement, seedToday } from './cafe-fixtures';
import { fixtureOccurred, rebaseFixtureDates } from './fixture-dates';
import manifest from './generated/manifest.json';
import { deepFreeze } from './freeze';
import { addDays, dateRange, NOW, TODAY, TOMORROW, weekdayOf } from './time';
import type { CalendarEvent, DataTables, DemandBand, Reservation, SeedOverrides, ThreadStatus } from './types';

export { deepFreeze } from './freeze';
export const SALES_START = rebaseFixtureDates(manifest.generator.start);
export const DEFAULT_STORE_NAME = manifest.store.name;

const key = (key: string) => ({ key });
const raw = (raw: string) => ({ raw });
const seedText = (text: string) => `seed:${text}`;
const days = [...seedHistory.days, seedToday.rollup];
const memberById = new Map(seedMembers.members.map(row => [row.memberId, row]));
const memberByCustomer = new Map(seedMembers.members.map(row => [row.customerId, row]));
const supplierByDbId = new Map<string, (typeof seedCatalog.suppliers)[number]>(seedCatalog.suppliers.map(row => [row.dbId, row]));
const menuById = new Map<string, (typeof seedCatalog.menu)[number]>(seedCatalog.menu.map(row => [row.menuId, row]));
const expiryById = new Map<string, (typeof seedSupplement.expiryBatches)[number]>(seedSupplement.expiryBatches.map(row => [row.itemId, row]));
const categoryOf = (category: string): NonNullable<CalendarEvent['categoryId']> => category === 'purchasing' || category === 'tax-admin' ? category : 'store-operations';

function demandTables(): Pick<DataTables, 'demandHourly' | 'demandDay' | 'demandForecast' | 'demandActual' | 'hiringLoad'> {
  const hourly = dateRange(TODAY, addDays(TOMORROW, 6)).flatMap(targetDate => {
    const weekDay = weekdayOf(targetDate);
    const [open, close] = STORE_HOURS[STORE_WEEKDAYS[weekDay - 1]];
    const comparable = seedHistory.days.filter(day => weekdayOf(day.date) === weekDay).slice(-4);
    return Array.from({ length: Math.ceil(Number(close.slice(0, 2)) + Number(close.slice(3)) / 60) - Number(open.slice(0, 2)) }, (_, i) => {
      const hour = Number(open.slice(0, 2)) + i;
      const average = Math.round(comparable.reduce((total, day) => total + day.hourly[hour], 0) / comparable.length);
      const expected = comparable.at(-1)?.hourly[hour] ?? 0;
      return { targetDate, hour, expected, average };
    });
  });
  const bands: readonly DemandBand[] = ['morning', 'afternoon', 'evening'];
  const bandOf = (hour: number): DemandBand => hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const demandDay = [...new Set(hourly.map(row => row.targetDate))].map(targetDate => {
    const rows = hourly.filter(row => row.targetDate === targetDate);
    const peak = [...rows].sort((a, b) => b.expected - a.expected)[0].hour;
    return { targetDate, busyStart: peak, busyEnd: peak + 1, weatherKey: 'data.weather.clear', eventKey: null };
  });
  return {
    demandHourly: hourly, demandDay,
    demandForecast: demandDay.flatMap(({ targetDate }) => bands.map(band => {
      const rows = hourly.filter(row => row.targetDate === targetDate && bandOf(row.hour) === band);
      return { targetDate, band, expected: rows.reduce((n, row) => n + row.expected, 0), baseline: rows.reduce((n, row) => n + row.average, 0), adjWeather: 0, adjEvent: 0 };
    })),
    demandActual: days.map(day => ({ date: day.date, total: day.orders })),
    hiringLoad: hourly.slice(0, 7 * 24).map(row => ({ weekday: weekdayOf(row.targetDate), hour: row.hour, level: Math.min(4, Math.ceil(row.average / 8)) })),
  };
}

function historyDrawers(): DataTables['dayClosing'] {
  const rollups = new Map(seedHistory.days.map(row => [row.date, row]));
  return seedClosingHistory.map(row => {
    const day = rollups.get(row.businessDate)!;
    const cash = row.drawerSnapshot;
    const drawerSnapshot: PosDrawerSnapshot = {
      opening: cash.opening, actual: cash.actual, expected: cash.expected, difference: cash.difference,
      cashNet: cash.cashNet, approvedCash: cash.cashNet + day.cancelByMethod.cash + day.refundByMethod.cash,
      cashPayments: cash.cashNet + day.cancelByMethod.cash + day.refundByMethod.cash, pendingCash: 0,
      cashCanceled: day.cancelByMethod.cash, cashRefunded: day.refundByMethod.cash, cashReturned: day.cancelByMethod.cash + day.refundByMethod.cash, in: 0, out: 0, memo: '', movements: [],
    };
    const salesSnapshot = {
      gross: day.gross, discount: day.discount, refund: day.refund, net: day.net, byMethod: day.byMethod, methodCounts: day.methodCounts,
      paymentCount: day.paymentCount, refundCount: day.refundCount,
    };
    return {
      closingId: row.closingId, businessDate: row.businessDate, generation: row.generation, closedAt: row.closedAt,
      status: 'closed', scenario: 'normal', paymentRevision: row.basedOnRevision, drawerSnapshot, salesSnapshot,
      posTotalsSnapshot: { ...salesSnapshot, revenue: day.net, charged: day.net + day.refund + day.canceled,
        canceled: day.canceled, cancelCount: day.cancelCount, pendingBillCount: 0, pendingReceived: 0,
        discountBySource: day.discountBySource },
    };
  });
}

function visitReservations(): Reservation[] {
  const fromDb: Reservation[] = seedToday.bookings.map(row => {
    const member = memberById.get(row.memberId)!;
    return {
      ...row, memberId: cafeMemberId(row.memberId), kind: 'visit', nameKey: seedText(member.maskedName), guestName: raw(member.maskedName),
      requestKey: null, callId: null, proposedTime: null, variant: null,
    };
  });
  const examples: Reservation[] = seedSupplement.bookings.map(row => ({
    ...row, memberId: cafeMemberId(row.memberId), kind: 'visit', time: row.start, nameKey: seedText(row.memberName), guestName: raw(row.memberName),
    requestKey: seedText(row.request), request: raw(row.request), source: 'direct', assignmentMode: 'auto', capacityOverride: false,
    confirmedBy: row.status === 'confirmed' ? 'auto' : null, callId: null, proposedTime: null, variant: null,
  }));
  return [...fromDb, ...examples];
}

type SeedThread = (typeof seedOperations.threads)[number];
type Inquiry = DataTables['inquiryThread'][number];

function reviewSentiment(row: SeedThread): Inquiry['sentiment'] {
  if (row.type !== 'review') return null;
  if (row.sentiment === 'positive' || row.sentiment === 'neutral' || row.sentiment === 'negative') return row.sentiment;
  if (row.rating === null) return null;
  return row.rating >= 4 ? 'positive' : row.rating === 3 ? 'neutral' : 'negative';
}

function personReason(row: SeedThread, sentiment: Inquiry['sentiment']): Inquiry['needsPersonReason'] {
  if (row.status === 'done') return null;
  if (/환불|결제 취소/.test(row.body)) return 'refund';
  if (/연락처|010-\d{4}-\d{4}|영수증|카드 끝자리|개인정보/.test(row.body)) return 'privacy';
  if (sentiment === 'negative' || /불만|항의|컴플레인/.test(row.body)) return 'complaint';
  if (row.type === 'review') return null;
  // Only ordinary questions answered by the store guide can skip human confirmation.
  const guided = /영업시간|운영시간|오픈 시간|가게 위치|매장 위치|주차/.test(row.body);
  return guided && !/시험기간|임시|더 일찍|더 늦게/.test(row.body) ? null : 'no-ground';
}

// Browse-only demo posts. The cafe seed has one direct offer and no public listings.
const browseOffers: DataTables['partnershipOffer'] = [
  ['study', '상도 스터디룸', '시험기간 공부 공간과 음료 제휴', '공부 공간', '스터디룸 예약 손님에게 카페 음료 안내'],
  ['flowers', '상도 꽃작업실', '연말 꽃다발과 카페 방문 공동 행사', '꽃집', '참여 가게에서 서로의 행사 안내문 비치'],
  ['campus', '숭실대 공방거리', '주말 공방 체험과 디저트 산책', '공방', '체험 일정과 카페 메뉴를 함께 안내'],
].map(([id, store, title, category, terms], index) => ({
  offerId: `sample-community-public-${id}`, visibility: 'public', fromStoreKey: seedText(store), titleKey: seedText(title),
  categoryKey: seedText(category), termsKey: seedText(terms), periodStart: addDays(TODAY, 4 + index),
  periodEnd: addDays(TODAY, 11 + index), respondBy: `${addDays(TODAY, 3 + index)}T18:00`, status: 'pending', sharedContactKey: null,
}));

function buildSeed(): DataTables {
  const reservations = visitReservations();
  const extracted = { date: TODAY, time: '20:00', party: manifest.store.seats + 1, requestKey: 'data.reservation.request.group' };
  const groupCall = {
    callId: 'sample-call-over-capacity', time: `${TODAY}T14:00`,
    summary: { key: 'data.call.summary.overCapacity', params: { time: extracted.time, party: extracted.party } },
    extracted,
    status: 'processed' as const, variant: 'needs-confirmation',
  };
  const groupReservation: Reservation = {
    kind: 'visit', reservationId: 'sample-booking-over-capacity', date: TODAY, time: groupCall.extracted.time,
    partySize: groupCall.extracted.party, nameKey: 'data.person.jang', requestKey: groupCall.extracted.requestKey,
    source: 'phone_ai', status: 'needs-check', confirmedBy: null, callId: groupCall.callId, proposedTime: null, variant: groupCall.variant,
  };
  const custom = createCustomOrderSeed().tables;
  const purchaseOrder: DataTables['purchaseOrder'] = seedOperations.purchaseOrders.map(({ poId, supplierId, orderedOn, dueDate, expectedTime, status }) => ({
    poId, supplierId, orderedOn, dueDate, expectedTime, status: status as DataTables['purchaseOrder'][number]['status'], variant: null,
  }));
  const purchaseOrderLine: DataTables['purchaseOrderLine'] = seedOperations.purchaseOrders.flatMap(({ lines, poId }) =>
    lines.map(({ polId, itemId, unit, basePerUnit, qtyOrdered, unitPrice, itemName }) => ({
      polId, poId, itemId, unit, basePerUnit, qtyOrdered, unitPrice, itemName,
      itemNameSnapshot: raw(itemName), unitSnapshot: unit as DataTables['purchaseOrderLine'][number]['unitSnapshot'],
    })),
  );
  const receipt = seedOperations.purchaseOrders.flatMap(po => po.lines.flatMap(line => line.receipts.map(r => ({ ...r, polId: line.polId }))));
  const recipeLine = seedCatalog.menu.flatMap(menu => menu.recipeBase.map(part => ({
    recipeLineId: `recipe:${menu.menuId}:${part.itemId}`, menuId: menu.menuId, itemId: part.itemId, quantity: part.quantityBase, unit: part.unitDimension,
  })));
  const receiptByDay = new Map<string, number>();
  for (const po of seedOperations.purchaseOrders) for (const line of po.lines) for (const r of line.receipts) {
    const id = `${r.receivedAt.slice(0, 10)}:${line.itemId}`;
    receiptByDay.set(id, (receiptByDay.get(id) ?? 0) + r.qty * line.basePerUnit);
  }
  const stockOpening = seedToday.stock.flatMap(row => {
    let opening = row.opening;
    const history = [...seedHistory.days].reverse().map(day => {
      const used = day.menu.reduce((total, [id, qty]) => total + (menuById.get(id)?.recipeBase.find(part => part.itemId === row.itemId)?.quantityBase ?? 0) * qty, 0);
      opening += used - (receiptByDay.get(`${day.date}:${row.itemId}`) ?? 0);
      return { itemId: row.itemId, businessDate: day.date, quantityBase: opening };
    });
    return [{ itemId: row.itemId, businessDate: TODAY, quantityBase: row.opening }, ...history];
  });
  const calendar: CalendarEvent[] = seedOperations.calendar.map(row => ({
    ...row, categoryId: categoryOf(row.category), kind: row.kind === 'todo' ? 'todo' : 'event', title: raw(row.title), memo: null,
    storeClosure: row.closureKind && row.closureEndDate ? { kind: row.closureKind === 'regular' ? 'regular' : 'temporary', endDate: row.closureEndDate } : null,
  }));
  const cctvHistory = seedHistory.days.slice(-7).flatMap(day => day.hourly.flatMap((orders, hour) => orders ? [{
    businessDate: day.date, hour, entries: Math.round(orders * seedCctvHistoryScale), status: 'ok' as const, reviewMarked: false, provenance: 'sample' as const,
  }] : []));
  const groupCallOccurred = fixtureOccurred(groupCall.time);
  const guideId = 'cafe-store-guide';
  return {
    dailySales: days.map(day => ({
      businessDate: day.date, gross: day.gross, discount: day.discount, refund: day.refund, recognizedNet: day.net,
      card: day.byMethod.card, easyPay: day.byMethod.easy_pay, cash: day.byMethod.cash,
    })),
    menuDaily: days.flatMap(day => day.menu.map(([menuId, qty, gross, discount, refund, cost]) => ({
      businessDate: day.date, menuId, qty, netSales: gross - discount - refund, unitCost: qty ? cost / qty : 0, totalCost: cost,
    }))),
    menuItem: seedCatalog.menu.map(row => {
      const category = cafeMenuCategory(row);
      return {
        ...row, nameKey: seedText(row.name), name: raw(row.name), category, categoryKey: `data.management.category.${category}`, seasonal: row.season,
        // AC-1055 demo memo. The DB has no note for the cafe latte.
        memo: row.memo ? raw(row.memo) : row.menuId === 'm-cafe-latte' ? raw('우유는 매일 아침 한강목장 유업유통') : null,
        costEffectiveFrom: row.activeFrom ?? SALES_START, recipe: [], prepMin: row.prepMin, photoKey: null, customPhotoUrl: cafeMenuPhoto(row.menuId), optionGroups: row.groups,
      };
    }),
    menuOption: [],
    expense: seedOperations.expenses.map(row => ({
      ...row, category: row.category as DataTables['expense'][number]['category'], evidence: 'none', status: 'confirmed', memo: row.memo ? raw(row.memo) : null,
    })),
    taxReview: seedOperations.expenses.map(row => ({ refType: 'expense', refId: row.expenseId, status: row.taxCheck === 'needs-check' ? 'needs-check' : 'checked' })),
    taxPayment: seedSupplement.taxPayments.map(row => ({ ...row, taxPaymentId: row.id, type: raw(row.type), evidence: 'example' })),
    grantNotice: seedSupplement.grants.map(row => ({
      ...row, noticeId: row.id, titleKey: seedText(row.title), agencyKey: seedText(row.agency), regionKey: seedText(row.region),
      applyStart: `${row.applyStart}T09:00`, applyEnd: `${row.applyEnd}T18:00`, conditionKeys: row.conditions.map(seedText), summaryKey: seedText(row.summary),
      template: raw(row.title), guide: raw(row.summary),
    })),
    grantReview: [], grantApplication: [],
    cctvHourly: [...cctvHistory, ...seedSupplement.cctv.map(row => ({ ...row, businessDate: row.date, reviewMarked: false }))],
    cctvCamera: seedSupplement.cameras.map(row => ({ ...row, name: raw(row.name), stillImageKey: '' })),
    ...createStaffSeed(),
    shift: seedSupplement.shifts.map(row => ({ ...row, staffKey: seedText(seedSupplement.staff.find(staff => staff.staffId === row.staffId)!.name), source: 'roster' })),
    ...demandTables(),
    jobPostDraft: null,
    membershipProduct: seedOperations.membershipProducts.map(row => ({ ...row, nameKey: seedText(row.name), kind: 'count' })),
    membership: [...seedOperations.memberships, ...seedSupplement.activePasses].map(row => ({
      ...row, memberId: cafeMemberId(row.memberId), customerKey: seedText(memberById.get(row.memberId)!.maskedName), status: row.status === 'active' ? 'active' : 'ended',
    })),
    membershipUse: seedOperations.membershipUses,
    ...createNoticeSeed(), ...createEnvironmentSeed(),
    customTemplate: custom.customTemplate, customOrder: custom.customOrder, reservation: [...reservations, ...(groupCallOccurred ? [groupReservation] : []), ...custom.reservation.filter(row => row.kind === 'pickup')],
    callLog: groupCallOccurred ? [groupCall] : [], reservationChange: seedToday.bookings.filter(row => row.status !== 'confirmed').map(row => ({
      changeId: `reservation-status:${row.reservationId}`, reservationId: row.reservationId, at: row.at, kind: 'status', before: { status: 'confirmed' }, after: { status: row.status },
    })),
    calendarEvent: [...calendar, ...seedSupplement.calendar.map(row => ({ ...row, categoryId: categoryOf(row.category), title: raw(row.title), memo: null }))],
    calendarSettings: { pickup: true, delivery: true, reservation: false, shift: true, deadline: true, direct: true },
    categoryVisibility: { 'store-operations': true, purchasing: true, 'tax-admin': true },
    inventoryItem: seedCatalog.items.map(row => {
      const expiry = expiryById.get(row.itemId);
      return { ...row, name: raw(row.name), nameKey: seedText(row.name), kind: 'ingredient', unit: row.unitDimension, lowStockPerChannel: null,
        sales7d: null, updatedAt: NOW, trackExpiry: !!expiry, expiresOn: expiry?.expiresOn ?? null };
    }),
    inventoryStock: seedToday.stock.map(row => ({ ...row, qty: row.onHand })),
    inventoryTxn: receipt.map(r => ({
      txnId: r.movementId, type: 'receive', itemId: purchaseOrderLine.find(line => line.polId === r.polId)!.itemId,
      qty: r.qty, channel: 'store', ref: r.receiptId, at: r.receivedAt, idempotencyKey: r.movementKey,
    })),
    stockOpening, stockAdjustment: [],
    supplier: seedCatalog.suppliers.map(row => ({ ...row, nameKey: seedText(row.name), name: raw(row.name), contactKey: seedText(row.contact), contact: raw(row.contact), memo: raw(row.memo) })),
    purchaseItem: seedCatalog.items.map(({ itemId, purchase }) => ({
      itemId, purchaseItemId: purchase.purchaseItemId, supplierId: supplierByDbId.get(purchase.supplierDbId)!.supplierId,
      minimumQty: purchase.minimum, orderStep: purchase.step, purchaseUnit: purchase.unit, unitPrice: purchase.unitPrice,
      basePerUnit: purchase.basePerUnit, leadDays: purchase.leadDays,
    })),
    recipeLine, purchaseOrder, purchaseOrderLine, receipt,
    memberProfile: seedMembers.members.map(row => ({ memberId: row.code, dbMemberId: row.memberId, memberCode: row.code, customerId: row.customerId, joinedOn: row.joinedOn, gradeOverride: null })),
    memberNote: [],
    manual: [...seedOperations.manuals.map(row => ({
      ...row, category: row.category as DataTables['manual'][number]['category'], section: 'handover' as const, title: raw(row.title), cautions: raw(row.cautions),
    })), { manualId: guideId, title: key('data.management.info.hours'), category: 'store-info', section: 'store-info', updatedAt: NOW, isPublished: true }],
    manualStep: [...seedOperations.manuals.flatMap(row => row.steps.map(step => ({ manualId: row.manualId, stepNo: step.stepNo, body: raw(step.body) }))),
      { manualId: guideId, stepNo: 1, body: raw(`${manifest.store.name}\n${manifest.store.address}\n${storeHoursGrounding()}`) }],
    checklistLog: [], manualDraft: [],
    floorSpace: { photoKeys: [], planGenerated: false },
    floorLayout: [{ layoutId: seedCatalog.layout.layoutId, name: key('data.layout.current'), isCurrent: true, aisleCm: 100 }],
    tableSpot: seedCatalog.tables.map(table => ({ ...table, layoutId: table.layoutDbId, zone: table.number <= 4 ? 'window' : table.seats > 4 ? 'bar' : 'center' })),
    interiorPlan: { mood: 'warm-wood', materials: ['wood', 'gray'], memo: key('data.interior.memo.window') },
    localChange: [
      ...seedOperations.calendar.flatMap(row => row.localRange ? [{ changeId: row.eventId, titleKey: seedText(row.title), kind: 'event' as const, whenKey: 'data.localChange.when.event',
        startDate: row.localRange[0], endDate: row.localRange[1], distanceM: 0, sameCategory: false, sourceKey: 'data.source.sample', updatedAt: `${row.date}T08:00`, ackedAt: null }] : []),
      ...seedSupplement.localChanges.map(row => ({
        ...row, changeId: row.id, titleKey: seedText(row.title), whenKey: `data.localChange.when.${row.kind}`, sameCategory: false,
        sourceKey: 'data.source.sample', ackedAt: null,
      })),
    ],
    footTraffic: seedSupplement.tradeArea,
    trendKeyword: seedSupplement.trends.map(row => ({ ...row, keywordId: row.id, keywordKey: seedText(row.keyword), categoryKey: seedText(row.category), prevMentions: row.previousMentions })),
    inquiryThread: seedOperations.threads.map(row => {
      const channelKey = row.type === 'review' ? 'data.channel.naverReview' : row.type === 'call' ? seedText('전화') :
        row.channel.includes('네이버') ? 'data.channel.naverTalk' : row.channel.includes('카카오') ? 'data.channel.kakao' : seedText(row.channel);
      const sentiment = reviewSentiment(row);
      return { ...row, channelKey, type: row.type as DataTables['inquiryThread'][number]['type'], status: row.status as ThreadStatus,
        bodyKey: seedText(row.body), draftKey: null, groundKeys: [], needsPersonReason: personReason(row, sentiment), sentiment,
        author: row.isPublic && row.customerId ? memberByCustomer.get(row.customerId)?.maskedName : null };
    }),
    autoReplyRule: ['data.channel.kakao', 'data.channel.naverTalk'].flatMap(channelKey => (['hours', 'location', 'parking'] as const).map(topic => ({ channelKey, topic, enabled: false }))),
    partnershipOffer: [...seedSupplement.community.map((row): DataTables['partnershipOffer'][number] => ({
      ...row, offerId: row.id, visibility: 'direct', fromStoreKey: seedText(row.store), titleKey: seedText(row.title), categoryKey: seedText(row.category),
      termsKey: seedText('행사 당일 방문 손님에게 공동 안내'), periodStart: row.startsOn, periodEnd: row.endsOn, respondBy: `${row.startsOn}T18:00`,
      status: 'pending', sharedContactKey: null,
    })), ...browseOffers],
    offerInterest: [], integration: { calendar: true, phone: true, pos: true, channels: true },
    marketing: createMarketingSeed(), appliedKeys: {}, commandLedger: {}, payment: [], paymentLine: [], dayClosing: historyDrawers(),
    shopSettings: {
      businessType: seedCatalog.store.businessType, paymentStyle: seedCatalog.store.paymentStyle, cctvPosLinks: [], revision: 0, layoutActivated: false,
      tableLayout: { layoutId: seedCatalog.layout.layoutId, columns: seedCatalog.layout.gridColumns, rows: seedCatalog.layout.gridRows, revision: seedCatalog.layout.revision,
        tables: seedCatalog.tables.map(row => ({ ...row, column: row.x - 1, row: row.y - 1 })) },
      posPreferences: { startTab: seedCatalog.store.posStartTab, userChoseStart: false, showStatus: true, showTables: false },
    },
  };
}
const BASE_SEED = deepFreeze(buildSeed());

/** Frozen default snapshot. Explicit regression fixture data lives in legacy-seed.ts. */
export function createSeedTables(overrides?: SeedOverrides): DataTables {
  return overrides ? deepFreeze({ ...BASE_SEED, ...overrides }) : BASE_SEED;
}
