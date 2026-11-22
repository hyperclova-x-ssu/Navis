import { cancellableNoticeSchedule, noticeBusinessNow } from '../../../data/iteration7/notices/commands';
import type { DetailRef, FeatureId, Locale, QueryCondition, RunState } from '../../../contracts';
import type { DataCommand, DataCommandResult } from '../../../data/commands/types';
import { nextNoticeMorning, prepareScheduledNoticePreview, previewNotice } from '../../../data/commands/notice-guard';
import { readAppClock } from '../../../data/db/app-clock';
import { addDays, isIsoDate, TODAY } from '../../../data/db/time';
import type { DataSnapshot } from '../../../data/db/types';
import {
  classifyNoticeContent, noticeHandlers, selectDraftClosureLink, selectNotices, selectStoreClosures,
  type NoticeCommand, type NoticeDraft, type NoticePreviewView, type NoticeSent,
} from '../../../data/iteration7/notices';
import { resolveNoticeRecipients } from '../../../data/iteration7/notices/recipients';
import type { CustomerGroupId } from '../../../data/marketing/types';
import {
  validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentRecordMatch, type AgentWireArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import { noticeWidgetStep } from '../widget-handoff';
import { normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisPeriod, parseNavisTime } from '../navis-input';
import type {
  CommandAdapter, DomainAdapter, DomainDetail, DomainLookup, DomainRoute, LocalSlots, ReadToolAdapter,
  RecordAdapter, RecordSearch, RecordTargets, RunCommandAdapter,
} from './registry';

const featureId = 'notice-send';
const defaultCondition = { kind: 'default' } as const;
const businessDate = (snapshot: DataSnapshot) => snapshot.pos?.businessDate ?? TODAY;
const now = noticeBusinessNow;
const slot = (name: string) => ({ slot: name });
export const NIGHT_NOTICE_TIME_LABEL = '내일 8시';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1000;
const groups = (value: unknown): value is CustomerGroupId[] => Array.isArray(value) && value.length <= 3
  && value.every(id => id === 'regular' || id === 'first-visit' || id === 'churn-risk');
const slotLocale = (value: unknown): Locale => value === 'en' || value === 'zh-Hans' || value === 'zh-Hant' ? value : 'ko';
const local = (locale: Locale, ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];

function labels(locale: Locale) {
  const t = navisTranslator(locale);
  const tr = (ko: string, en: string, hans: string, hant: string) => local(locale, ko, en, hans, hant);
  return { ...t, tr,
    title: tr('공지 제목', 'Notice title', '通知标题', '通知標題'),
    body: tr('공지 내용', 'Notice text', '通知内容', '通知內容'),
    dates: tr('해당 일자·기간', 'Notice dates', '通知日期', '通知日期'),
    kind: tr('공지 종류', 'Notice type', '通知类型', '通知類型'),
    draft: tr('임시 저장한 공지', 'Notice draft', '通知草稿', '通知草稿'),
    sent: tr('보낸 공지', 'Sent notice', '已发送的通知', '已傳送的通知'),
    sentAt: tr('보낸 일시', 'Sent at', '发送日期', '傳送時間'),
    sendTime: tr('발송 시각', 'Send time', '发送时间', '傳送時間'),
    scheduledSend: tr('공지 예약 발송', 'Schedule notice', '定时发送通知', '定時傳送通知'),
    scheduleAsk: tr('예약 발송 시각을 알려 주세요', 'Enter a time for the scheduled send.', '请输入定时发送的时间。', '請輸入排程傳送的時間。'),
    recipients: tr('받는 사람', 'Recipients', '收件人', '收件者'),
    excluded: tr('제외', 'Excluded', '已排除', '已排除'),
    revision: tr('초안 버전', 'Draft revision', '草稿版本', '草稿版本'),
    closure: tr('연결된 휴무 일정', 'Linked closure', '关联停业日程', '關聯公休行程'),
    closureRevision: tr('휴무 일정 버전', 'Closure revision', '停业日程版本', '公休行程版本'),
    className: tr('발송 규칙', 'Sending rule', '发送规则', '傳送規則'),
    preview: tr('미리보기', 'Preview', '预览', '預覽'),
    info: tr('정보성', 'Informational', '服务通知', '服務通知'),
    ad: tr('광고', 'Promotional', '广告', '廣告'),
    consent: tr('문자 동의', 'SMS consent', '短信同意', '簡訊同意'),
    contactable: tr('연락처가 있는 회원 전체', 'All members with contact details', '留有联系方式的所有会员', '留有聯絡方式的所有會員'),
    group: tr('손님 그룹 선택', 'Selected customer groups', '所选客户群组', '所選顧客群組'),
    night: tr('밤 9시부터 아침 8시까지는 공지를 보낼 수 없어요', 'Notices cannot be sent from 9 PM to 8 AM.', '晚上9点至早上8点不能发送通知。', '晚上9點至早上8點無法傳送通知。'),
    missingDraft: tr('저장한 공지가 없어요', 'There are no saved notices.', '没有已保存的通知。', '沒有已儲存的通知。'),
    missingSent: tr('아직 보낸 공지가 없어요', 'There are no sent notices yet.', '还没有发送过通知。', '還沒有傳送過通知。'),
  };
}
type Labels = ReturnType<typeof labels>;
const classLabel = (value: NoticeDraft['contentClass'], l: Labels) => value === 'promotional' ? l.ad : l.info;
const kindLabel = (value: NoticeDraft['kind'], l: Labels) => ({
  regular_closure: l.tr('정기 휴무', 'Regular closure', '固定休息', '固定公休'),
  temporary_closure: l.tr('임시 휴무', 'Temporary closure', '临时停业', '臨時公休'),
  hours_change: l.tr('영업시간 변경', 'Changed hours', '营业时间变更', '營業時間變更'),
  other: l.tr('기타', 'Other', '其他', '其他'),
})[value];
// F15 (HTTP): a service record names its channel; the fixture names its audience.
const audienceLabel = (draft: Pick<NoticeDraft, 'audience' | 'groupIds' | 'channel'>, l: Labels) => draft.channel ? l.t(`data.real.inbox.notice.channel.${draft.channel}`) : draft.audience === 'all_contactable' ? l.contactable
  : draft.groupIds.map(id => l.t(`data.marketing.group.${{ regular: 'regular', 'first-visit': 'firstVisit', 'churn-risk': 'churnRisk' }[id]}`)).join(' · ') || l.group;
const people = (value: number, l: Labels) => l.format.count(value, 'person');
const dates = (start: string, end: string, l: Labels) => start === end ? l.format.date(start, 'short')
  : `${l.format.date(start, 'short')} ~ ${l.format.date(end, 'short')}`;
const fact = (key: string, label: string, value: string | number, display = String(value), unit = 'text', date?: string): AgentFact => ({
  key, label, value: typeof value === 'string' ? value.slice(0, 1000) : value, display: display.slice(0, 1000), unit, ...(date ? { date } : {}),
});
const statusKey = (messageKey: string | undefined, l: Labels) => messageKey && l.has(messageKey) ? l.t(messageKey) : l.t('common.navis.noData');

function smsReservations(snapshot: DataSnapshot) {
  return (snapshot.tables.realInbox?.notices ?? []).flatMap(row => {
    const state = row.result?.state;
    const sendAt = row.result?.scheduledFor;
    return row.channel === 'sms' && row.status === 'done' && sendAt && (state === 'scheduled' || state === 'canceled')
      ? [{ id: row.id, title: row.title, state, sendAt }] : [];
  }).sort((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id.localeCompare(b.id));
}

function projectWidget(snapshot: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale) {
  if (feature !== featureId) return;
  if (condition.kind !== 'default') return { status: 'unsupported_period' as const };
  const l = labels(locale);
  const day = businessDate(snapshot);
  const model = selectNotices(snapshot, {}, day);
  const reservations = smsReservations(snapshot);
  const reservedCount = reservations.filter(row => row.state === 'scheduled').length;
  return { facts: [
    fact('notice.unsentClosure.count', l.tr('공지 미발송', 'Unsent notices', '未发送通知', '未傳送通知'), model.unsentCount, l.format.count(model.unsentCount, 'count'), 'count', day),
    fact('notice.sent.count', l.sent, model.sentCount, l.format.count(model.sentCount, 'count'), 'count', day),
    ...(snapshot.tables.realInbox ? [
      fact('notice.sms.scheduled.count', '문자 예약 기록', reservedCount, l.format.count(reservedCount, 'count'), 'count'),
      ...reservations.slice(0, 8).flatMap((row, index) => [
        fact(`notice.sms.${index}.status`, row.title, row.state, row.state === 'scheduled' ? '예약했어요' : '예약을 취소했어요'),
        fact(`notice.sms.${index}.time`, l.sendTime, row.sendAt, l.format.dateTime(row.sendAt, { today: day }), 'dateTime', row.sendAt.slice(0, 10)),
      ]),
    ] : []),
    ...(model.nextClosure ? [fact('notice.nextClosure.date', l.closure, model.nextClosure.startDate, l.format.date(model.nextClosure.startDate, 'short'), 'date', model.nextClosure.startDate)] : []),
    ...model.drafts.slice(0, 8).flatMap((draft, index) => {
      const key = `notice.draft.${index}`;
      const contentClass = draft.channel === 'sms' ? 'promotional' : classifyNoticeContent(draft.title, draft.body);
      const recipients = resolveNoticeRecipients(snapshot.tables, { ...draft, contentClass });
      const linked = selectStoreClosures(snapshot).find(item => item.eventId === draft.closureEventId);
      return [
        fact(`${key}.row`, l.draft, draft.title, `${draft.title} · ${dates(draft.startDate, draft.endDate, l)}`, 'text', draft.startDate),
        fact(`${key}.kind`, l.kind, draft.kind, kindLabel(draft.kind, l)),
        ...(!draft.channel ? [fact(`${key}.audienceCount`, l.recipients, recipients.recipientCount, people(recipients.recipientCount, l), 'person')] : []),
        fact(`${key}.rule`, l.className, contentClass, classLabel(contentClass, l)),
        ...(draft.closureRevision !== null ? [fact(`${key}.closureRevision`, l.closureRevision, draft.closureRevision, undefined, 'count')] : []),
        ...(linked ? [fact(`${key}.closureDate`, l.closure, linked.startDate, dates(linked.startDate, linked.endDate, l), 'date')] : []),
      ];
    }),
    ...model.sent.slice(0, 8).flatMap((sent, index) => {
      const key = `notice.sent.${index}`, date = sent.sentAt.slice(0, 10);
      return [fact(`${key}.row`, l.sent, sent.title, sent.title, 'text', date),
        fact(`${key}.body`, l.body, sent.renderedBody, sent.renderedBody, 'text', date),
        fact(`${key}.recipientCount`, l.recipients, sent.recipientCount, people(sent.recipientCount, l), 'person', date),
        fact(`${key}.sentAt`, l.sentAt, sent.sentAt, l.format.dateTime(sent.sentAt, { today: day }), 'dateTime', date)];
    }),
  ] };
}

function noticeMatches<R extends NoticeDraft>(rows: readonly R[], query: string) {
  if (query === '*') return rows;
  if (query.startsWith('id:')) return rows.filter(row => rowId(row) === query.slice(3));
  const [name, date] = query.split('\n');
  const key = normalizeNavisName(name);
  return rows.filter(row => (!date || row.startDate <= date && date <= row.endDate)
    && (!key || normalizeNavisName(row.title).includes(key) || key === '휴무' && row.kind.endsWith('_closure')));
}
const isSent = (row: NoticeDraft): row is NoticeSent => 'sentId' in row;
const rowId = (row: NoticeDraft) => isSent(row) ? row.sentId : row.noticeId;
const sentRow = (snapshot: DataSnapshot, row: NoticeDraft) => snapshot.tables.noticeSent.find(sent => sent.noticeId === row.noticeId && (sent.status === 'scheduled' || sent.draftRevision === row.revision));
const alreadySent = (snapshot: DataSnapshot, row: NoticeDraft) => !!sentRow(snapshot, row);
const automaticNightSchedule = (stamp: string) => nextNoticeMorning(stamp) ? `${addDays(stamp.slice(0, 10), 1)}T08:00` : undefined;
const scheduleAllowed = (snapshot: DataSnapshot, row: NoticeDraft) => {
  const stamp = now(snapshot);
  const date = stamp.slice(0, 10);
  // An explicit same-day schedule can still be eligible before 08:00.
  const earliestDay = stamp.slice(11) < '08:00' ? date : addDays(date, 1);
  const result = prepareScheduledNoticePreview(snapshot, { noticeId: row.noticeId, draftRevision: row.revision }, `${earliestDay}T08:00`, stamp);
  return result.ok && result.prepared.sendAllowed;
};

function reader(kind: 'noticeDraft' | 'noticeSent'): RecordAdapter {
  const rows = ({ snapshot, query }: RecordSearch) => {
    const model = selectNotices(snapshot);
    return noticeMatches(kind === 'noticeDraft' ? model.drafts : model.sent, query).slice(0, 5);
  };
  const handle = (index: number) => `n15-${kind}-${index + 1}`;
  return {
    kind,
    search(input) {
      return rows(input).map((row, index) => {
        const projected = kind === 'noticeDraft' ? previewNotice(input.snapshot, { noticeId: row.noticeId, draftRevision: row.revision }, now(input.snapshot)) : undefined;
        const fields: AgentRecordMatch['fields'] = kind === 'noticeDraft' ? { kind: row.kind, date: row.startDate, revision: row.revision, businessTime: now(input.snapshot).slice(11),
          sendAllowed: projected?.ok === true && projected.preview.sendAllowed, scheduleAllowed: scheduleAllowed(input.snapshot, row),
          alreadySent: alreadySent(input.snapshot, row),
          closureLink: selectDraftClosureLink(input.snapshot, row) } : { date: (row as NoticeSent).sentAt.slice(0, 10) };
        return { handle: handle(index), match: 'exact', fields, ...(!input.privateLookup ? { label: row.title.slice(0, 180) } : {}) };
      });
    },
    resolve: (input, target) => {
      const row = rows(input).find((_, index) => handle(index) === target);
      return row && rowId(row);
    },
    describe(match, locale, input) {
      const row = input && rows(input).find((_, index) => handle(index) === match.handle);
      if (!row) return match.label;
      const l = labels(locale);
      if (input.querySlot === 'noticeBody') return isSent(row) ? row.renderedBody : row.body;
      if (input.querySlot === 'noticeClass') return classLabel(classifyNoticeContent(row.title, row.body), l);
      if (isSent(row)) return `${row.title} · ${people(row.recipientCount, l)} · ${l.format.dateTime(row.sentAt)}`;
      return row.title;
    },
  };
}

function expand(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, slots, targets));
  if (!record(value)) return value;
  if (typeof value.slot === 'string') return slots[value.slot];
  if (typeof value.handle === 'string') return targets.get(value.handle)?.id;
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, expand(item, slots, targets)]));
}

