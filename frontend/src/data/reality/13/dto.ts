import type { DataTables, LocalChange, PartnershipOffer, TrendKeyword } from '../../db/types';
import { STORE_HOURS, STORE_WEEKDAYS } from '../../store-hours';
import type { TradeAreaModel } from '../../models/types';

export interface PeriodDto { readonly from: string; readonly to: string }
export type ChangeKind = 'food-license' | 'festival' | 'owner-record';
export interface CoverageDto { readonly region: string; readonly kinds: readonly ChangeKind[]; readonly referenceDate: string }
export interface ChangeDto {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly kind: ChangeKind;
  readonly region: string;
  readonly authority: string;
  readonly sourceUrl: string | null;
  readonly dateKind: 'license-date' | 'event-date' | 'recorded-date';
  readonly referenceDate: string;
  readonly updatedAt: string;
  readonly acknowledgedAt: string | null;
}

export interface OfferDto {
  readonly id: string;
  readonly revision: number;
  readonly senderStoreId: string;
  readonly recipientStoreId: string;
  readonly title: string;
  readonly terms: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly respondBy: string;
  readonly interested: boolean;
  readonly canRespond: boolean;
  readonly sharedContact: string | null;
  readonly status: 'pending' | 'accepted' | 'declined';
}

export interface PeerDto { readonly storeId: string; readonly displayName: string }
type SourceStatus = 'available' | 'unavailable' | 'empty';
interface Series<T> { readonly status: SourceStatus; readonly items: readonly T[] }
export interface PopulationBand {
  readonly region: string;
  readonly quarter: string;
  readonly weekday: number;
  readonly startHour: number;
  readonly endHour: number;
  readonly estimate: number;
  readonly referenceDate: string;
  readonly refreshedAt: string;
  readonly sourceUrl: string;
}
export interface HourlySale { readonly hour: number; readonly quantity: number; readonly settlementIds: readonly string[] }
export interface TradeDto {
  readonly asOf: string;
  readonly period: PeriodDto;
  readonly population: Series<PopulationBand> & { readonly quarter: string; readonly weekday: number };
  readonly sales: Series<HourlySale>;
}
export interface MenuSale { readonly menuId: string; readonly menuName?: string; readonly businessDate: string; readonly quantity: number }
export interface SearchSeries extends Series<{ readonly period: string; readonly ratio: number }> {
  readonly query: { readonly startDate: string; readonly endDate: string; readonly keywordGroups: readonly { readonly groupName: string }[] };
}
export interface TrendsDto {
  readonly asOf: string;
  readonly period: PeriodDto;
  readonly search: SearchSeries | null;
  readonly sales: Series<MenuSale>;
}
/** PN10 blog/Café result links (GAP-MKT): display only. Kept in the trends widget's own state, never in the snapshot, history or Navis facts. */
export interface SearchLink { readonly title: string; readonly url: string }
export interface LinkSeries { readonly status: SourceStatus; readonly items: readonly SearchLink[] }
export interface SearchLinksDto { readonly source: 'naver-search'; readonly use: 'display-only'; readonly blog: LinkSeries; readonly cafearticle: LinkSeries }
export interface TrendsResponse extends TrendsDto { readonly links?: SearchLinksDto | null }

/** PN17 Café (GAP-MKT): boards from the owner's approved account grant, and the owner's own post ledger. */
export interface CafeBoardDto { readonly clubid: string; readonly menuid: string }
export type CafePostState = 'published' | 'rejected' | 'pending-reconciliation';
export interface CafePostDto {
  readonly id: string; readonly receiptId: string; readonly revision: number; readonly state: CafePostState; readonly subject: string;
  readonly articleId: string | null; readonly articleUrl: string | null; readonly updatedAt: string;
}
export interface CafePostReceipt extends Omit<CafePostDto, 'subject' | 'updatedAt'> { readonly resourceId: string; readonly affectedSources: readonly string[] }
export type CafePosts = { readonly status: 'available'; readonly items: readonly CafePostDto[]; readonly sourceRevision: number } | { readonly status: 'unavailable' };
/** A published article link is shown only when it is an HTTPS cafe.naver.com address. */
export function cafeArticleLink(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cafe.naver.com' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export interface RealLocal {
  readonly storeId: string;
  readonly period: PeriodDto;
  readonly changes: readonly ChangeDto[];
  readonly coverage: CoverageDto | null;
  readonly unreadCount: number;
  readonly trade: TradeDto;
  readonly trends: TrendsDto;
  readonly offers: readonly OfferDto[];
  readonly peers: readonly PeerDto[];
  readonly peersAvailable: boolean;
  /** GAP-MKT Café ledger (owner-scoped). Absent or unavailable never hides the offers. */
  readonly cafePosts?: CafePosts;
}

declare module '../../db/types' {
  interface DataTables { readonly realLocal?: RealLocal }
}

declare module '../../models/types' {
  interface LocalChangesModel { readonly real?: Pick<RealLocal, 'changes' | 'coverage' | 'unreadCount' | 'period'> }
  interface TradeAreaModel { readonly real?: TradeDto }
  interface LocalTrendsModel { readonly real?: TrendsDto }
  interface CommunityModel { readonly sent?: readonly OfferRow[] }
}

