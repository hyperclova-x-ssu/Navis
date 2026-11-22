import { APP_CLOCK } from '../../db/app-clock';
import { addDays, weekdayOf } from '../../db/time';
import { defineBinding, PortError, type CommandContext, type DomainAdapter, type ListPage, type LoadContext, type PortReads, type PortTransport } from '../00';
import { menuPath, type MenuDto } from '../01/menu-dto';
import { issueCardApproval, type CardIntent } from '../15/card-approval';
import { localTables, type CafeBoardDto, type CafePostDto, type CafePostReceipt, type CafePosts, type ChangeDto, type CoverageDto, type OfferDto, type PeerDto, type PeriodDto, type TradeDto, type TrendsDto, type TrendsResponse } from './dto';

const changes = '/marketing/local-changes';
const offers = '/marketing/offers';
const trade = '/marketing/trade-area';
const trends = '/marketing/local-trends';
const cafePosts = '/marketing/community/cafe-posts';
const cafeBoards = '/marketing/community/cafe-boards';
const SESSION = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'STORE_FORBIDDEN']);
const itemPath = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;
const changeKey = (id: string) => `local:change:${id}`;
const offerKey = (id: string) => `local:offer:${id}`;
export const calendarDay = APP_CLOCK.calendarDate;
const weekStart = addDays(calendarDay, 1 - weekdayOf(calendarDay));
const week = { from: weekStart, to: addDays(weekStart, 6) };
const salesWeek = { from: addDays(APP_CLOCK.businessDate, -6), to: APP_CLOCK.businessDate };
const quarter = `${calendarDay.slice(0, 4)}-Q${Math.ceil(Number(calendarDay.slice(5, 7)) / 3)}`;

interface ChangePage extends ListPage<ChangeDto> {
  readonly period: PeriodDto;
  readonly coverage: CoverageDto | null;
  readonly unreadCount: number;
}

// Preserve the full-period coverage and unread total from the first page.
async function readChanges({ reads, signal }: LoadContext) {
  const page = (cursor?: string) => reads.one<ChangePage>({ resource: 'local-changes', path: changes, query: { ...week, limit: 200, cursor } }, { signal });
  const first = await page();
  const items = [...first.items];
  let cursor = first.nextCursor;
  for (let index = 1; cursor && index < 20; index++) {
    const next = await page(cursor);
    if (first.sourceRevision !== next.sourceRevision) return { ...first, items, complete: false };
    items.push(...next.items);
    cursor = next.nextCursor;
  }
  return { ...first, items, complete: cursor === null };
}

/** The full `/local-trends` answer, including PN10 result links when a keyword is sent. Callers keep `links` out of the snapshot. */
export function readLocalTrends(reads: PortReads, period: PeriodDto, keyword?: string, signal?: AbortSignal): Promise<TrendsResponse> {
  return reads.one({ resource: 'local-trends', path: trends, query: { ...period, keyword } }, { signal });
}

async function nameMenuSales({ reads, signal }: LoadContext, sales: TrendsDto['sales']): Promise<TrendsDto['sales']> {
  if (sales.items.every(row => row.menuName)) return sales;
  try {
    const { items } = await reads.all<Pick<MenuDto, 'menuId' | 'name'>>({ resource: 'menu', path: menuPath, query: { limit: 50 } }, { signal });
    const names = new Map(items.map(row => [row.menuId, row.name]));
    return { ...sales, items: sales.items.map(row => row.menuName ? row : { ...row, menuName: names.get(row.menuId) }) };
  } catch (error) {
    if (signal.aborted || error instanceof PortError && (error.status === 401 || error.status === 403)) throw error;
    return sales;
  }
}