function previewFacts(preview: Omit<NoticePreviewView, 'previewId'>, l: Labels) {
  return [
    fact('notice.preview.contentClass', l.className, preview.contentClass, classLabel(preview.contentClass, l)),
    fact('notice.preview.recipientCount', l.recipients, preview.recipientCount, people(preview.recipientCount, l), 'person'),
    fact('notice.preview.excludedCount', l.excluded, preview.excludedCount, people(preview.excludedCount, l), 'person'),
    fact('notice.preview.renderedBody', l.preview, preview.renderedBody),
    ...(preview.adMarker ? [fact('notice.preview.audienceRule', l.recipients, l.consent)] : []),
    ...preview.reasons.map((reason, index) => fact(`notice.preview.reason.${index}`, l.preview, statusKey(`data.notices.error.${reason}`, l))),
  ];
}
const previewTool: ReadToolAdapter<'notice.preview'> = {
  tool: 'notice.preview',
  read(snapshot, args, locale, slots, targets) {
    const localArgs = expand(args, slots, targets);
    if (!record(localArgs)) return { status: 'missing' };
    const l = labels(locale);
    const result = record(localArgs.draft) && validateAgentCommandArgs('notice.saveDraft', localArgs.draft)
      ? previewNotice(snapshot, { draft: localArgs.draft as DraftFields }, now(snapshot))
      : typeof localArgs.noticeId === 'string' && typeof localArgs.draftRevision === 'number'
        ? previewNotice(snapshot, { noticeId: localArgs.noticeId, draftRevision: localArgs.draftRevision }, now(snapshot)) : undefined;
    if (!result) return { status: 'missing' };
    if (!result.ok) return { facts: [fact('notice.preview.issue', l.preview, statusKey(result.messageKey, l))] };
    return { facts: previewFacts(result.preview, l) };
  },
};

