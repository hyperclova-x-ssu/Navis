import type { DetailRef } from '../../contracts';
import type { DataSnapshot } from '../../data/db/types';
import { navisDirective, navisScopeIssue, resolveNavisName } from './navis-input';
import type { AgentHandoff } from './types';

// These entries open the workflow in the widget where the owner can review and confirm it.
const destinations = {
  'cafe-post': { featureId: 'community', view: 'cafe' },
  'local-search-links': { featureId: 'local-trends', view: 'keywords' },
  'sms-schedule': { featureId: 'notice-send', view: 'compose' },
  'sms-status': { featureId: 'notice-send', view: 'scheduled' },
  'review-draft': { featureId: 'ai-response', view: 'review' },
  'message-draft': { featureId: 'ai-response', view: 'message' },
  'naver-calendar': { featureId: 'calendar', view: 'day' },
  'works-calendar': { featureId: 'staff-schedule', view: 'works' },
  'place-news': { featureId: 'notice-send', view: 'compose' },
  'place-video': { featureId: 'promo-video', view: 'create' },
  'place-menu': { featureId: 'menu', view: 'list' },
  'commerce-stock': { featureId: 'inventory-booking', view: 'products' },
  'supplier-message': { featureId: 'suppliers', view: 'orders' },
  'naver-coupon': { featureId: 'coupon-status', view: 'naver' },
  'tax-evidence-removal': { featureId: 'tax', view: 'evidence' },
} satisfies Record<string, Pick<DetailRef, 'featureId' | 'view'>>;

export type WidgetHandoffStep = keyof typeof destinations;
const isWidgetStep = (step: string): step is WidgetHandoffStep => Object.hasOwn(destinations, step);

const scopedSteps: ReadonlySet<WidgetHandoffStep> = new Set(['review-draft', 'message-draft', 'sms-schedule', 'sms-status', 'place-news', 'tax-evidence-removal']);
// These actions require the owner to choose an existing record. Generic action focus opens a creation form.
const readOnlyEntry: ReadonlySet<WidgetHandoffStep> = new Set(['naver-calendar', 'works-calendar', 'supplier-message']);

export function widgetHandoffRef({ featureId, step, command, draft, itemId }: AgentHandoff): DetailRef | undefined {
  if (!step || !isWidgetStep(step) || command || draft && Object.keys(draft).length) return;
  if (itemId !== undefined && (!scopedSteps.has(step) || typeof itemId !== 'string' || !itemId || itemId.length > 200)) return;
  const destination = destinations[step];
  const focusAction = !readOnlyEntry.has(step) && (step !== 'tax-evidence-removal' || Boolean(itemId));
  if (destination.featureId === featureId) return { ...destination, ...(focusAction && { focus: 'action' as const }), ...(itemId && { itemId }),
    ...(step === 'naver-coupon' && { condition: { kind: 'default' } as const }) };
}

export function missingTaxEvidenceHandoff(text: string): AgentHandoff | undefined {
  const value = navisDirective(text);
  if (/(?:증빙|영수증).*(?:없음|없는\s*걸로|지워|삭제)/u.test(value)) {
    return { featureId: 'tax', step: 'tax-evidence-removal' };
  }
}

export function noticeWidgetStep(snapshot: DataSnapshot, noticeId: string, scheduled: boolean): 'sms-schedule' | 'place-news' | undefined {
  const draft = snapshot.tables.realInbox?.notices.find(row => row.id === noticeId && row.status === 'draft');
  if (draft?.channel === 'place-news' || draft?.channel === 'place-hours') return 'place-news';
  if (draft?.channel === 'sms' && scheduled) return 'sms-schedule';
}

export function commandWidgetHandoff(snapshot: DataSnapshot, command: string, args: Readonly<Record<string, unknown>>): AgentHandoff | undefined {
  if (command === 'tax.setEvidence' && args.evidence === 'none' && typeof args.taxPaymentId === 'string') {
    return { featureId: 'tax', step: 'tax-evidence-removal', itemId: args.taxPaymentId };
  }
  if (command === 'notice.send' && typeof args.noticeId === 'string') {
    const step = noticeWidgetStep(snapshot, args.noticeId, typeof args.sendAt === 'string');
    if (step) return { featureId: 'notice-send', step, itemId: args.noticeId };
  }
  if (command === 'reply.draft' && typeof args.threadId === 'string') {
    const thread = snapshot.tables.realInbox?.inquiries.find(row => row.id === args.threadId);
    if (thread?.type === 'review') return { featureId: 'ai-response', step: 'review-draft', itemId: thread.id };
  }
}