// Existing selectors translate keys prefixed with `seed:` as literal text, including user-entered text.
export const literal = (value: string) => `seed:${value}`;

export function changeRow(row: ChangeDto): LocalChange {
  const kind = row.kind === 'festival' ? 'event' : row.kind === 'food-license' ? 'opening' : 'event';
  return { changeId: row.id, kind, titleKey: literal(row.title), whenKey: `data.real.local.${row.dateKind}`,
    startDate: row.referenceDate, endDate: null, distanceM: 0, sameCategory: false, sourceKey: literal(row.authority),
    updatedAt: row.updatedAt, ackedAt: row.acknowledgedAt };
}

export function offerRow(offer: OfferDto, storeId: string, peers: readonly PeerDto[], asOf: string): PartnershipOffer {
  const incoming = offer.recipientStoreId === storeId;
  const peerId = incoming ? offer.senderStoreId : offer.recipientStoreId;
  const name = peers.find(peer => peer.storeId === peerId)?.displayName;
  return { offerId: offer.id, fromStoreKey: name ? literal(name) : 'data.real.local.participatingStore', visibility: 'direct',
    titleKey: literal(offer.title), categoryKey: 'data.real.local.offer', termsKey: literal(offer.terms), periodStart: offer.startsOn,
    periodEnd: offer.endsOn, respondBy: `${offer.respondBy}T23:59:00+09:00`,
    sharedContactKey: offer.status === 'accepted' && offer.sharedContact ? literal(offer.sharedContact) : null,
    status: offer.status === 'pending' && (offer.respondBy < asOf || incoming && !offer.canRespond) ? 'expired' : offer.status };
}

/** The shared hour chart can fall back to POS quantities without treating them as movement estimates. */
export function tradeHours(model: TradeAreaModel) {
  const trade = model.real;
  const salesOnly = !!trade && model.hours.length === 0;
  const ends = new Map(trade?.population.items.map(band => [band.startHour, band.endHour]));
  const hours = salesOnly ? trade.sales.items.map(row => ({ hour: row.hour, end: row.hour + 1, value: row.quantity }))
    : model.hours.map(row => ({ hour: row.hour, end: ends.get(row.hour) ?? row.hour + 1, value: row.people }));
  const ranked = [...hours].sort((a, b) => b.value - a.value || a.hour - b.hour);
  return { hours, ranked, peak: ranked[0], salesOnly };
}

/** Each shared expandable row represents one menu and its total for the returned POS period. */
function saleTrends(rows: readonly MenuSale[], menuItems: DataTables['menuItem']): TrendKeyword[] {
  const byMenu = new Map<string, TrendKeyword>();
  for (const row of rows) {
    const previous = byMenu.get(row.menuId);
    const catalog = menuItems.find(menu => menu.menuId === row.menuId);
    const catalogKey = catalog?.name && 'raw' in catalog.name ? literal(catalog.name.raw) : catalog?.nameKey;
    byMenu.set(row.menuId, { keywordId: row.menuId,
      keywordKey: row.menuName ? literal(row.menuName) : previous?.keywordKey ?? catalogKey ?? 'data.real.local.menu',
      categoryKey: 'data.real.local.menuSales', mentions: (previous?.mentions ?? 0) + row.quantity, prevMentions: null });
  }
  return [...byMenu.values()].sort((a, b) => b.mentions - a.mentions || a.keywordId.localeCompare(b.keywordId));
}

/**
 * The hourly movement bands the store is open for, as the sample chart shows only those hours (a café's busiest hour is not 5 a.m.).
 * Hours outside opening time are left out of the chart; when none of the data falls inside opening time the whole day stays (never hide the data).
 */
export function openHourBands(bands: readonly PopulationBand[], weekday: number): readonly PopulationBand[] {
  const day = STORE_WEEKDAYS[weekday - 1];
  if (!day) return bands;
  const hours = (time: string) => Number(time.slice(0, 2)) + Number(time.slice(3, 5)) / 60;
  const [open, close] = STORE_HOURS[day].map(hours);
  const inside = bands.filter(band => band.endHour > open && band.startHour < close);
  return inside.length > 0 ? inside : bands;
}

export function localTables(data: RealLocal, day: string, menuItems: DataTables['menuItem']): Partial<DataTables> {
  // The legacy community command resolver consumes received rows only. The detail view also exposes sent offers.
  const incoming = data.offers.filter(offer => offer.recipientStoreId === data.storeId);
  return {
    realLocal: data,
    localChange: data.changes.map(changeRow),
    footTraffic: openHourBands(data.trade.population.items, data.trade.population.weekday).map(row => ({ hour: row.startHour, estPeople: row.estimate })),
    trendKeyword: saleTrends(data.trends.sales.items, menuItems),
    partnershipOffer: incoming.map(offer => offerRow(offer, data.storeId, data.peers, day)),
    offerInterest: incoming.filter(row => row.interested).map(row => ({ offerId: row.id, sentAt: `${day}T00:00:00+09:00` })),
  };
}