type LocalNoticeCommand = Extract<NoticeCommand, { type: 'notice.saveDraft' | 'notice.importClosure' | 'notice.deleteDraft' }>;
type DraftFields = Omit<Extract<NoticeCommand, { type: 'notice.saveDraft' }>, 'type' | 'baseRevision' | 'idempotencyKey'>;
const slotValidators = { title: text, body: text, startDate: isIsoDate, endDate: isIsoDate, groupIds: groups };
const rejection = (result: Extract<DataCommandResult, { ok: false }>) => ({
  kind: result.reason === 'TRANSACTION_BUSY' ? 'busy' as const : result.code === 'CONFLICT' || result.code === 'NOT_FOUND' ? 'conflict' as const : 'invalid' as const,
  field: result.field, messageKey: result.messageKey,
});
const dash = '—';
function commandAdapter(type: LocalNoticeCommand['type']): CommandAdapter<LocalNoticeCommand, { draft: LocalNoticeCommand; locale: Locale }> {
  return {
    command: type, featureId, slots: slotValidators,
    resolve(wire, slots, snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const args = expand(wire, slots, targets);
      if (!record(args) || !validateAgentCommandArgs(type, args)) return;
      if (typeof args.noticeId === 'string' && !snapshot.tables.noticeDraft.some(row => row.noticeId === args.noticeId)) return;
      if (type === 'notice.importClosure' && slots.closureTarget !== undefined && args.eventId !== slots.closureTarget) return;
      return { draft: { ...args, type } as LocalNoticeCommand, locale: slotLocale(slots.navisLocale) };
    },
    preflight({ draft, locale }, { snapshot, proposalId, idempotencyKey }) {
      const command = { ...draft, idempotencyKey };
      const after = noticeHandlers[type]({ snapshot, tables: snapshot.tables, now: now(snapshot), nextId: prefix => `${prefix}-navis-${proposalId}` }, command);
      if (!after.ok) return rejection(after);
      if (after.tables === snapshot.tables) return { kind: 'unchanged' };
      const before = snapshot.tables.noticeDraft.find(row => row.noticeId === command.noticeId);
      const nextId = record(after.value) ? after.value.noticeId : undefined;
      const next = after.tables.noticeDraft.find(row => row.noticeId === nextId);
      const l = labels(locale);
      const fields = [
        { label: l.title, before: before?.title ?? dash, after: next?.title ?? dash },
        { label: l.body, before: before?.body ?? dash, after: next?.body ?? dash },
        { label: l.dates, before: before ? dates(before.startDate, before.endDate, l) : dash, after: next ? dates(next.startDate, next.endDate, l) : dash },
        { label: l.kind, before: before ? kindLabel(before.kind, l) : dash, after: next ? kindLabel(next.kind, l) : dash },
        { label: l.recipients, before: before ? audienceLabel(before, l) : dash, after: next ? audienceLabel(next, l) : dash },
        { label: l.className, before: before ? classLabel(before.contentClass, l) : dash, after: next ? classLabel(next.contentClass, l) : dash },
      ].filter(field => !before || !next || field.before !== field.after || field.label === l.title);
      if (next?.closureEventId) {
        const link = selectDraftClosureLink({ tables: after.tables }, next);
        const key = link === 'changed' ? 'CLOSURE_CHANGED' : link === 'removed' ? 'CLOSURE_REMOVED' : link === 'dates' ? 'CLOSURE_DATES_DIFFER' : undefined;
        if (key) fields.push({ label: l.closure, before: dash, after: statusKey(`data.notices.error.${key}`, l) });
        else if (type === 'notice.importClosure') fields.push({ label: l.closureRevision, before: before?.closureRevision?.toString() ?? dash, after: next.closureRevision?.toString() ?? dash });
      }
      const title = type === 'notice.deleteDraft' ? l.tr('공지 초안 지우기', 'Delete notice draft', '删除通知草稿', '刪除通知草稿')
        : type === 'notice.importClosure' ? l.tr('캘린더에서 불러오기', 'Import from calendar', '从日历导入', '從行事曆匯入')
          : l.tr('임시 저장하기', 'Save draft', '保存草稿', '儲存草稿');
      return { kind: 'ready', command, preview: { title, target: next?.title ?? before?.title, fields } };
    },
    undoToken: result => result.undoToken,
  };
}

const isStamp = (value: unknown): value is string => typeof value === 'string' && value.length === 16 && value[10] === 'T'
  && isIsoDate(value.slice(0, 10)) && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.slice(11));
type SendDraft = { noticeId: string; draftRevision: number; sendAt?: string; automaticNight: boolean; locale: Locale };
/** D-326 Q4: the same preview the commit checks, now or at the chosen time. */
function sendPreview(snapshot: DataSnapshot, noticeId: string, draftRevision: number, sendAt?: string) {
  if (sendAt === undefined) return previewNotice(snapshot, { noticeId, draftRevision }, now(snapshot));
  const result = prepareScheduledNoticePreview({ tables: snapshot.tables }, { noticeId, draftRevision }, sendAt, now(snapshot));
  if (!result.ok) return result;
  const { recipientCount, excludedCount, renderedBody, contentClass, adMarker, sendAllowed, reasons } = result.prepared;
  return { ok: true as const, preview: { draftRevision, contentClass, recipientCount, excludedCount, renderedBody, adMarker, optOutText: '', sendAllowed, reasons } };
}
const send: RunCommandAdapter<SendDraft> = {
  command: 'notice.send',
  slots: { draftRevision: value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0, sendAt: isStamp },
  resolve(wire, slots, snapshot, targets) {
    if (!validateAgentDraft('notice.send', wire)) return;
    const args = expand(wire, slots, targets);
    if (!record(args) || typeof args.noticeId !== 'string' || typeof args.draftRevision !== 'number' || !validateAgentCommandArgs('notice.send', args)) return;
    const sendAt = args.sendAt;
    if (sendAt !== undefined && !isStamp(sendAt)) return;
    const timeRef: unknown = wire.sendAt;
    if (sendAt !== slots.sendAt || (timeRef !== undefined && (!record(timeRef) || timeRef.slot !== 'sendAt' || sendAt === undefined))) return;
    const automaticNight = slots.noticeNightAuto === true && sendAt !== undefined && sendAt === automaticNightSchedule(now(snapshot));
    return { noticeId: args.noticeId, draftRevision: args.draftRevision, sendAt, automaticNight, locale: slotLocale(slots.navisLocale) };
  },
  preflight({ noticeId, draftRevision, sendAt, automaticNight, locale }, { snapshot, idempotencyKey }) {
    const draft = snapshot.tables.noticeDraft.find(row => row.noticeId === noticeId);
    if (!draft) return { kind: 'conflict' };
    if (noticeWidgetStep(snapshot, noticeId, sendAt !== undefined)) return { kind: 'invalid' };
    if (alreadySent(snapshot, draft)) return { kind: 'unchanged' };
    const result = sendPreview(snapshot, noticeId, draftRevision, sendAt);
    if (!result.ok) return rejection(result);
    const { preview } = result;
    if (!preview.sendAllowed) return { kind: 'invalid', messageKey: `data.notices.error.${preview.reasons[0]}` };
    const l = labels(locale);
    const fields = [
      ...(sendAt ? [{ label: l.sendTime, before: dash, after: automaticNight ? NIGHT_NOTICE_TIME_LABEL : l.format.dateTime(sendAt, { today: businessDate(snapshot) }) }] : []),
      { label: l.revision, before: dash, after: l.format.number(draft.revision) },
      { label: l.body, before: dash, after: preview.renderedBody },
      { label: l.className, before: dash, after: classLabel(preview.contentClass, l) },
      { label: l.recipients, before: dash, after: draft.channel ? audienceLabel(draft, l) : `${audienceLabel(draft, l)} · ${people(preview.recipientCount, l)}` },
      { label: l.excluded, before: dash, after: people(preview.excludedCount, l) },
    ];
    // HTTP builds run the same command through the service (the card press is still the only trigger); the fixture ignores this.
    const realCommand: DataCommand = { type: 'notice.send', noticeId, draftRevision, previewId: 'service', ...(sendAt ? { sendAt } : {}), idempotencyKey };
    return { kind: 'ready', realCommand, preview: { title: sendAt ? l.scheduledSend : l.tr('공지 보내기', 'Send notice', '发送通知', '傳送通知'), target: draft.title, fields },
      execute(run, store) {
        if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
        const prepared = store.dispatch({ type: 'notice.preview', noticeId, draftRevision, ...(sendAt ? { sendAt } : {}), baseRevision: snapshot.revision });
        if (!prepared.ok) return rejection(prepared);
        if (!record(prepared.value) || typeof prepared.value.previewId !== 'string' || prepared.value.sendAllowed !== true) return { kind: 'invalid' };
        const applied = store.dispatch({ type: 'notice.send', noticeId, draftRevision, ...(sendAt ? { sendAt } : {}),
          previewId: prepared.value.previewId, idempotencyKey, baseRevision: prepared.revision });
        if (!applied.ok) return rejection(applied);
        const status = record(applied.value) ? applied.value.status : undefined;
        if (status !== (sendAt ? 'scheduled' : 'sent_example') || !applied.noticeKey) return { kind: 'unchanged' };
        const messageKey = applied.noticeKey === 'data.notices.notice.sent' ? 'data.notice.sent' : applied.noticeKey;
        const sentId = record(applied.value) ? applied.value.sentId : undefined;
        const isCancellable = () => {
          const current = store.getSnapshot();
          return typeof sentId === 'string' && run.getState().runId === snapshot.runId && current.runId === snapshot.runId
            && !!cancellableNoticeSchedule(current.tables, sentId, now(current));
        };
        const scheduledNotice = sendAt && typeof sentId === 'string' ? {
          isCancellable,
          cancel: () => isCancellable() && store.dispatch({ type: 'notice.cancelSchedule', sentId, idempotencyKey: idempotencyKey + ':cancel' }).ok,
        } : undefined;
        return { kind: 'applied', notice: { kind: 'success', featureId, messageKey,
          ...(automaticNight ? { params: { sendTime: NIGHT_NOTICE_TIME_LABEL } } : {}) }, scheduledNotice };
      },
    };
  },
};