function scheduledSmsItemId(raw: string, snapshot: DataSnapshot | undefined): string | undefined {
  const reservations = snapshot?.tables.realInbox?.notices.filter(row =>
    row.channel === 'sms' && row.status === 'done' && row.result?.state === 'scheduled' && row.result.scheduledFor);
  if (!reservations?.length) return;
  const title = /(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’)/u.exec(raw)?.slice(1).find(Boolean);
  const { kind, matches } = resolveNavisName(title ?? raw, reservations, row => row.title);
  if (matches.length === 1 && (!title || kind === 'exact')) return matches[0].id;
}

export function classifyWidgetHandoff(raw: string, snapshot?: DataSnapshot): AgentHandoff | undefined {
  if (navisScopeIssue(raw)) return;
  const text = navisDirective(raw.normalize('NFKC'));
  if (/지\s*마|하지\s*않|어떻게|방법|예시|매번|매일|매주|받은\s*쿠폰\s*취소|(?:있어|없어|몇\s*개야|얼마야)[?？]?$/u.test(text)) return;
  const write = /올려|올리|추가|보내|보내기|발송|게시|반영|만들|쓰|적어|바꿔|고쳐|고치|수정|지워|지우|삭제|취소|끝내|연장|사용\s*처리/u;
  let step: WidgetHandoffStep | undefined;
  if (/검색\s*(?:결과|출처)|원문\s*링크/u.test(text) && /블로그|카페/u.test(text) && /보여|열어|찾아/u.test(text)) {
    step = 'local-search-links';
  } else if (/문자|공지/u.test(text) && (/예약(?:한|된|해\s*둔|\s*발송)|발송\s*예약/u.test(text)
    || /(?:문자|공지)\s*(?:발송\s*)?예약\s*(?:상태|목록|취소)/u.test(text))) {
    if (/취소|삭제|상태|목록|어디|보여|확인/u.test(text)) step = 'sms-status';
    else if (write.test(text)) step = 'sms-schedule';
  } else if (write.test(text)) {
    if (/카페(?:에|\s*게시판|\s*(?:글|게시글))|네이버\s*카페/u.test(text) && /글|게시/u.test(text)) step = 'cafe-post';
    else if (/리뷰|후기/u.test(text) && /초안/u.test(text)) step = 'review-draft';
    else if (/\bWORKS\b|웍스/iu.test(text) && /일정|근무|캘린더/u.test(text)) step = 'works-calendar';
    else if (/네이버\s*(?:캘린더|달력)|네이버에\s*일정/u.test(text)) step = 'naver-calendar';
    else if (/(?:네이버|플레이스|주문)\s*쿠폰|주문\s*프로모션/u.test(text)) step = 'naver-coupon';
    else if (/플레이스|클립/u.test(text) && /홍보\s*영상|동영상/u.test(text)) step = 'place-video';
    else if (/플레이스/u.test(text) && /새\s*소식|공지|영업\s*시간|휴무/u.test(text)) step = 'place-news';
    else if (/플레이스/u.test(text) && /메뉴|업체\s*정보/u.test(text)) step = 'place-menu';
    else if (/스마트\s*스토어|\bcommerce\b/iu.test(text) && /재고/u.test(text)) step = 'commerce-stock';
    else if (/거래처|공급사|공급업체/u.test(text) && /발주|문자|메시지|메일/u.test(text) && /보내|발송/u.test(text)) step = 'supplier-message';
  }
  if (!step) return;
  const itemId = step === 'sms-status' && !/목록/u.test(text) ? scheduledSmsItemId(raw, snapshot) : undefined;
  return { featureId: destinations[step].featureId, step, ...(itemId && { itemId }) };
}
