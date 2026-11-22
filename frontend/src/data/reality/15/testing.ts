/** F15 test helper: an in-memory B15 (records, approval issuer, card and second-confirmation rules) behind F00's `fakeBackend`. Not shipped in the app bundle. */
import { createWidgetDataStore } from '../../widget-data';
import { createRealPort } from '../00';
import { fakeBackend, reply, type RecordedCall } from '../00/testing';
import { inboxAdapter } from './adapter';
import type { InquiryDto, NoticeDto } from './dto';

export const nowIso = '2026-11-21T03:00:00.000Z';
export const closureId = '55555555-5555-4555-8555-555555555555';
export const ids = { review: 'a1111111-1111-4111-8111-111111111111', talk: 'a2222222-2222-4222-8222-222222222222', manual: 'a3333333-3333-4333-8333-333333333333', notice: 'b1111111-1111-4111-8111-111111111111', sms: 'b2222222-2222-4222-8222-222222222222' };
const base = { providerRef: null, sourceUrl: null, draft: null, reply: null, status: 'waiting', revision: 1, updatedAt: nowIso, title: null } as const;
export const inquiry = (patch: Partial<InquiryDto> & Pick<InquiryDto, 'id' | 'type' | 'source' | 'text'>): InquiryDto => ({ ...base, ...patch });
export const notice = (patch: Partial<NoticeDto> & Pick<NoticeDto, 'id'>): NoticeDto => ({
  revision: 1, status: 'draft', title: '휴무 안내', text: '내일은 쉽니다', channel: 'manual', closure: null, audience: null, recipientGroupId: null, couponRef: null,
  startDate: '2026-11-22', endDate: '2026-11-22', businessHours: null, pin: null, result: null, updatedAt: nowIso, ...patch,
});
const page = <T>(items: readonly T[], waitingCount: number, sourceRevision = 1) => ({ items, nextCursor: null, asOf: nowIso, sourceRevision, waitingCount });

/** Insight `GET /insight/review-insights` as GAP-INS answers it (week, two days behind, average shown). */
export const reviewInsights = (patch: { readonly average?: 'shown' | 'hidden'; readonly empty?: boolean } = {}) => ({
  state: 'ready', asOf: nowIso, businessDate: '2026-11-21',
  statistics: { state: 'ready', source: 'naver-review-statistics', sourceUrl: 'https://help.naver.com/service/30026/contents/24863?lang=ko',
    period: { unit: 'week', from: '2026-11-13', to: '2026-11-19' }, coverage: { requestedTo: '2026-11-21', dataThrough: '2026-11-19', lagDays: 2 },
    themes: patch.empty ? [] : [{ theme: '메뉴', positiveCount: 4, negativeCount: 1 }],
    topKeywords: patch.empty ? { positive: [], negative: [] } : { positive: [{ keyword: '고소한 라떼', count: 3, relatedReviews: [{ text: '라떼가 고소해요' }] }], negative: [{ keyword: '좁은 자리', count: 1 }] } },
  averageRating: { state: patch.average ?? 'shown', source: 'naver-place-visitor-reviews', sourceUrl: 'https://help.naver.com/service/30026/contents/20497?lang=ko',
    value: (patch.average ?? 'shown') === 'shown' ? 4.62 : null, minimumReviewers: 10 },
});

/**
 * A small in-memory B15: records, the approval issuer and the rules the real routes enforce (card first, delete needs the second step).
 * `sms: true` binds the (virtual) SENS reservation; otherwise an SMS send answers `A6_DISABLED` like the unbound service.
 */