const noticeWords = /공지|^\s*보낸\s*기록|수신자\s*목록|수신\s*거부\s*문구|광고\s*문자|^\s*미리보기\s*보여|^\s*초안(?:에\s*뭐라고|\s*(?:저장\s*:|불러와서\s*편집|(?:다\s*)?날려))|휴무(?:\s*일정.*초안|.*문자\s*(?:돌려|보내))/u;
const inquiryWords = /수신\s*거부|광고\s*표시|광고로\s*분류|몇\s*명|받는\s*사람\s*수|누가\s*받|미리보기/u;
const historyWords = /보낸\s*(?:공지|기록)|지난\s*공지|공지\s*발송\s*(?:기록|내역)/u;
const editorWords = /열어|열기|화면|이어서\s*쓸|편집하게/u;
const deleteWords = /지워|지우|삭제|날려|없애/u;
const sendWords = /보내|발송\s*(?:해|까지)|문자\s*돌려|쏴\s*줘/u;
const scheduleWords = /예약|내일|모레|(?:오전|오후|아침|저녁|밤|새벽)\s*\d{1,2}\s*시|\d{1,2}\s*시(?:에|쯤|까지)|\b\d{1,2}:\d{2}\b/u;
const changeWords = /바꿔|바꾸|수정|고쳐|고치|늘려|기간|종료일|종류|제목만|(?:그룹|단골(?:한테|로)?)만\s*(?:받게|해\s*줘)/u;
const dateWords = /\b\d{1,4}[-./]\d{1,2}|\d+\s*(?:월|일)|오늘|내일|모레|어제|요일|월말|(?:다음|지난|이번)\s*주/u;
const rangeWords = /부터|에서\s*\d|[~～]|까지/u;
const couponWords = /쿠폰|할인|광고/u;
const draftWriteWords = /저장(?:해|\s*[:：]|\s*$|\s+(?!한\b))|써\s*(?:줘|둬|줘요|서)|만들|초안\s*(?::|\S+\s+\S+)|공지글/u;
const quotePattern = /'([^']+)'|"([^"]+)"|‘([^’]+)’|“([^”]+)”/gu;
const stripQuotes = (value: string) => value.replace(quotePattern, ' ');
const trimTail = (value: string | undefined) => value?.replace(/\s*(?:로\s*)?(?:바꿔\s*줘|고쳐\s*줘|수정해\s*줘|(?:고치고|바꾸고|수정하고)\s*.*|공지\s*초안\s*(?:만들어\s*줘|저장해\s*줘))\s*[.!?]*$/u, '').trim();
const groupOf = (wording: string): CustomerGroupId | undefined => /단골/u.test(wording) ? 'regular' : /첫\s*방문/u.test(wording) ? 'first-visit'
  : /떠날\s*수|이탈/u.test(wording) ? 'churn-risk' : undefined;
const kindOf = (wording: string): NoticeDraft['kind'] | undefined => /영업\s*시간\s*변경/u.test(wording) ? 'hours_change'
  : /정기\s*휴무/u.test(wording) ? 'regular_closure' : /임시\s*휴무/u.test(wording) ? 'temporary_closure' : /종류\s*(?:를\s*)?기타/u.test(wording) ? 'other' : undefined;
const noticeLookup = (bind?: string): DomainLookup => ({ kind: 'noticeDraft', querySlot: 'noticeQuery', ...(bind ? { bind: [bind] } : {}) });
const handoffTarget = (row?: NoticeDraft) => ({ featureId, command: 'notice.send', draft: row ? { noticeId: row.noticeId } : {} });
const refuse = (answer?: string, row?: NoticeDraft): DomainRoute => ({ kind: 'refusal', reason: 'widget_only', answer, alternative: handoffTarget(row) });