/** The owner's Café ledger. A missing route or provider shows as unavailable and never takes the offers down. */
async function readCafePosts({ reads, signal }: LoadContext): Promise<CafePosts> {
  try {
    const page = await reads.one<ListPage<CafePostDto>>({ resource: 'cafe-posts', path: cafePosts, query: { limit: 50 } }, { signal });
    return { status: 'available', items: page.items, sourceRevision: page.sourceRevision };
  } catch (error) {
    if (signal.aborted || error instanceof PortError && SESSION.has(error.code)) throw error;
    return { status: 'unavailable' };
  }
}

/** Boards the owner's approved account grant allows (read when the Café tab opens; no names are given by NAVER). */
export function readCafeBoards(reads: PortReads, signal?: AbortSignal) {
  return reads.one<{ readonly items: readonly CafeBoardDto[] }>({ resource: 'cafe-boards', path: cafeBoards }, { signal });
}

/**
 * PN17 Café post, sent only from the owner's second press: confirm the owner-card approval issued by the first press, then send the same
 * body once with `Idempotency-Key: navis:<approvalId>` (the same key returns the stored receipt, never a second post). Like the NAVER coupon
 * card (F14) this is a card write on the transport, not a data command, so no shared command table changes.
 */
export async function submitCafePost(transport: Pick<PortTransport, 'request'>, post: CafePostInput, expectedRevision: number, approvalId: string, signal?: AbortSignal) {
  const intent = cafeIntent(post, expectedRevision);
  await issueCardApproval(input => transport.request(input), intent, `cafe:${approvalId}`, 'confirm', approvalId, signal);
  return transport.request<CafePostReceipt>({ method: 'POST', path: cafePosts, body: intent.command, idempotencyKey: `navis:${approvalId}`, ...(signal ? { signal } : {}) });
}
export interface CafePostInput { readonly clubid: string; readonly menuid: string; readonly subject: string; readonly text: string }

/** The owner-card intent of one Café post: the same fields are pressed, confirmed and sent. */
export function cafeIntent(post: { readonly clubid: string; readonly menuid: string; readonly subject: string; readonly text: string }, expectedRevision: number): CardIntent {
  const { clubid, menuid, subject, text } = post;
  return { operation: 'cafe.post', targetRef: `${clubid}:${menuid}`, command: { clubid, menuid, subject, text }, expectedRevision };
}