export function service(options: { readonly sms?: boolean } = {}) {
  const backend = fakeBackend();
  const state = {
    inquiries: [
      inquiry({ id: ids.review, type: 'review', source: 'review', providerRef: 'rv-1', text: '커피가 맛있어요', authorNotification: '답글을 올리면 리뷰 작성자에게 알림이 가요.' }),
      inquiry({ id: ids.talk, type: 'message', source: 'talktalk', providerRef: 'tt-1', text: '일요일에도 문 여나요?' }),
      inquiry({ id: ids.manual, type: 'message', source: 'manual', title: '전화 문의', text: '주차 되나요?' }),
    ] as InquiryDto[],
    notices: [notice({ id: ids.notice }), notice({ id: ids.sms, channel: 'sms', recipientGroupId: 'c1111111-1111-4111-8111-111111111111' })] as NoticeDto[],
    approvals: new Map<string, { operation: string; resourceId: string; confirmed: boolean; command: unknown }>(),
    /** CARD-AUTH owner-card approvals (`POST /marketing/approvals`, MKT-2 shape). */
    cards: new Map<string, { operation: string; targetRef: string; command: unknown; expectedRevision: number; confirmed: boolean }>(),
    smsStatus: new Map<string, string>(),
    smsPreview: { content: '(광고) 공지 매장 · 발신자 안내\n내일은 쉽니다\n무료수신거부 안내', contentType: 'AD' as const,
      type: 'SMS' as 'SMS' | 'LMS' | null, bytes: 71 as number | null, recipientCount: options.sms ? 12 : null,
      maxRecipients: 500, sendAllowed: Boolean(options.sms), reasons: options.sms ? [] : ['A6_DISABLED'] },
    /** The service's night slot for SMS/TalkTalk drafts (`null` in the daytime). */
    nightWindow: null as { localTime: string; label: string } | null,
    receipts: new Map<string, unknown>(),
    log: [] as string[],
  };
  const count = (rows: readonly { status: string }[], waiting: readonly string[]) => rows.filter(row => waiting.includes(row.status)).length;
  const receipt = (id: string, revision: number, extra: object = {}) => ({ resourceId: id, revision, receiptId: `rc-${id.slice(0, 2)}-${revision}`, state: 'saved', affectedSources: ['inquiries', 'marketing-today'], ...extra });
  backend.on('GET', '/marketing/inquiries', () => page(state.inquiries, count(state.inquiries, ['waiting', 'draft_ready'])));
  backend.on('GET', '/marketing/notices', () => page(state.notices, count(state.notices, ['draft'])));
  backend.on('GET', '/marketing/reviews', () => ({ items: [{ ref: 'rv-1', text: '커피가 맛있어요', keywords: [], media: [], stars: null, reply: null, hasReply: false }], authorNotification: '답글을 올리면 리뷰 작성자에게 알림이 가요.' }));
  backend.on('GET', '/marketing/talktalk/consultations', () => ({ items: [{ ref: 'tt-1', status: 'waiting' }], nextCursor: null }));
  const sundayHours = '일요일 영업시간은 10:00~20:30입니다.';
  backend.on('POST', `/marketing/inquiries/${ids.talk}/navis-draft-preview`, () => ({ source: 'navis', text: `안녕하세요.\n${sundayHours}\n감사합니다.`, facts: [sundayHours] }));
  backend.on('GET', '/marketing/coupons', () => ({ ...page([{
    couponId: 'reply-coupon', name: '커피 쿠폰', status: 'active', startsOn: '2026-11-20', endsOn: '2026-11-28',
    benefitType: 'percent', benefitValue: 10,
    codes: [{ codeId: 'reply-code', code: 'NAVIS10', route: 'place_news', activated: true, unpublishedAt: null, issueCount: 10, used: 1 }],
  }], 0), businessDate: '2026-11-21' }));
  backend.on('GET', '/marketing/talktalk/marketing/audiences', () => ({ items: [{ audience: 'benefit-subscribers', count: 12 }], quota: { month: '2026-11', assigned: 3 } }));
  backend.on('GET', '/marketing/place/news', () => ({ items: [] }));
  backend.on('POST', '/marketing/notice-reply-approvals', (call: RecordedCall) => {
    const body = call.body as { approvalId: string; operation: string; resourceId: string; command: unknown; stage: 'press' | 'confirm' };
    state.log.push(`approval:${body.operation}:${body.stage}`);
    const prior = state.approvals.get(body.approvalId);
    if (body.stage === 'confirm') {
      if (!prior) return reply(404, { code: 'NOT_FOUND' });
      prior.confirmed = true;
    } else if (!prior) state.approvals.set(body.approvalId, { operation: body.operation, resourceId: body.resourceId, confirmed: false, command: body.command });
    return { approvalId: body.approvalId, expiresAt: '2026-11-21T03:01:00.000Z', requiresConfirmation: body.operation.includes('delete') };
  });
  let cardCount = 0;
  backend.on('POST', '/marketing/approvals', (call: RecordedCall) => {
    const body = call.body as { operation: string; targetRef: string; command: unknown; expectedRevision: number; stage: 'press' | 'confirm'; approvalId?: string };
    state.log.push(`card:${body.operation}:${body.stage}`);
    if (body.stage === 'confirm') {
      const prior = body.approvalId ? state.cards.get(body.approvalId) : undefined;
      if (!prior || prior.operation !== body.operation || prior.targetRef !== body.targetRef || JSON.stringify(prior.command) !== JSON.stringify(body.command)) return reply(409, { code: 'APPROVAL_CONFLICT' });
      prior.confirmed = true;
      return { approvalId: body.approvalId, expiresAt: '2026-11-21T03:01:00.000Z' };
    }
    const target = [...state.notices].find(row => row.id === body.targetRef);
    if (target && target.revision !== body.expectedRevision) return reply(409, { code: 'STALE_REVISION' });
    const approvalId = `c0000000-0000-4000-8000-${String(++cardCount).padStart(12, '0')}`;
    state.cards.set(approvalId, { operation: body.operation, targetRef: body.targetRef, command: body.command, expectedRevision: body.expectedRevision, confirmed: false });
    return { approvalId, expiresAt: '2026-11-21T03:01:00.000Z' };
  });
  const smsCard = (call: RecordedCall, operation: string, id: string, needsConfirm: boolean, command: object) => {
    const body = call.body as { approvalId?: string };
    const card = body.approvalId ? state.cards.get(body.approvalId) : undefined;
    if (!card || card.operation !== operation || card.targetRef !== id || JSON.stringify(card.command) !== JSON.stringify(command) || needsConfirm && !card.confirmed) {
      return reply(403, { code: 'CARD_REQUIRED' });
    }
    state.cards.delete(body.approvalId!);
    return undefined;
  };
  backend.on('POST', /^\/marketing\/notices\/[^/]+\/cancel-sms$/, call => {
    const id = call.path.split('/')[3];
    const denied = smsCard(call, 'sms.cancel', id, true, {});
    if (denied) return denied;
    const row = find(id) as NoticeDto;
    if (row.result?.state !== 'scheduled' || state.smsStatus.get(id) === 'PROCESSING') return reply(409, { code: 'SMS_NOT_CANCELABLE' });
    if (stale(call, id)) return reply(409, { code: 'STALE_REVISION' });
    state.log.push('action:notice.cancelSms');
    change(id, { result: { ...row.result, state: 'canceled' } });
    state.smsStatus.set(id, 'CANCELED');
    return receipt(id, find(id).revision, { state: 'canceled', affectedSources: ['notices', 'calendar'] });
  });
  backend.on('GET', /^\/marketing\/notices\/[^/]+\/sms-reservation$/, call => {
    const id = call.path.split('/')[3];
    const row = find(id) as NoticeDto;
    if (row.result?.state !== 'scheduled' && row.result?.state !== 'canceled') return reply(404, { code: 'SMS_RESERVATION_NOT_FOUND' });
    return { resourceId: id, revision: row.revision, scheduledFor: row.result.scheduledFor, status: state.smsStatus.get(id) ?? 'READY' };
  });
  backend.on('GET', /^\/marketing\/notices\/[0-9a-f-]{36}$/, call => {
    const row = find(call.path.split('/')[3]) as NoticeDto | undefined;
    if (!row) return reply(404, { code: 'NOT_FOUND' });
    return { ...row, closureStatus: row.closure ? 'current' : 'none', smsEnabled: Boolean(options.sms),
      ...(row.channel === 'sms' && row.status === 'draft' && { smsPreview: state.smsPreview }),
      nextSendWindow: row.status === 'draft' && (row.channel === 'sms' || row.channel === 'talktalk') ? state.nightWindow : null };
  });
  backend.on('POST', /^\/marketing\/reviews\/[^/]+\/draft-preview$/, () => { state.log.push('preview:naver-ai'); return { text: '방문해 주셔서 감사합니다. 또 들러 주세요', source: 'naver-ai' }; });
  backend.on('POST', /^\/marketing\/reviews\/[^/]+\/navis-draft-preview$/, () => { state.log.push('preview:navis'); return { text: '커피를 좋아해 주셔서 고맙습니다', source: 'navis' }; });
  backend.on('GET', '/insight/review-insights', () => reviewInsights());
  /** The route's own check: an issued approval of this operation and resource, plus the second step for deletes. */
  const card = (call: RecordedCall, operation: string, id: string) => {
    const body = call.body as { approvalId?: string };
    const known = body.approvalId ? state.approvals.get(body.approvalId) : undefined;
    if (!known || known.operation !== operation || known.resourceId !== id) return reply(403, { code: 'CARD_REQUIRED' });
    if (operation.includes('delete') && !known.confirmed) return reply(403, { code: 'CARD_REQUIRED' });
    state.log.push(`action:${operation}`);
    return undefined;
  };
  const change = (id: string, patch: Record<string, unknown>) => {
    const list = state.inquiries.some(row => row.id === id) ? 'inquiries' : 'notices';
    state[list] = state[list].map(row => row.id === id ? { ...row, ...patch, revision: row.revision + 1 } : row) as never;
  };
  const find = (id: string) => [...state.inquiries, ...state.notices].find(row => row.id === id)!;
  const stale = (call: RecordedCall, id: string) => (call.body as { expectedRevision?: number }).expectedRevision !== find(id).revision;
  backend.on('PATCH', /^\/marketing\/inquiries\/[^/]+\/draft$/, call => {
    const id = call.path.split('/')[3];
    if (stale(call, id)) return reply(409, { code: 'STALE_REVISION' });
    const text = (call.body as { text: string }).text;
    if (/010-\d/.test(text)) return reply(400, { code: 'REPLY_CONTAINS_CONTACT' });
    change(id, { draft: { text, source: (call.body as { draftSource?: 'owner' | 'naver-ai' | 'navis' }).draftSource ?? 'owner' }, status: 'draft_ready' });
    return receipt(id, find(id).revision);
  });
  backend.on('POST', /^\/marketing\/inquiries\/[^/]+\/(reply|attestation)$/, call => {
    const [, , , id, kind] = call.path.split('/');
    const denied = card(call, kind === 'reply' ? 'inquiry.post' : 'inquiry.attest', id);
    if (denied) return denied;
    if (stale(call, id)) return reply(409, { code: 'STALE_REVISION' });
    const row = find(id) as InquiryDto;
    change(id, { reply: { text: row.draft!.text, state: kind === 'reply' ? (row.source === 'talktalk' ? 'accepted' : 'saved') : 'recorded' }, draft: null, status: 'done' });
    return receipt(id, find(id).revision, { state: kind === 'reply' ? 'saved' : 'recorded' });
  });
  backend.on('DELETE', /^\/marketing\/inquiries\/[^/]+\/reply$/, call => {
    const id = call.path.split('/')[3];
    const denied = card(call, 'inquiry.deleteReply', id);
    if (denied) return denied;
    change(id, { reply: null, status: 'waiting' });
    return receipt(id, find(id).revision, { state: 'deleted' });
  });
  backend.on('POST', '/marketing/inquiries', call => {
    const body = call.body as { title: string; text: string; type: 'review' | 'message' };
    const id = 'a4444444-4444-4444-8444-444444444444';
    state.inquiries = [...state.inquiries, inquiry({ id, type: body.type, source: 'manual', title: body.title, text: body.text })];
    return receipt(id, 1);
  });
  backend.on('POST', '/marketing/notices', call => {
    const body = call.body as Partial<NoticeDto> & { closure?: { eventId: string; revision: number } };
    const id = 'b3333333-3333-4333-8333-333333333333';
    state.notices = [...state.notices, notice({ ...body, id, text: body.text ?? '', title: body.title ?? '', closure: body.closure ?? null } as never)];
    return receipt(id, 1, { affectedSources: ['notices', 'briefing', 'calendar'] });
  });
  backend.on('PATCH', /^\/marketing\/notices\/[^/]+\/draft$/, call => {
    const id = call.path.split('/')[3];
    if (stale(call, id)) return reply(409, { code: 'STALE_REVISION' });
    const body = call.body as { closure?: { revision: number }; title: string; text: string };
    if (body.closure && body.closure.revision !== 2) return reply(409, { code: 'CLOSURE_CHANGED' });
    change(id, { title: body.title, text: body.text, closure: body.closure ?? null });
    return receipt(id, find(id).revision, { affectedSources: ['notices', 'briefing', 'calendar'] });
  });
  backend.on('POST', /^\/marketing\/notices\/[^/]+\/(send|attestation)$/, call => {
    const [, , , id, kind] = call.path.split('/');
    const row = find(id) as NoticeDto;
    if (row.channel === 'sms' && kind === 'send') {
      const { scheduledFor } = call.body as { scheduledFor?: string };
      const denied = smsCard(call, 'sms.schedule', id, false, { scheduledFor });
      if (denied) return denied;
      if (!options.sms) return reply(409, { code: 'A6_DISABLED' });
      if (stale(call, id)) return reply(409, { code: 'STALE_REVISION' });
      state.log.push('action:notice.send');
      change(id, { status: 'done', result: { state: 'scheduled', providerRef: `rsv-${id.slice(0, 4)}`, scheduledFor } });
      return receipt(id, find(id).revision, { state: 'scheduled', affectedSources: ['notices', 'briefing', 'calendar'] });
    }
    const denied = card(call, kind === 'send' ? 'notice.send' : 'notice.attest', id);
    if (denied) return denied;
    if (row.channel === 'sms') return reply(409, { code: 'A6_DISABLED' });
    if (stale(call, id)) return reply(409, { code: 'STALE_REVISION' });
    change(id, { status: 'done', result: { state: kind === 'send' ? 'accepted' : 'recorded' } });
    return receipt(id, find(id).revision, { state: kind === 'send' ? 'accepted' : 'recorded', affectedSources: ['notices', 'briefing', 'calendar'] });
  });
  backend.on('DELETE', /^\/marketing\/notices\/[^/]+\/draft$/, call => {
    const id = call.path.split('/')[3];
    const denied = card(call, 'notice.deleteDraft', id);
    if (denied) return denied;
    const row = find(id) as NoticeDto;
    state.notices = state.notices.filter(item => item.id !== id);
    state.receipts.set(`rc-${id.slice(0, 2)}-${row.revision + 1}`, row);
    return receipt(id, row.revision + 1, { state: 'deleted', undoUntil: new Date(Date.now() + 6000).toISOString(), affectedSources: ['notices', 'briefing', 'calendar'] });
  });
  backend.on('POST', /^\/marketing\/notice-reply-receipts\/[^/]+\/undo$/, call => {
    const receiptId = call.path.split('/')[3];
    const row = state.receipts.get(receiptId) as NoticeDto | undefined;
    if (!row) return reply(404, { code: 'NOT_FOUND' });
    state.notices = [...state.notices, { ...row, revision: row.revision + 2 }];
    return receipt(row.id, row.revision + 2, { affectedSources: ['notices', 'briefing', 'calendar'] });
  });
  const open = () => {
    const store = createWidgetDataStore();
    const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [inboxAdapter], sleep: async () => {}, reconcileDelaysMs: [0] });
    store.bindReal(port);
    return { store, port };
  };
  return { backend, state, open, ...open() };
}