function fieldsFromText(value: string) {
  const quotes = [...value.matchAll(quotePattern)].map(match => ({ at: match.index, end: match.index + match[0].length, value: match.slice(1).find(Boolean)! }));
  const titleLabel = /제목(?:만|은|을|이)?\s*[:=]?\s*/u;
  const bodyLabel = /(?:본문|내용|문구)(?:만|은|을|에|이)?\s*[:=]?\s*/u;
  const firstIsBody = !!quotes[0] && (bodyLabel.test(value.slice(0, quotes[0].at)) && !titleLabel.test(value.slice(0, quotes[0].at))
    || /^\s*(?:라는\s*)?(?:내용|문구)(?:으로|을)/u.test(value.slice(quotes[0].end)));
  const grabTitle = value.match(/제목(?:만|은|을|이)?\s*[:=]?\s*(.+?)(?=\s+(?:본문|내용)|\s+\/\s+|$)/u)?.[1];
  const grabBody = value.match(/(?:본문|내용)(?:만|은|을|에|이)?\s*[:=]?\s*(.+?)(?=\s+제목|$)/u)?.[1];
  const usable = (candidate?: string) => candidate && !/^['"‘“]/u.test(candidate) ? trimTail(candidate) : undefined;
  const colon = value.match(/(?:초안|써\s*둬)\s*(?:저장)?\s*:\s*(?:제목\s*)?([^/]+?)(?:\s*\/\s*(.+))?\s*$/u);
  const inline = value.match(/^(?!공지\s+초안)(.+?)\s+(?:공지\s+)?초안\s+(?:(?:저장|써\s*둬)(?:해\s*줘)?\s+)?(\S.+)$/u);
  const dictate = value.match(/^(.+?)\s+공지\s+써\s*둬\s+(.+)$/u);
  const stripLeadDate = (candidate: string) => candidate.replace(/^(?:[^,]+?부터\s*[^,]+?까지|(?:이번|다음|지난)\s*주\s*[월화수목금토일]\s*[~～]\s*[월화수목금토일]|(?:오늘|내일|모레|어제)(?:\s*하루|\s*날짜로)?|(?:(?:이번|다음|지난)\s*주\s*)?[월화수목금토일]요일(?:에)?|\d{1,2}\s*일)\s*/u, '').trim();
  const lead = value.match(/^(.*?)\s*(?:공지(?:에|를)?\s*(?:초안\s*)?|초안\s*)(?:써\s*둬|만들어\s*줘|저장(?:해\s*줘)?|(?=내용))/u)?.[1]
    ?.replace(/^(?:(?:오늘|내일|모레|어제)(?:\s*하루|\s*날짜로)?|(?:(?:이번|다음|지난)\s*주\s*)?[월화수목금토일]요일(?:에)?)\s*/u, '').trim();
  const inlineBody = (dictate?.[2] ?? inline?.[2])?.replace(/\s+(?:문구로\s*)?(?:오늘|내일|모레)\s*하루\s*$/u, '').trim();
  const title = (firstIsBody ? undefined : quotes[0]?.value) ?? usable(grabTitle) ?? colon?.[1].trim()
    ?? (lead && !bodyLabel.test(lead) ? stripLeadDate(lead) : undefined) ?? (inline && !bodyLabel.test(inline[1]) ? stripLeadDate(inline[1]) : undefined);
  const body = (firstIsBody ? quotes[0]?.value : quotes[1]?.value) ?? usable(grabBody) ?? colon?.[2]?.trim()
    ?? (inlineBody && !/^(?:있|뭐|만들|넣|써|지워|저장|해\s*줘|하나|보여)/u.test(inlineBody) ? inlineBody : undefined);
  return { title, body };
}

function targetDraft(snapshot: DataSnapshot, wording: string, date?: string, title?: string) {
  const { drafts } = selectNotices(snapshot);
  if (title) return drafts.filter(row => normalizeNavisName(row.title) === normalizeNavisName(title));
  const plain = normalizeNavisName(wording);
  const titled = drafts.filter(row => normalizeNavisName(row.title).length > 1 && plain.includes(normalizeNavisName(row.title)));
  if (titled.length) return titled;
  return noticeMatches(drafts, `${/휴무/u.test(wording) ? '휴무' : ''}\n${date ?? ''}`);
}

function quotedNoticeTitle(raw: string) {
  const quote = [...raw.matchAll(quotePattern)][0];
  return quote && /^\s*공지(?:를|는)?(?:\s|$)/u.test(raw.slice(quote.index + quote[0].length))
    ? quote.slice(1).find(Boolean) : undefined;
}

function noticeSubject(prefix: string) {
  return prefix
    .replace(/(?:\d{4}[-./])?\d{1,2}[-./]\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일|(?:오늘|내일|모레)(?:에)?|(?:이번|다음)\s*주\s*[월화수목금토일]요일|\d{1,2}\s*일/gu, ' ')
    .replace(/(?:(?:오전|오후|아침|저녁|밤|새벽)\s*)?(?:\d{1,2}\s*시(?:\s*(?:반|\d{1,2}\s*분))?|\d{1,2}:\d{2})(?:에|쯤)?/gu, ' ')
    .trim();
}

function readDraft(querySlot: string, query: string, fallback?: string): DomainRoute {
  return { intent: { kind: 'read', recordKind: 'noticeDraft', querySlot }, slots: { [querySlot]: query }, browse: querySlot === 'noticeQuery',
    ...(fallback ? { onMissing: { answer: fallback } } : {}) };
}
function saveDraft(fields: DraftFields, locale: Locale, before?: NoticeDraft): DomainRoute {
  return { intent: { kind: 'command', command: 'notice.saveDraft', args: {
    kind: fields.kind, title: slot('title'), body: slot('body'), startDate: slot('startDate'), endDate: slot('endDate'),
    audience: fields.audience, groupIds: slot('groupIds'),
  } }, slots: { title: fields.title, body: fields.body, startDate: fields.startDate, endDate: fields.endDate,
    groupIds: fields.groupIds, navisLocale: locale, ...(before ? { noticeQuery: `id:${before.noticeId}` } : {}) },
    ...(before ? { lookups: [noticeLookup('noticeId')] } : {}) };
}

function noticePeriod(value: string, day: string) {
  const wording = value.replace(/월말/u, '이번 달 말')
    .replace(/((?:다음|이번|지난)\s*주)\s*([월화수목금토일])\s*[~～]\s*([월화수목금토일])(?=\s|$)/u, '$1 $2요일부터 $1 $3요일까지')
    .replace(/((?:다음|이번|지난)\s*주)\s*([월화수목금토일]요일)부터\s*([월화수목금토일]요일)까지/u, '$1 $2부터 $1 $3까지')
    .replace(/(\d+\s*월\s*\d+\s*일)부터\s*(\d+\s*일)까지/u, (match, start: string, end: string) => `${start}부터 ${match.match(/\d+\s*월/u)?.[0]} ${end}까지`)
    .replace(/(\d+\s*일)에서\s*(\d+\s*일)까지/u, `${Number(day.slice(5, 7))}월 $1부터 ${Number(day.slice(5, 7))}월 $2까지`);
  return parseNavisPeriod(wording, day);
}

function route(raw: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined {
  const value = normalizeNavisInput(raw);
  const wording = stripQuotes(value);
  const implicitDraft = /(?:내용|본문).*초안.*제목/u.test(wording)
    || /^(?:\d+\s*월|(?:다음|이번)\s*주).*초안/u.test(wording);
  if (!noticeWords.test(wording) && !implicitDraft) return;
  const l = labels(locale);
  const day = businessDate(snapshot);
  const period = noticePeriod(wording, day);
  const dayOfMonth = wording.match(/^\s*(\d{1,2}\s*일)(?=\s)/u)?.[1];
  const date = parseNavisDate(wording, day) ?? (dayOfMonth ? parseNavisDate(`${Number(day.slice(5, 7))}월 ${dayOfMonth}`, day) : undefined);
  const rangeEdit = /종료일|까지.*늘려|기간.*바꿔/u.test(wording);
  const isHistory = historyWords.test(wording);
  const isDelete = deleteWords.test(wording);
  const requestsSchedule = /예약\s*(?:해|발송|보내)|(?:\d|내일|모레)\s*예약/u.test(wording);
  const isSend = sendWords.test(wording) || requestsSchedule;
  const hasSendTime = isSend && scheduleWords.test(wording);
  const identityDate = rangeEdit ? parseNavisDate(wording.split(/휴무를|종료일|기간|부터/u)[0], day) : hasSendTime ? undefined : date;
  const namedTitle = quotedNoticeTitle(raw);
  const matches = targetDraft(snapshot, wording, identityDate, namedTitle);
  const detail = run?.overlay.type === 'detail' ? run.overlay.stack?.at(-1) : undefined;
  const selected = /^(?:이|그|해당)\s*공지/u.test(wording) && detail?.featureId === featureId && !namedTitle && !identityDate
    ? matches.find(row => row.noticeId === detail.itemId) : undefined;
  const rows = selected ? [selected] : matches;
  const draft = rows.length === 1 ? rows[0] : undefined;
  const query = draft ? `id:${draft.noticeId}` : `${namedTitle ?? (/휴무/u.test(wording) ? '휴무' : '')}\n${identityDate ?? ''}`;
  const clarify = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute => ({ kind: 'clarification', field, answer, resume });
  const chooseDraft = () => clarify('noticeId', l.tr('어느 공지 초안인가요?', 'Which notice draft?', '是哪份通知草稿？', '是哪份通知草稿？'));
  const badPeriod = () => clarify('period', l.tr('시작 날짜와 종료 날짜를 확인해 주세요', 'Check the start and end dates.', '请核对开始和结束日期。', '請核對開始和結束日期。'));
  const past = () => clarify('period', statusKey('data.notices.error.PAST_DATE', l));
  const canWrite = implicitDraft || draftWriteWords.test(wording) || /공지.*초안/u.test(wording) && [...raw.matchAll(quotePattern)].length > 1;
  const isPreview = /미리보기|보내기\s*전에|어떻게\s*보이/u.test(wording);
  const isImport = /불러|가져/u.test(wording) && /캘린더|달력|휴무/u.test(wording) && !editorWords.test(wording)
    || /(?:캘린더|달력|휴무\s*일정).*공지\s*(?:초안\s*)?만들/u.test(wording);

  const smsHandoff = (saved: NoticeDraft, automaticNight = false): DomainRoute => {
    const closureLink = selectDraftClosureLink(snapshot, saved);
    if (closureLink !== 'current' && closureLink !== 'none') {
      const key = closureLink === 'changed' ? 'CLOSURE_CHANGED' : closureLink === 'removed' ? 'CLOSURE_REMOVED' : 'CLOSURE_DATES_DIFFER';
      return clarify('closureEventId', statusKey(`data.notices.error.${key}`, labels('ko')));
    }
    return { kind: 'refusal', reason: 'widget_only',
      ...(automaticNight ? { answer: '공지 발송에서 내일 8시로 예약해 주세요' } : {}),
      alternative: { featureId, step: 'sms-schedule', itemId: saved.noticeId } };
  };
  if (snapshot.tables.realInbox && !isSend && !isDelete && /(?:문자|공지).*예약|예약.*(?:문자|공지)/u.test(wording)
    && /몇\s*(?:건|개)|현황/u.test(wording)) {
    const reservations = smsReservations(snapshot);
    return { intent: { kind: 'read', featureId, condition: defaultCondition }, factKeys: [
      'notice.sms.scheduled.count',
      ...(/현황/u.test(wording) ? reservations.slice(0, 8).flatMap((_, i) => [`notice.sms.${i}.status`, `notice.sms.${i}.time`]) : []),
    ] };
  }
  if (/명단|전화번호|수신자\s*목록|엑셀/u.test(wording) && /받|수신/u.test(wording)) {
    const count = selectNotices(snapshot).sent[0]?.recipientCount;
    const answer = l.tr('받는 사람 명단은 보여줄 수 없어요', 'The recipient list is private.', '收件人名单不公开。', '收件者名單不公開。');
    return { kind: 'refusal', reason: 'unsupported', answer: count === undefined ? answer : `${answer}\n${l.recipients} ${people(count, l)}` };
  }
  if (/밤|아침\s*8시|몇\s*시까지|시간\s*제한/u.test(wording) && !requestsSchedule && !/예약\s*해서|자동/u.test(wording)
    && /수\s*있|못\s*보내|시간\s*제한|몇\s*시까지/u.test(wording)) return { kind: 'answer', answer: l.night };
  if (isDelete && (isHistory || /전부|싹\s*다|모두|초안\s*다/u.test(wording))) {
    return { kind: 'refusal', reason: 'unsupported' };
  }
  if (isHistory && !isDelete) {
    const model = selectNotices(snapshot);
    const keys = model.sent.slice(0, 8).flatMap((_, index) => [`notice.sent.${index}.row`, `notice.sent.${index}.recipientCount`,
      ...(/내용|본문/u.test(wording) ? [`notice.sent.${index}.body`] : []), ...(/시간|일시/u.test(wording) ? [`notice.sent.${index}.sentAt`] : [])]);
    return { intent: { kind: 'read', featureId, condition: defaultCondition }, factKeys: keys, onMissing: { answer: l.missingSent } };
  }
  if (!isSend && !isDelete && /뭐\s*있|있나요|(?:써|만들어)\s*둔\s*공지\s*보여/u.test(wording)) return readDraft('noticeQuery', '*', l.missingDraft);
  if (!isSend && !isDelete && /내용이\s*뭐|본문\s*읽어|뭐라고\s*써/u.test(wording)) return readDraft('noticeBody', query, l.missingDraft);
  if (isImport) {
    const selectedPeriod = period ?? (date ? { start: date, end: date } : undefined);
    const refresh = /다시|갱신|기존/u.test(wording);
    const closures = refresh && draft?.closureEventId && !selectedPeriod
      ? selectStoreClosures(snapshot).filter(closure => closure.eventId === draft.closureEventId)
      : selectStoreClosures(snapshot, selectedPeriod ?? { start: day, end: addDays(day, 366) });
    if (closures.length !== 1) {
      if (closures.length > 1) return clarify('eventId', l.tr('어느 휴무 일정인가요?', 'Which closure?', '是哪条停业日程？', '是哪個公休行程？'));
      return { intent: { kind: 'read', recordKind: 'event', querySlot: 'eventQuery' }, slots: { eventQuery: `휴무\n${date ?? ''}` },
        onMissing: { answer: l.tr('해당 휴무 일정이 없어요', 'No matching closure.', '没有符合的停业日程。', '沒有相符的公休行程。') } };
    }
    const closure = closures[0];
    if (closure.endDate < day) return past();
    const existing = snapshot.tables.noticeDraft.filter(row => row.closureEventId === closure.eventId);
    const create = /새\s*(?:공지|초안)|새로/u.test(wording);
    if (existing.length && !create && !(refresh && existing.length === 1)) return clarify('noticeId',
      l.tr('기존 초안을 바꿀까요, 새로 만들까요?', 'Update the draft or create a new one?', '更新现有草稿，还是新建？', '更新現有草稿，還是新建？'),
      choice => /기존|다시|갱신/u.test(choice) ? route(`${value} 기존 초안`, snapshot, locale) : /새/u.test(choice) ? route(`${value} 새로`, snapshot, locale) : undefined);
    const old = !create && refresh ? existing[0] : undefined;
    return { intent: { kind: 'command', command: 'notice.importClosure', args: {} },
      slots: { eventQuery: `${closure.title}\n${closure.startDate}`, closureTarget: closure.eventId, navisLocale: locale, ...(old ? { noticeQuery: `id:${old.noticeId}` } : {}) },
      lookups: [{ kind: 'event', querySlot: 'eventQuery', bind: ['eventId'] }, ...(old ? [noticeLookup('noticeId')] : [])] };
  }
  if (isDelete) {
    if (/지우고|삭제하고|다시\s*쓸/u.test(wording)) return refuse(undefined, draft);
    if (!draft) return rows.length ? chooseDraft() : { kind: 'answer', answer: l.missingDraft };
    return { intent: { kind: 'command', command: 'notice.deleteDraft', args: {} },
      slots: { noticeQuery: query, navisLocale: locale }, lookups: [noticeLookup('noticeId')] };
  }
  const hasAudienceEdit = !!groupOf(wording) && /바꿔|단골|그룹|받/u.test(wording);
  const isEdit = changeWords.test(wording) && /내용|본문|제목|종류|받는\s*사람|단골|그룹|기간|종료일|늘려|고치고|수정하고|바꾸고/u.test(wording);
  if (!isEdit && (isPreview || inquiryWords.test(wording))) {
    if (!draft) return rows.length ? chooseDraft() : readDraft('noticeQuery', query, l.missingDraft);
    if (draft.channel === 'sms') return smsHandoff(draft);
    if (!isPreview && /수신\s*거부|광고\s*표시|광고로\s*분류/u.test(wording)) return readDraft('noticeClass', query, l.missingDraft);
    const hypotheticalAd = !isPreview && couponWords.test(wording);
    const reading: { tool: 'notice.preview'; args: { noticeId: { handle: string }; draftRevision: { slot: string } } | { draft: AgentWireArgs } } = hypotheticalAd
      ? { tool: 'notice.preview', args: { draft: { kind: draft.kind, title: slot('title'), body: slot('body'), startDate: slot('startDate'), endDate: slot('endDate'), audience: draft.audience, groupIds: slot('groupIds') } } }
      : { tool: 'notice.preview', args: { noticeId: { handle: 'pending' }, draftRevision: slot('draftRevision') } };
    return { intent: { kind: 'read', tool: 'notice.preview' }, reading,
      ...(hypotheticalAd ? { slots: { title: l.tr('쿠폰', 'Coupon', '优惠券', '優惠券'), body: draft.body,
        startDate: draft.startDate, endDate: draft.endDate, groupIds: draft.groupIds } }
        : { slots: { noticeQuery: query, draftRevision: draft.revision }, lookups: [{ ...noticeLookup(), readingBind: ['noticeId'] }] }),
      ...(isPreview ? {} : { factKeys: ['notice.preview.recipientCount', 'notice.preview.audienceRule', 'notice.preview.issue'] }) };
  }
  if (isEdit && (!canWrite || draft && (isSend || /(?:쿠폰|할인).*(?:만|그룹).*초안으로|초안으로\s*바꿔/u.test(wording)))) {
    if (!draft) return rows.length ? chooseDraft() : readDraft('noticeQuery', query, l.missingDraft);
    const extracted = fieldsFromText(raw.trim());
    const editTitle = /제목/u.test(wording);
    const couponEdit = couponWords.test(wording) && hasAudienceEdit;
    const editBody = couponEdit || /내용|본문/u.test(wording);
    const quotedField = (label: RegExp) => {
      const tail = raw.match(label)?.[1]?.trim();
      const match = tail && [...tail.matchAll(quotePattern)][0];
      return match && match.index === 0 ? match.slice(1).find(Boolean) : undefined;
    };
    const couponCopy = value.match(/공지를\s+(.+?(?:할인|쿠폰).+?)로\s+바꾸/u)?.[1];
    const body = editBody ? quotedField(/(?:내용|본문)(?:만|은|을|에)?\s*(.*)$/su) ?? (couponEdit ? couponCopy : extracted.body) : undefined;
    const title = editTitle ? quotedField(/제목(?:만|은|을|에)?\s*(.*)$/su) ?? extracted.title : undefined;
    if (editBody && !body) return clarify('body', statusKey('data.notices.error.BODY_REQUIRED', l));
    if (editTitle && !title) return clarify('title', statusKey('data.notices.error.TITLE_REQUIRED', l));
    const groupId = hasAudienceEdit ? groupOf(wording) : undefined;
    const endDate = rangeEdit ? period?.end ?? parseNavisDate(wording.split(/부터|휴무를|종료일|기간/u).at(-1) ?? '', day) : undefined;
    if (rangeEdit && (!endDate || endDate < draft.startDate)) return badPeriod();
    if ((endDate ?? draft.endDate) < day) return past();
    return saveDraft({ kind: kindOf(wording) ?? draft.kind, title: title ?? draft.title, body: body ?? draft.body,
      startDate: draft.startDate, endDate: endDate ?? draft.endDate,
      audience: groupId ? 'group' : draft.audience, groupIds: groupId ? [groupId] : draft.groupIds }, locale, draft);
  }
  if (isSend && !canWrite) {
    // Standing automation stays outside. One scheduled send at a chosen time is a card (D-326 Q4).
    if (/자동\s*(?:으로|발송)|매주|매일|반복/u.test(wording)) return refuse(undefined, draft);
    const prefix = (wording.match(/^(.*?)공지/u)?.[1] ?? '').trim();
    const subject = noticeSubject(prefix);
    const titleMatches = draft && (normalizeNavisName(prefix) === normalizeNavisName(draft.title)
      || normalizeNavisName(subject) === normalizeNavisName(noticeSubject(draft.title)));
    const genericPrefix = /^(?:이|그|해당|저장한|임시\s*저장한|써\s*둔|휴무|정기\s*휴무|임시\s*휴무)?$/u.test(subject);
    if (!draft || !namedTitle && !titleMatches && !genericPrefix) {
      return rows.length ? chooseDraft() : clarify('noticeId', l.tr('문자로 보낼 공지가 없어요', 'There is no notice ready to send by SMS.', '没有可用短信发送的通知。', '沒有可用簡訊傳送的通知。'));
    }
    const audienceText = wording.includes('공지') ? wording.slice(wording.indexOf('공지') + '공지'.length) : wording;
    const recipient = audienceText.match(/((?:단골|첫\s*방문|이탈\s*위험)(?:\s*그룹)?|\S+?)\s*(?:한테|에게)(만|도)?(?=\s|$)/u);
    const only = audienceText.match(/((?:단골|첫\s*방문|이탈\s*위험)(?:\s*그룹)?|\S+?)만(?=\s+(?:(?:바로|지금)\s+)?(?:보내|발송|쏴|문자))/u)?.[1];
    const groupTarget = audienceText.match(/(?:단골|첫\s*방문|이탈\s*위험)\s*그룹(?=\s*대상)/u)?.[0];
    const requested = recipient?.[1] ?? only ?? groupTarget;
    const requestedGroup = requested && /^(?:단골|첫\s*방문|이탈\s*위험)(?:\s*그룹)?$/u.test(requested) ? groupOf(requested) : undefined;
    const quotedRecipient = [...value.matchAll(quotePattern)].some(match => /^\s*(?:한테|에게)(?:만|도)?(?=\s|$)/u.test(value.slice(match.index + match[0].length)));
    const groupMismatch = requestedGroup && (draft.audience !== 'group' || draft.groupIds.length !== 1 || draft.groupIds[0] !== requestedGroup);
    const unrestricted = recipient && !recipient[2] && /^(?:손님들?|회원들?)$/u.test(recipient[1])
      && /^(?:휴무|지금|바로)?$/u.test(noticeSubject(audienceText.slice(0, recipient.index)));
    if (quotedRecipient || groupMismatch || requested && !requestedGroup && !unrestricted) {
      return clarify('audience', '초안의 받는 사람을 확인해 주세요');
    }
    const existing = sentRow(snapshot, draft);
    if (existing) return { kind: 'answer', answer: statusKey(existing.status === 'scheduled' ? 'data.notices.notice.scheduled' : 'data.notice.sent', l) };
    const stamp = draft.channel === 'sms' ? readAppClock().local : now(snapshot);
    const card = (sendAt?: string, automaticNight = false): DomainRoute => ({ intent: { kind: 'command', command: 'notice.send',
      args: { draftRevision: slot('draftRevision'), ...(sendAt ? { sendAt: slot('sendAt') } : {}) } },
      slots: { noticeQuery: query, draftRevision: draft.revision, navisLocale: locale, ...(sendAt ? { sendAt } : {}),
        ...(automaticNight ? { noticeNightAuto: true } : {}) }, lookups: [noticeLookup('noticeId')] });
    const unavailable = (result: Extract<ReturnType<typeof sendPreview>, { ok: false }>) =>
      clarify(result.field === 'closureEventId' ? 'closureEventId' : 'noticeId', statusKey(result.messageKey, l));
    const parseTime = (value: string) => parseNavisTime(value.replace(/밤|저녁/gu, '오후').replace(/아침|새벽/gu, '오전'), stamp);
    const scheduleDate = date ?? day;
    const askTime = (answer: string): DomainRoute => clarify('sendAt', answer, value => {
      const time = parseTime(value);
      return time ? scheduled(`${parseNavisDate(value, day) ?? scheduleDate}T${time}`) : askTime(l.scheduleAsk);
    });
    const scheduled = (sendAt: string, automaticNight = false): DomainRoute => {
      const step = noticeWidgetStep(snapshot, draft.noticeId, true);
      if (step === 'sms-schedule') return smsHandoff(draft, automaticNight);
      if (step) return { kind: 'refusal', reason: 'widget_only',
        alternative: { featureId, step, itemId: draft.noticeId } };
      const result = sendPreview(snapshot, draft.noticeId, draft.revision, sendAt);
      if (!result.ok && result.reason === 'PAST_DATE') return askTime('공지 기간 안에서 발송 시각을 골라 주세요');
      if (!result.ok) return result.field === 'sendAt' ? askTime(statusKey(result.messageKey, l)) : unavailable(result);
      if (!result.preview.sendAllowed) return clarify('audience', statusKey(`data.notices.error.${result.preview.reasons[0]}`, l));
      return card(sendAt, automaticNight);
    };
    const morning = automaticNightSchedule(stamp);
    if (morning && draft.channel === 'sms') return smsHandoff(draft, true);
    if (hasSendTime) {
      const hhmm = parseTime(wording);
      return hhmm ? scheduled(`${scheduleDate}T${hhmm}`) : askTime(l.scheduleAsk);
    }
    if (morning) return scheduled(morning, true);
    if (draft.channel === 'sms') return smsHandoff(draft);
    const result = previewNotice(snapshot, { noticeId: draft.noticeId, draftRevision: draft.revision }, stamp);
    if (!result.ok) return unavailable(result);
    if (!result.preview.sendAllowed) return clarify('audience', statusKey(`data.notices.error.${result.preview.reasons[0]}`, l));
    return card();
  }
  if (canWrite) {
    const end = period?.end ?? date;
    const start = period?.start ?? date;
    if (rangeWords.test(wording) && !period) return badPeriod();
    if (end && end < day) return past();
    if (draft && /휴무/u.test(wording) && date && !/새로|새\s*공지/u.test(wording)) return clarify('noticeId',
      l.tr('기존 초안을 바꿀까요, 새로 만들까요?', 'Update the draft or create a new one?', '更新现有草稿，还是新建？', '更新現有草稿，還是新建？'));
    const extracted = fieldsFromText(raw.trim());
    const composeClosure = date && /대신\s*써|예쁘게\s*써|공지글|쉰다고|쉰다는/u.test(wording) && /휴무|쉬/u.test(wording);
    const title = composeClosure ? `${l.format.date(date, 'short')} ${l.tr('휴무 안내', 'Closure notice', '停业通知', '公休通知')}` : extracted.title;
    const body = composeClosure ? l.tr(`${l.format.date(date, 'long')}은 쉬어요`, `We will be closed on ${l.format.date(date, 'long')}.`, `${l.format.date(date, 'long')}暂停营业。`, `${l.format.date(date, 'long')}暫停營業。`) : extracted.body;
    const groupId = groupOf(wording);
    const proposed = (t: string, b: string, from: string, to: string) => saveDraft({
      kind: kindOf(wording) ?? 'other', title: t, body: b, startDate: from, endDate: to,
      audience: groupId ? 'group' : 'all_contactable', groupIds: groupId ? [groupId] : [],
    }, locale);
    function complete(t?: string, b?: string, from?: string, to?: string): DomainRoute {
      if (!t) return clarify('title', statusKey('data.notices.error.TITLE_REQUIRED', l), answer => complete(answer, b, from, to));
      if (!b && kindOf(wording) === 'hours_change') return clarify('body',
        '영업시간이 바뀌는 날짜와 운영 시간을 알려 주세요. 예를 들면 “11월 28일 10:00~18:00”처럼 말해 주세요.', answer => {
          const changedDate = parseNavisDate(answer, day);
          return complete(t, answer, from ?? changedDate, to ?? changedDate);
        });
      if (!b) return clarify('body', statusKey('data.notices.error.BODY_REQUIRED', l), answer => complete(t, answer, from, to));
      if (!from || !to) return clarify('period', l.tr('공지 날짜를 알려 주세요', 'Enter the notice dates.', '请输入通知日期。', '請輸入通知日期。'), answer => {
        const p = noticePeriod(answer, day), d = parseNavisDate(answer, day);
        return p && p.end >= day ? proposed(t, b, p.start, p.end) : d && d >= day ? proposed(t, b, d, d) : badPeriod();
      });
      return proposed(t, b, from, to);
    }
    const impliedDate = title && body && !dateWords.test(wording) && classifyNoticeContent(title, body) === 'promotional' ? day : undefined;
    return complete(title, body, start ?? impliedDate, end ?? impliedDate);
  }
  if (/내용|본문|뭐라고/u.test(wording)) return readDraft('noticeBody', query, l.missingDraft);
  if (/임시\s*저장|초안|써\s*둔/u.test(wording)) return readDraft('noticeQuery', '*', l.missingDraft);
  if (dateWords.test(wording) && /언제|무슨/u.test(wording)) return { intent: { kind: 'read', featureId, condition: defaultCondition }, factKeys: ['notice.nextClosure.date'] };
  return undefined;
}

function navigation(raw: string, snapshot: DataSnapshot): DomainDetail | null | undefined {
  const wording = stripQuotes(normalizeNavisInput(raw));
  if (!noticeWords.test(wording)) return;
  const history = historyWords.test(wording);
  if (history && !deleteWords.test(wording) && !/제목|내용|시간|몇\s*명/u.test(wording)
    && (editorWords.test(wording) || /기록\s*보여/u.test(wording))) return { args: { featureId, view: 'history' } };
  if (editorWords.test(wording) && /초안|임시\s*저장|써\s*둔/u.test(wording) && !deleteWords.test(wording) && !sendWords.test(wording)) {
    const rows = targetDraft(snapshot, wording, parseNavisDate(wording, businessDate(snapshot)), quotedNoticeTitle(raw));
    if (rows.length !== 1) return null;
    const { noticeId } = rows[0];
    return { args: { featureId, view: 'drafts', itemId: noticeId, focus: 'action' },
      target: { kind: 'noticeDraft', id: noticeId }, querySlot: 'noticeQuery' };
  }
  if (/공지\s*(?:제목|내용|본문)/u.test(wording) && /폼|양식|작성\s*화면/u.test(wording) && editorWords.test(wording)) {
    const field = /공지\s*제목/u.test(wording) ? 'title' : 'body';
    const copy = [...raw.matchAll(quotePattern)][0]?.slice(1).find(Boolean);
    if (copy && validateAgentPrefill(featureId, { [field]: copy })) return { args: { featureId, view: 'compose', focus: 'action', prefill: { [field]: copy } } };
  }
  // "휴무 공지 화면 띄워줘" only opens the screen. Closure wording with a send, delete or write verb still goes to the notice route.
  if (!history && editorWords.test(wording) && /휴무/u.test(wording) && !sendWords.test(wording) && !deleteWords.test(wording) && !draftWriteWords.test(wording)
    && !/받는\s*사람|수신자|공지\s*내용|공지\s*초안|써\s*둔\s*공지|보내기\s*전에/u.test(wording)) return { args: { featureId } };
  if (history || draftWriteWords.test(wording) || /휴무|받는\s*사람|수신자|공지\s*내용|공지\s*초안|써\s*둔\s*공지|보내기\s*전에/u.test(wording)) return null;
}

type FormPrefill = Partial<Omit<DraftFields, 'noticeId' | 'closureEventId'>>;
export function noticeFormPrefill(ref: DetailRef): FormPrefill | undefined {
  if (ref.featureId !== featureId || ref.prefill?.kind !== 'widget-draft') return;
  const fields = ref.prefill.fields;
  if (!validateAgentPrefill(featureId, fields)) return;
  const { title, body, kind, startDate, endDate, audience, groupIds } = fields as Partial<DraftFields>;
  return { ...(title !== undefined && { title }), ...(body !== undefined && { body }), ...(kind !== undefined && { kind }),
    ...(startDate !== undefined && { startDate }), ...(endDate !== undefined && { endDate }),
    ...(audience !== undefined && { audience }), ...(groupIds !== undefined && { groupIds }) };
}

export const noticesDomain: DomainAdapter = {
  featureIds: [featureId],
  commands: [commandAdapter('notice.saveDraft'), commandAdapter('notice.importClosure'), commandAdapter('notice.deleteDraft')],
  runCommands: [send],
  reads: [reader('noticeDraft'), reader('noticeSent')],
  tools: [previewTool],
  projectWidget, route, navigation,
  handoff(command, fields) {
    if (command !== 'notice.send') return;
    const { noticeId, kind, title, body, startDate, endDate, audience, groupIds } = fields;
    const prefill = Object.fromEntries(Object.entries({ kind, title, body, startDate, endDate, audience, groupIds }).filter(([, value]) => value !== undefined));
    return { featureId, view: 'compose', focus: 'action', ...(typeof noticeId === 'string' ? { itemId: noticeId } : {}),
      ...(Object.keys(prefill).length && validateAgentPrefill(featureId, prefill) ? { prefill: { kind: 'widget-draft', command, fields: prefill } } : {}) };
  },
};