function expected(context: CommandContext, key: string): number {
  const revision = context.revision(key);
  if (revision === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return revision;
}

function respond(context: CommandContext, offerId: string, action: 'accept' | 'decline' | 'interest') {
  const offer = context.snapshot.tables.realLocal?.offers.find(row => row.id === offerId);
  if (!offer?.canRespond) throw new PortError(409, 'CONFLICT', 'OFFER_CLOSED');
  return { method: 'POST' as const, path: `${itemPath(offers, offerId)}/${action}`,
    body: action === 'decline' ? { confirmed: true } : {}, expectedRevision: expected(context, offerKey(offerId)) };
}

export const localAdapter: DomainAdapter = {
  domain: 'local',
  sources: ['local', 'local-changes', 'community', 'pos.sales', 'menu'],
  tables: ['realLocal', 'localChange', 'footTraffic', 'trendKeyword', 'partnershipOffer', 'offerInterest'],
  clear() { return { realLocal: undefined }; },
  errorKeys: { OFFER_CLOSED: 'data.real.local.closed', OFFER_EXPIRED: 'data.real.local.expired',
    CAFE_BOARD_FORBIDDEN: 'data.real.local.error.CAFE_BOARD_FORBIDDEN', PROVIDER_UNAVAILABLE: 'data.real.local.error.PROVIDER_UNAVAILABLE',
    APPROVAL_EXPIRED: 'data.real.local.cafe.expired', CARD_REQUIRED: 'data.real.inbox.error.CARD_REQUIRED',
    PENDING_OR_USED_APPROVAL: 'data.real.inbox.error.PENDING_OR_USED_APPROVAL', APPROVAL_CONFLICT: 'data.real.inbox.error.APPROVAL_CONFLICT' },
  async load(context) {
    const { reads, storeId, signal, snapshot } = context;
    const previous = snapshot.tables.realLocal;
    const keyword = previous?.storeId === storeId ? previous.trends.search?.query.keywordGroups[0]?.groupName : undefined;
    const [local, area, trendRead, offerList, peers, cafe] = await Promise.all([
      readChanges(context),
      reads.one<TradeDto>({ resource: 'trade-area', path: trade, query: { ...salesWeek, quarter, weekday: weekdayOf(calendarDay) } }, { signal }),
      readLocalTrends(reads, salesWeek, keyword, signal),
      reads.all<OfferDto>({ resource: 'community', path: offers }, { signal }),
      reads.one<{ status: 'available' | 'unavailable'; items: readonly PeerDto[] }>({ resource: 'community-peers', path: `${offers}/peers` }, { signal }),
      readCafePosts(context),
    ]);
    // Search result links are display-only: they stay out of the snapshot (and so out of Navis facts and model context).
    const trend: TrendsDto = { asOf: trendRead.asOf, period: trendRead.period, search: trendRead.search, sales: await nameMenuSales(context, trendRead.sales) };
    const scopedOffers = offerList.items.filter(row => row.senderStoreId === storeId || row.recipientStoreId === storeId);
    return {
      tables: localTables({ storeId, period: local.period, coverage: local.coverage, changes: local.items, unreadCount: local.unreadCount,
        trade: area, trends: trend, offers: scopedOffers, peers: peers.status === 'available' ? peers.items : [], peersAvailable: peers.status === 'available',
        cafePosts: cafe }, calendarDay, snapshot.tables.menuItem),
      revisions: { ...Object.fromEntries(local.items.map(row => [changeKey(row.id), row.revision])),
        ...Object.fromEntries(scopedOffers.map(row => [offerKey(row.id), row.revision])) },
      asOf: [local.asOf, area.asOf, trend.asOf, offerList.asOf].sort().at(-1)!,
      sourceRevision: Math.max(local.sourceRevision, offerList.sourceRevision),
      complete: local.complete && offerList.complete,
    };
  },
  commands: [
    defineBinding({ type: 'localChanges.create', noticeKey: 'data.real.local.recorded', request: ({ title, region, referenceDate, sourceUrl }) => ({
      method: 'POST', path: changes, body: { title, region, referenceDate, sourceUrl },
    }) }),
    defineBinding({ type: 'localChanges.acknowledge', receiptBase: changes, noticeKey: 'data.notice.changeAcked', request: ({ changeId }, context) => ({
      method: 'POST', path: `${itemPath(changes, changeId)}/ack`, expectedRevision: expected(context, changeKey(changeId)),
    }) }),
    defineBinding({ type: 'localChanges.unacknowledge', noticeKey: 'data.notice.changeReopened', request: ({ changeId }, context) => ({
      method: 'POST', path: `${itemPath(changes, changeId)}/unack`, expectedRevision: expected(context, changeKey(changeId)),
    }) }),
    defineBinding({ type: 'community.create', noticeKey: 'data.real.local.offerCreated',
      request: ({ recipientStoreId, title, terms, startsOn, endsOn, respondBy }, { snapshot }) => {
        if (!snapshot.tables.realLocal?.peers.some(peer => peer.storeId === recipientStoreId)) throw new PortError(400, 'VALIDATION', 'INVALID_REQUEST', 'recipientStoreId');
        return { method: 'POST', path: offers, body: { recipientStoreId, title, terms, startsOn, endsOn, respondBy } };
      } }),
    defineBinding({ type: 'community.accept', noticeKey: 'data.notice.offerAccepted', request: ({ offerId }, context) => respond(context, offerId, 'accept') }),
    defineBinding({ type: 'community.decline', noticeKey: 'data.notice.offerDeclined', request: ({ offerId }, context) => respond(context, offerId, 'decline') }),
    defineBinding({ type: 'community.sendInterest', noticeKey: 'data.real.local.interestSent', request: ({ offerId }, context) => respond(context, offerId, 'interest') }),
  ],
};
