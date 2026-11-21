import type { DetailRef, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import { findPhoneMatch, normalizeMemberPhone as normalizeStoredPhone, normalizeName, sameName } from '../../../data/commands/management-guards';
import { selectMemberDeleteBlockers } from '../../../data/commands/member-guard';
import type { DataCommand } from '../../../data/commands/types';
import type { MemberGrade } from '../../../data/db/management-types';
import { TODAY } from '../../../data/db/time';
import { slotHasPassed } from '../../../data/commands/business-clock';
import type { DataSnapshot } from '../../../data/db/types';
import { resolveDataText, selectMembers, selectWidget } from '../../../data/widget-data';
import { selectMemberAccounts } from '../../../data/iteration7/accounts';
import { selectMoneyRead } from '../../../data/pos/projection';
import {
  validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentWireArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import { navisMoneySpans, normalizeNavisInput, parseNavisDate, parseNavisNumber, parseNavisPeriod, parseNavisQuantity, parseNavisTime } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, LocalSlots, RecordAdapter, RecordSearch, RecordTargets } from './registry';

const credit = 'credit-receivable';
const members = 'members';
const defaultCondition = { kind: 'default' } as const;
const grades = ['regular', 'frequent', 'occasional', 'inactive'] as const;
const bookingCreation = /예약\s*(?:해\s*줘|잡아|부탁|하고|요청(?:\s*해\s*줘|$))|\d+\s*(?:명|인)\s*예약(?=\s*(?:[.,!?]\s*)?(?:요청(?:사항)?[은에]\s|$))/u;
const bookingRead = /예약.*(?:있어|했어|이력|몇\s*시)/u;
const bookingEdit = /예약\s*(?:메모|요청\s*사항)|예약.*(?:취소|캔슬|바꿔|바꾸|고쳐|수정|변경|옮겨|미뤄|지워|삭제|늘려|줄여)/u;
const bookingLink = (text: string) => /회원/u.test(text) && /예약|회원이야\s*연결/u.test(text)
  && /연결|회원.*걸로\s*바꿔|회원\s*예약으로|회원이야/u.test(text);
const moneyWords = /충전|선결제|외상|미수금/u;
const refundWords = /환불\s*(?:해|처리|할)|(?:충전|수금)\s*취소/u;
const noteWords = /메모|특이사항/u;
const passes = /이용권|회원권|구독권|\d+잔권|이용.*사용\s*취소/u;
const passAction = /썼어|사용\s*(?:해|처리|취소|했|기록|한\s*거\s*취소)|차감|팔아|판매\s*(?:해|하)|결제\s*(?:해|진행)/u;
const deleteWords = /삭제|지워|없애|탈퇴|보관(?:해|으로)/u;
const changeWords = /바꿔|바뀌|변경|수정|고쳐/u;
const readWords = /알려|보여|얼마|몇|언제|읽어|뭐|있어|내역|이력|여부|확인/u;
const oldVisitors = /오랜\s*기간|오래|이탈|안\s*오/u;
const gradeOf = (text: string): MemberGrade | undefined => /단골/u.test(text) ? 'regular' : /자주/u.test(text) ? 'frequent'
  : /가끔/u.test(text) ? 'occasional' : oldVisitors.test(text) ? 'inactive' : undefined;
const stringValue = (value: unknown): value is string => typeof value === 'string';
const textField = (value: unknown): value is string => stringValue(value) && !!value.trim() && value.length <= 1000;
const phoneField = (value: unknown): value is string => stringValue(value) && /^0\d{9,10}$/u.test(value);
const positiveAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const slot = (key: string) => ({ slot: key });
const localized = (locale: Locale, ko: string, en: string, hans: string, hant: string) =>
  locale === 'ko' ? ko : locale === 'en' ? en : locale === 'zh-Hans' ? hans : hant;
const tr = navisTranslator;
type Member = ReturnType<typeof selectMembers>['rows'][number];
const memberRows = (snapshot: DataSnapshot) => selectMembers(snapshot, {}).rows;
const nameOf = (row: Member, locale: Locale) => typeof row.name === 'string' ? row.name : resolveDataText(tr(locale).t, row.name);
const memberHandle = (snapshot: DataSnapshot, memberId: string) => `member-${snapshot.tables.memberProfile.findIndex(row => row.memberId === memberId) + 1}`;
const customerIndex = new WeakMap<DataSnapshot, ReadonlyMap<string, DataSnapshot['tables']['marketing']['mktCustomer'][number]>>();
function customerOf(snapshot: DataSnapshot, member: Member) {
  let customers = customerIndex.get(snapshot);
  if (!customers) {
    customers = new Map(snapshot.tables.marketing.mktCustomer.map(row => [row.customerId, row]));
    customerIndex.set(snapshot, customers);
  }
  return customers.get(member.customerId);
}
const noteText = (row: Member['notes'][number], locale: Locale) => resolveDataText(tr(locale).t, row.body);
const accounts = (snapshot: DataSnapshot) => selectWidget(snapshot, credit, defaultCondition, 'normal');
const noValue = (locale: Locale) => tr(locale).t('common.navis.agent.none');
const gradeLabel = (locale: Locale, grade: MemberGrade) => ({
  regular: localized(locale, '단골', 'Regular', '常客', '常客'),
  frequent: localized(locale, '자주 방문', 'Frequent', '经常到访', '經常到訪'),
  occasional: localized(locale, '가끔 방문', 'Occasional', '偶尔到访', '偶爾到訪'),
  inactive: localized(locale, '오랜 기간 미방문', 'Inactive', '长期未到访', '長期未到訪'),
})[grade];

export function normalizeMemberPhone(input: string): string | undefined {
  const value = input.normalize('NFKC').replace(/[\s().-]/gu, '').replace(/[공영일이삼사오육칠팔구]/gu, digit =>
    String(digit === '공' ? 0 : '영일이삼사오육칠팔구'.indexOf(digit)));
  if (!/^\+?\d+$/u.test(value)) return;
  const canonical = value.replace(/^\+?82(?:0)?(?=\d{8,10}$)/u, '+82');
  const local = normalizeStoredPhone(canonical);
  return phoneField(local) ? local : undefined;
}

function memberMatches(snapshot: DataSnapshot, query: string, locale: Locale) {
  const key = normalizeName(query);
  if (!key) return [];
  const rows = memberRows(snapshot);
  if (/^\d{4}$/u.test(key)) return rows.filter(row => row.phone.endsWith(key));
  const exact = rows.filter(row => {
    const name = customerOf(snapshot, row)?.name ?? nameOf(row, locale);
    return [row.memberCode, row.memberId].some(id => id && normalizeName(id) === key) || sameName(name, key);
  });
  return exact.length ? exact : !/\d/u.test(key) && key.length >= 2 ? rows.filter(row => {
    const name = customerOf(snapshot, row)?.name;
    return name && (normalizeName(name).slice(1) === key);
  }) : [];
}

function memberSearchRows(search: RecordSearch) {
  const { snapshot, query, locale, command, querySlot } = search;
  if (command === 'members.create' || command === 'members.update' && querySlot === 'phone') {
    const phone = normalizeMemberPhone(query);
    const hit = phone && findPhoneMatch(snapshot.tables, phone);
    if (!hit) return [];
    return [{ id: hit.memberId ?? hit.customerId, handle: hit.memberId ? memberHandle(snapshot, hit.memberId)
      : `customer-${snapshot.tables.marketing.mktCustomer.findIndex(row => row.customerId === hit.customerId) + 1}`,
    name: hit.name, phone: hit.phone, fields: undefined }];
  }
  return memberMatches(snapshot, query, locale).map(row => ({
    id: row.memberId, handle: memberHandle(snapshot, row.memberId), name: nameOf(row, locale), phone: row.phone,
    fields: { grade: row.grade, ...(command === 'members.delete' ? { deleteBlocked: selectMemberDeleteBlockers(snapshot, row.memberId).blocked } : {}) },
  }));
}

const memberReader: RecordAdapter = {
  kind: 'member',
  search(search) {
    const rows = memberSearchRows(search);
    return rows.map(row => ({
      handle: row.handle, match: 'exact',
      ...(!search.privateLookup ? { label: rows.length > 1 && row.phone ? `${row.name} · ${row.phone}` : row.name } : {}),
      ...(row.fields ? { fields: row.fields } : {}),
    }));
  },
  resolve: (search, handle) => memberSearchRows(search).find(row => row.handle === handle)?.id,
  describe(match, locale, search) {
    if (!search) return match.fields?.grade ? gradeLabel(locale, match.fields.grade as MemberGrade) : undefined;
    const row = memberSearchRows(search).find(item => item.handle === match.handle);
    const member = row && memberRows(search.snapshot).find(item => item.memberId === row.id);
    if (!row || !member) return;
    const label = row.name;
    const t = tr(locale);
    const l = (ko: string, en: string, hans: string, hant: string) => localized(locale, ko, en, hans, hant);
    if (search.querySlot === 'lastVisit') return `${label} · ${member.lastVisit ? t.format.date(member.lastVisit, 'short') : noValue(locale)}`;
    if (search.querySlot === 'consent') return `${label} · ${member.consentSms ? l('문자 수신 동의', 'SMS consent', '已同意接收短信', '已同意接收簡訊') : l('문자 수신 미동의', 'No SMS consent', '未同意接收短信', '未同意接收簡訊')}`;
    if (search.querySlot === 'visitsToday' || search.querySlot === 'reservations') {
      const rows = member.reservations.filter(booking => search.querySlot !== 'visitsToday' || booking.date === TODAY);
      return rows.length ? rows.map(booking => `${label} · ${t.format.date(booking.date, 'short')} ${booking.time}`).join('\n')
        : `${label} · ${l('예약이 없어요', 'No reservations', '没有预约', '沒有預約')}`;
    }
    if (search.querySlot === 'charge' || search.querySlot === 'receivable' || search.querySlot === 'chargeHistory') {
      const view = accounts(search.snapshot);
      const account = view.status === 'ready' ? view.model.members.find(account => account.memberId === row.id) : undefined;
      if (!account) return;
      if (search.querySlot === 'chargeHistory') {
        const rows = account.transactions.filter(transaction => transaction.account === 'charge');
        return rows.length ? rows.slice(0, 10).map(transaction => `${t.format.date(transaction.at, 'short')} · ${t.format.money(transaction.amount, 'full')}`).join('\n')
          : l('충전금 내역이 없어요', 'No prepaid transactions', '没有预付记录', '沒有預付記錄');
      }
      const charge = search.querySlot === 'charge';
      return `${label} · ${charge ? l('충전금', 'Prepaid balance', '预付款', '預付款') : l('외상', 'Receivables', '应收款', '應收款')} ${t.format.money(charge ? account.chargeBalance : account.receivableBalance, 'full')}`;
    }
    return [label, row.phone].filter(Boolean).join(' · ');
  },
};

function notesFor({ snapshot, query, locale }: RecordSearch) {
  let owner: string;
  let body = '';
  try {
    const parsed: unknown = JSON.parse(query);
    if (!object(parsed)) return [];
    owner = stringValue(parsed.owner) ? parsed.owner : '';
    body = stringValue(parsed.body) ? parsed.body : '';
  } catch { owner = query; }
  if (!owner && !body) return [];
  const rows = owner ? memberMatches(snapshot, owner, locale) : memberRows(snapshot);
  const keyword = body.trim().toLocaleLowerCase();
  return rows.flatMap(member => member.notes.filter(note => !keyword || noteText(note, locale).toLocaleLowerCase().includes(keyword)).map(note => ({
    note, member, handle: `note-${snapshot.tables.memberNote.findIndex(row => row.noteId === note.noteId) + 1}`,
  })));
}

const noteReader: RecordAdapter = {
  kind: 'note',
  search(search) {
    return notesFor(search).map(({ note, member, handle }) => ({
      handle, match: 'exact', ...(!search.privateLookup ? { label: nameOf(member, search.locale) } : {}),
      fields: { date: note.updatedAt.slice(0, 10), ...(search.privateLookup ? { ownerHandle: memberHandle(search.snapshot, member.memberId) } : {}) },
    }));
  },
  resolve: (search, handle) => notesFor(search).find(row => row.handle === handle)?.note.noteId,
  describe(match, locale, search) {
    if (!search) return match.fields?.date ? tr(locale).format.date(String(match.fields.date), 'short') : undefined;
    const row = notesFor(search).find(note => note.handle === match.handle);
    return row && `${nameOf(row.member, locale)} · “${noteText(row.note, locale)}”`;
  },
};

const memberCommands = ['members.create', 'members.update', 'members.setGrade', 'members.addNote', 'members.updateNote',
  'members.deleteNote', 'members.delete'] as const;
type MemberCommandType = typeof memberCommands[number];
type MemberCommand = Extract<DataCommand, { type: MemberCommandType }>;
type MemberDraft = { readonly args: Readonly<Record<string, unknown>>; readonly locale: Locale };
function expand(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (!object(value)) return value;
  if (typeof value.slot === 'string') return slots[value.slot];
  if (typeof value.handle === 'string') return targets.get(value.handle)?.id;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, slots, targets)]));
}

function memberAdapter(type: MemberCommandType): CommandAdapter<MemberCommand, MemberDraft> {
  return {
    command: type, featureId: members, slots: { name: textField, phone: phoneField, memo: textField },
    resolve(wire, slots, snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const args = expand(wire, slots, targets);
      if (!object(args) || !validateAgentCommandArgs(type, args)) return;
      if (args.memberId !== undefined && !memberRows(snapshot).some(row => row.memberId === args.memberId)) return;
      const locale = slots.navisLocale;
      return { args, locale: locale === 'en' || locale === 'zh-Hans' || locale === 'zh-Hant' ? locale : 'ko' };
    },
    preflight({ args, locale }, { snapshot, proposalId, idempotencyKey }) {
      const before = memberRows(snapshot).find(row => row.memberId === args.memberId);
      const oldCustomer = before && customerOf(snapshot, before);
      const oldNote = before?.notes.find(row => row.noteId === args.noteId);
      const command = { ...args, type, baseRevision: snapshot.revision, ...(type === 'members.create' ? { idempotencyKey } : {}) } as MemberCommand;
      if (command.type === 'members.update' && (command.name === undefined || command.name.trim() === oldCustomer?.name)
        && (command.phone === undefined || command.phone === oldCustomer?.phone)) return { kind: 'unchanged' };
      if (command.type === 'members.setGrade' && before?.gradeOverride === command.grade) return { kind: 'unchanged' };
      if (command.type === 'members.updateNote' && oldNote && noteText(oldNote, locale) === command.body) return { kind: 'unchanged' };
      const ctx = { snapshot, tables: snapshot.tables, nextId: (prefix: string) => `${prefix}-navis-preview-${proposalId}` };
      const handler = handlers[type] as (context: typeof ctx, command: MemberCommand) => ReturnType<typeof handlers['members.create']>;
      const result = handler(ctx, command);
      if (!result.ok) return { kind: result.code === 'CONFLICT' ? 'conflict' : 'invalid', field: result.field, messageKey: result.messageKey };
      const afterSnapshot = { ...snapshot, tables: result.tables };
      const after = memberRows(afterSnapshot).find(row => row.memberId === (before?.memberId ?? (result.value as { memberId?: string }).memberId));
      const afterNote = after?.notes.find(row => row.noteId === (args.noteId ?? ctx.nextId('note')));
      const l = (ko: string, en: string, hans: string, hant: string) => localized(locale, ko, en, hans, hant);
      const fields = [
        { label: l('이름', 'Name', '姓名', '姓名'), before: before && nameOf(before, locale), after: after && nameOf(after, locale) },
        { label: l('연락처', 'Phone', '号码', '號碼'), before: before?.phone, after: after?.phone },
        { label: l('등급', 'Grade', '等级', '等級'),
          before: before && `${gradeLabel(locale, before.grade)}${before.manuallyGraded ? ` · ${l('직접 정함', 'Manual', '手动', '手動')}` : ''}`,
          after: after && `${gradeLabel(locale, after.grade)}${after.manuallyGraded ? ` · ${l('직접 정함', 'Manual', '手动', '手動')}` : ''}` },
        { label: l('메모', 'Note', '备注', '備註'), before: oldNote && noteText(oldNote, locale), after: afterNote && noteText(afterNote, locale) },
      ].filter(field => field.before !== field.after).map(field => ({ label: field.label,
        before: field.before || noValue(locale), after: field.after || noValue(locale) }));
      // A contact or name change can leave the masked rendering identical.
      if (command.type === 'members.update' && command.phone && before?.phone === after?.phone && after) {
        fields.push({ label: l('연락처', 'Phone', '号码', '號碼'), before: before?.phone ?? '', after: after.phone });
      }
      if (command.type === 'members.update' && command.name && before && after && nameOf(before, locale) === nameOf(after, locale)) {
        fields.push({ label: l('이름', 'Name', '姓名', '姓名'), before: nameOf(before, locale), after: nameOf(after, locale) });
      }
      return { kind: 'ready', command, preview: { title: l('회원목록', 'Members', '会员', '會員'),
        target: before ? nameOf(before, locale) : after ? nameOf(after, locale) : '', fields } };
    },
    undoToken: result => result.undoToken,
  };
}

function projectMembers(snapshot: DataSnapshot, featureId: string, condition: QueryCondition, locale: Locale) {
  if (featureId !== members && featureId !== credit) return;
  if (featureId === members && condition.kind !== 'default') return { status: 'unsupported_period' as const };
  const t = tr(locale);
  const l = (ko: string, en: string, hans: string, hant: string) => localized(locale, ko, en, hans, hant);
  const count = (key: string, label: string, value: number): AgentFact => ({ key, label, value, unit: 'count', display: t.format.number(value), source: featureId });
  const amount = (key: string, label: string, value: number): AgentFact => ({ key, label, value, unit: 'KRW', display: t.format.money(value, 'full'), source: credit });
  const model = selectMembers(snapshot, {});
  if (featureId === members) return { facts: [
    count('members.count', l('회원', 'Members', '会员', '會員'), model.total),
    ...grades.map(grade => count(`members.${grade}.count`, gradeLabel(locale, grade), model.gradeCounts[grade])),
    count('memberships.active.count', l('이용 중 회원권', 'Active passes', '有效会员券', '有效會員券'), model.membershipCount),
    count('memberships.endingThisWeek.count', l('이번 주 끝나는 회원권', 'Passes expiring this week', '本周到期会员券', '本週到期會員券'), model.endingThisWeekCount),
    ...model.rows.flatMap(row => row.memberships.filter(pass => pass.active && pass.endingThisWeek).map(pass => ({
      key: 'memberships.endingThisWeek.member', label: nameOf(row, locale), value: pass.endsOn,
      unit: 'date', display: t.format.date(pass.endsOn, 'short'), source: members,
    }))).slice(0, 5),
  ] };
  if (condition.kind === 'snapshot') return { status: 'unsupported_period' as const };
  const view = accounts(snapshot);
  if (view.status !== 'ready') return { status: view.status === 'error' ? 'unavailable' as const : 'missing' as const };
  const { members: balances, chargeBalance, chargeHolders, receivableBalance, receivableHolders } = view.model;
  const chargeLabel = l('충전금', 'Prepaid balance', '预付款', '預付款');
  const debtLabel = l('외상', 'Receivables', '应收款', '應收款');
  if (condition.kind === 'dateRange') {
    const transactions = selectMemberAccounts(selectMoneyRead(snapshot), { start: condition.start, end: condition.end }).transactions;
    const totals = (kind: 'topup' | 'collection') => transactions.filter(row => row.kind === kind).reduce((sum, row) => sum + Math.abs(row.amount), 0);
    return { facts: [amount('account.period.topup', l('충전 합계', 'Top-ups', '充值合计', '充值合計'), totals('topup')),
      amount('account.period.collection', l('수금 합계', 'Collections', '收款合计', '收款合計'), totals('collection'))] };
  }
  const holderFacts = (key: string, rows: typeof balances, field: 'chargeBalance' | 'receivableBalance') => rows
    .filter(row => row[field] > 0).sort((a, b) => b[field] - a[field]).slice(0, 5)
    .map(row => amount(key, row.name, row[field]));
  return { facts: [
    amount('account.charge.total', chargeLabel, chargeBalance), count('account.charge.members', l('충전금 보유 회원', 'Prepaid holders', '持有预付款会员', '持有預付款會員'), chargeHolders),
    amount('account.receivable.total', debtLabel, receivableBalance), count('account.receivable.members', l('외상 회원', 'Members with receivables', '有应收款的会员', '有應收款的會員'), receivableHolders),
    ...holderFacts('account.charge.rank', balances, 'chargeBalance'), ...holderFacts('account.receivable.holder', balances, 'receivableBalance'),
    ...holderFacts('account.charge.inactive', balances.filter(account => model.rows.some(row => row.memberId === account.memberId && row.grade === 'inactive')), 'chargeBalance'),
  ] };
}

function typedFields(ref: DetailRef) {
  const fields = ref.prefill?.kind === 'widget-draft' ? ref.prefill.fields : undefined;
  return fields && validateAgentPrefill(ref.featureId, fields) ? fields : undefined;
}

export function memberDetailEntry(ref: DetailRef) {
  const fields = ref.view === 'register' ? typedFields(ref) : undefined;
  return { tab: ref.view === 'memberships' ? 'memberships' as const : 'list' as const,
    selected: ref.itemId ?? null, grade: typeof ref.filter === 'object' ? ref.filter.grade : 'all' as const,
    adding: ref.view === 'register', name: typeof fields?.name === 'string' ? fields.name : '', phone: typeof fields?.phone === 'string' ? fields.phone : '' };
}

export function creditDetailEntry(ref: DetailRef) {
  const fields = ref.prefill?.kind === 'widget-draft' && ref.prefill.command === 'ui.openSettlement' ? typedFields(ref) : undefined;
  const purpose = ref.view === 'charge_topup' || ref.view === 'receivable_collection' ? ref.view : undefined;
  return { tab: ref.view === 'charge' ? 'charge' as const : ref.view === 'receivable' || ref.view === 'history' ? 'receivable' as const : 'members' as const,
    memberId: ref.itemId, purpose, amount: fields?.memberId === ref.itemId && fields?.purpose === purpose && positiveAmount(fields?.amount) ? fields.amount : null };
}

function personMention(snapshot: DataSnapshot, input: string, locale: Locale) {
  const id = /\bM-\d{4,}\b/iu.exec(input)?.[0];
  const last4 = /(?:^|\s)(\d{4})(?=\s*(?:회원|손님|인))|(?:끝\s*자리|뒷번호)\s*(\d{4})/u.exec(input);
  if (id || last4) return id ?? last4?.[1] ?? last4?.[2];
  const candidates = [...input.matchAll(/(?:^|\s)([가-힣○]{2,6}(?:\d{4})?)(?=$|[\s?!.,:])/gu)]
    .map(match => ({ key: match[1].replace(/(?:님|씨)$/u, ''), at: match.index })).filter(candidate => candidate.key.length >= 2);
  for (const { key } of candidates) {
    if (memberMatches(snapshot, key, locale).length) return key;
    const alias = key.replace(/(?:으로|한테|에게|이가|이|로)$/u, '');
    if (alias !== key && memberMatches(snapshot, alias, locale).length) return alias;
  }
  const ignored = /^(?:연락처|전화번호|가입한|단골로|손님이|회원이|신규로|미수금|충전금|예시로|오늘은|등록해|삭제해|보여줘|올려줘|메모에|회원권|특이사항|정해줘|알려줘|주차|예약한|끝나는|회원만|받았어|회원으로|손님한테)$/u;
  const prefixed = /(?:^|\s)([가-힣○]{3,5})(?=\s*(?:회원|손님|메모|연락처|전화번호|외상|충전|등급)(?:\s|[은는이을를]?\s|$))/u.exec(input)?.[1];
  return (prefixed && !ignored.test(prefixed) ? prefixed : undefined)
    ?? candidates.find(candidate => candidate.at <= 1 && /^(?:[가-힣○]{3}|예시회원)$/u.test(candidate.key) && !ignored.test(candidate.key))?.key
    ?? /(?:회원\s*(?:등록|추가)\s+|(?:새|신규)\s*손님\s+)([가-힣]{2,4})(?:\s|$)/u.exec(input)?.[1];
}

// personMention also returns an unknown leading name ("정○아"), so a reservation read may only claim a person who is a stored member.
function memberMention(snapshot: DataSnapshot, input: string, locale: Locale) {
  const query = personMention(snapshot, input, locale);
  return !!query && memberMatches(snapshot, query, locale).length > 0;
}

function memberNavigation(input: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  const text = normalizeNavisInput(input);
  if (!/회원|손님|정보|충전|외상|미수금|단골|필터|내역|연락처/u.test(text)) return;
  if (/회원|손님/u.test(text) && deleteWords.test(text)) return null;
  if (/위젯|패널|대시보드|보드|몇\s*페이지/u.test(text) || /^회원\s*목록(?:을)?\s*(?:열어|보여|띄워)/u.test(text)) return;
  const query = personMention(snapshot, text, locale);
  const row = query && memberMatches(snapshot, query, locale);
  const target = row && row.length === 1 ? { kind: 'member' as const, id: row[0].memberId } : undefined;
  if (/회원권\s*(?:탭|목록)|회원(?: 창|목록).*회원권|이번 주 끝나는 회원권 보여/u.test(text)) return { args: { featureId: members, view: 'memberships' } };
  if (/회원.*(?:등록|추가)\s*(?:하는\s*)?(?:화면|창)|신규\s*회원\s*등록창/u.test(text)) return { args: { featureId: members, view: 'register' } };
  if (/충전하기\s*화면|충전금\s*넣는\s*화면|충전\s*화면/u.test(text)) return { args: { featureId: credit, view: 'charge_topup', focus: 'action' } };
  if (/(?:외상|미수금).*(?:내역|목록)/u.test(text) && !query && !parseNavisPeriod(text)) return { args: { featureId: credit, view: 'receivable' } };
  if (/충전.*원거래|충전한\s*결제\s*내역/u.test(text) && target) return { args: { featureId: credit, view: 'charge', itemId: target.id }, target };
  if (moneyWords.test(text) && /열어|상세|화면/u.test(text) && target) return { args: { featureId: credit, itemId: target.id }, target };
  if (/회원.*(?:열어|상세)|정보\s*보여/u.test(text) && target) {
    if (!/회원/u.test(text) && snapshot.tables.staff.some(staff => !staff.archivedAt && query && sameName(staff.name, query))) return null;
    return { args: { featureId: members, view: 'list', itemId: target.id }, target };
  }
  const grade = gradeOf(text);
  if (grade && /만\s*(?:열어|보여|필터)/u.test(text)) return { args: { featureId: members, view: 'list', filter: { grade } } };
  if (readWords.test(text) && (moneyWords.test(text) || noteWords.test(text) || /회원|단골/u.test(text))) return null;
}

function routeMember(raw: string, snapshot: DataSnapshot, locale: Locale, allowMemberDelete: boolean): DomainRoute | undefined {
  const text = normalizeNavisInput(raw);
  if (/^(?:["'“‘])|하지\s*마|말아/u.test(text)) return;
  const link = bookingLink(text);
  if (!link && bookingEdit.test(text)) return;
  const l = (ko: string, en: string, hans: string, hant: string) => localized(locale, ko, en, hans, hant);
  const featureRead = (featureId: typeof members | typeof credit, factKeys: string[], condition: QueryCondition = defaultCondition) =>
    ({ intent: { kind: 'read', featureId, condition }, factKeys }) satisfies DomainRoute;
  const read = (kind: 'member' | 'note' | 'staff', querySlot: string, query: string, browse = false) =>
    ({ intent: { kind: 'read', recordKind: kind, querySlot }, slots: { [querySlot]: query }, browse }) satisfies DomainRoute;
  const clarify = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined) =>
    ({ kind: 'clarification', field, answer, resume }) satisfies DomainRoute;
  const missing = l('회원을 찾지 못했어요', 'Member not found', '未找到会员', '未找到會員');
  const targetQuestion = l('어느 회원인가요?', 'Which member?', '是哪位会员？', '是哪位會員？');
  const phoneQuestion = l('연락처를 알려 주세요', 'Enter the phone number', '请输入联系电话', '請輸入聯絡電話');
  const noteQuestion = l('메모에 무엇을 적을까요?', 'What should the note say?', '要写什么备注？', '要寫什麼備註？');
  const refuse = (reason: 'widget_only' | 'invalid_target' | 'duplicate', answer: string, alternative?: { featureId: string; command?: string; draft?: Record<string, unknown> }) =>
    ({ kind: 'refusal', reason, answer, alternative }) satisfies DomainRoute;
  const answer = (copy: string) => ({ kind: 'answer', answer: copy }) satisfies DomainRoute;
  const query = personMention(snapshot, text, locale);
  const matches = query ? memberMatches(snapshot, query, locale) : [];
  const member = matches.length === 1 ? matches[0] : undefined;
  const memberRead = (scope: string) => query ? read('member', scope, query) : clarify('member', targetQuestion, next => read('member', scope, next));
  const grade = gradeOf(text);
  if (/^(?:발주|공급처|세무|세금|가계부|재고|근무|일정|쿠폰)\s/u.test(text)
    && !member && !/회원|손님/u.test(text)) return;
  const nav = memberNavigation(text, snapshot, locale);
  if (nav) return;
  const membersScreen = l('회원목록에서 진행해 주세요', 'Continue in Members', '请在会员列表操作', '請在會員列表操作');
  const creditScreen = l('충전금·외상 관리에서 진행해 주세요', 'Continue in Credit and Receivables', '请在预付款与应收款页面操作', '請在預付款與應收款頁面操作');
  const askTarget = () => clarify('member', targetQuestion, next => routeMember(`${next} ${raw}`, snapshot, locale, allowMemberDelete));
  function proposal(command: MemberCommandType, args: AgentWireArgs, slots: LocalSlots, noteQuery?: string): DomainRoute {
    const creating = command === 'members.create';
    return { intent: { kind: 'command', command, args }, slots: { ...slots, memberQuery: creating ? slots.phone : query,
      ...(noteQuery ? { noteQuery } : {}) },
    lookups: [
      { kind: 'member', querySlot: 'memberQuery', ...(!creating ? { bind: ['memberId'] } : {}) },
      ...(command === 'members.update' && slots.phone ? [{ kind: 'member' as const, querySlot: 'phone' }] : []),
      ...(noteQuery ? [{ kind: 'note' as const, querySlot: 'noteQuery', bind: ['noteId'] }] : []),
    ] };
  }
  function duplicate(phone: string, except?: string) {
    const hit = findPhoneMatch(snapshot.tables, phone, except);
    if (!hit) return;
    return refuse('duplicate', `${l('같은 연락처로 등록된 회원이 있어요', 'That phone number is already registered', '该号码已登记', '該號碼已登記')}\n${hit.name} · ${hit.phone}`,
      hit.memberId ? { featureId: members, command: 'members.review', draft: { memberId: hit.memberId } } : { featureId: members });
  }

  // Memo content remains an opaque local slot. Its words never select another action.
  if (noteWords.test(text) || /주차.*손님.*누구/u.test(text)) {
    if (/주차/u.test(text) && /찾아|누구|사람/u.test(text) && !deleteWords.test(text) && !changeWords.test(text)) return read('note', 'noteQuery', JSON.stringify({ body: '주차' }), true);
    if (!query) return /회원|손님/u.test(text) ? askTarget() : undefined;
    if (matches.length > 1) return clarify('memberDisambiguator',
      l('연락처 끝 4자리를 알려 주세요', 'Enter the last four digits', '请输入号码后四位', '請輸入號碼末四碼'),
      next => /^\d{4}$/u.test(next.trim()) ? routeMember(`${next} 회원 ${raw}`, snapshot, locale, allowMemberDelete) : undefined);
    const all = JSON.stringify({ owner: query });
    const marker = /(?:메모(?:에)?|특이사항)\s*[:：]?\s*/u.exec(raw);
    const remainder = marker ? raw.slice(marker.index + marker[0].length).trim() : '';
    const quoted = /[“"‘']([\s\S]+?)[”"’']/u.exec(remainder)?.[1];
    const adding = /추가|남겨|남길|적어|입력|메모\s*[:：]/u.test(text);
    const removing = deleteWords.test(text) && !adding;
    const editing = changeWords.test(text) && !adding;
    if (!adding && !removing && !editing && readWords.test(text)) return read('note', 'noteQuery', all, true);
    if (matches.length === 0) return refuse('invalid_target', missing);
    const byOwner = member?.notes ?? [];
    if (adding || !editing && !removing) {
      const body = quoted ?? remainder.replace(/^(?:추가(?:해\s*줘)?|남겨\s*줘)\s*/u, '')
        .replace(/\s*(?:라고\s*)?(?:추가해\s*줘|남겨\s*줘|적어\s*(?:놔|줘)|입력해\s*줘)[.!]?$/u, '').trim();
      if (!textField(body) || /(?:1[,.]?001\s*자|^남길래$|^추가$)/u.test(body)) return clarify('body',
        body.length > 1000 || /1[,.]?001/u.test(body) ? l('메모는 1,000자까지 적을 수 있어요', 'Notes can have up to 1,000 characters', '备注最多 1,000 字', '備註最多 1,000 字') : noteQuestion,
        next => textField(next) ? proposal('members.addNote', { body: slot('memo') }, { memo: next }) : undefined);
      return proposal('members.addNote', { body: slot('memo') }, { memo: body });
    }
    const named = byOwner.find(note => text.includes(normalizeNavisInput(noteText(note, locale))));
    if (!named && /샷\s*연하게/u.test(text)) return refuse('invalid_target', l('해당 메모가 없어요', 'Note not found', '未找到该备注', '未找到該備註'));
    if (!byOwner.length && member) return answer(l('등록된 메모가 없어요', 'No notes', '没有备注', '沒有備註'));
    if (!named && byOwner.length > 1) return clarify('noteId', l('어느 메모인가요?', 'Which note?', '是哪条备注？', '是哪條備註？'),
      next => routeMember(`${raw} ${next}`, snapshot, locale, allowMemberDelete));
    const selected = JSON.stringify({ owner: query, ...(named ? { body: noteText(named, locale) } : {}) });
    if (removing) return proposal('members.deleteNote', {}, {}, selected);
    const body = /\s*(?:->|→)\s*([\s\S]+)$/u.exec(remainder)?.[1]
      ?? /(?:을|를)\s*([\s\S]+?)(?:으로|로)\s*(?:바꿔|고쳐|수정)/u.exec(remainder)?.[1]
      ?? /(?:수정|고쳐\s*줘)\s+(.+?)(?:으로|로)?$/u.exec(remainder)?.[1];
    const update = (memo: string) => proposal('members.updateNote', { body: slot('memo') }, { memo }, selected);
    return textField(body) ? update(body) : clarify('body', noteQuestion, next => textField(next) ? update(next) : undefined);
  }

  if (passes.test(text) && passAction.test(text)) {
    const command = /취소/u.test(text) ? 'memberships.cancelUse' : /팔아|판매|결제/u.test(text) ? 'memberships.sale' : 'memberships.useOnce';
    return refuse('widget_only', membersScreen, member ? { featureId: members, command, draft: { memberId: member.memberId } } : { featureId: members });
  }
  if (moneyWords.test(text)) {
    const charge = /충전|선결제/u.test(text) && !/외상|미수금/u.test(text);
    const amount = navisMoneySpans(text)[0]?.value ?? (/(?:충전금?|외상|미수금)\s*(\d+)(?!\d)/u.exec(text)?.[1] ? Number(/(?:충전금?|외상|미수금)\s*(\d+)/u.exec(text)?.[1]) : undefined);
    if (refundWords.test(text)) {
      return refuse('widget_only', creditScreen, member && positiveAmount(amount)
        ? { featureId: credit, command: 'ui.openSettlement', draft: { purpose: 'refund', memberId: member.memberId, amount } }
        : { featureId: credit });
    }
    if (/결제\s*(?:해|진행|처리)/u.test(text)) {
      return refuse('widget_only', l('주문·결제에서 진행해 주세요', 'Continue in Orders and Payments', '请在订单和付款页面操作', '請在訂單和付款頁面操作'),
        { featureId: 'pos', command: 'pos.payment', draft: {
          ...(member ? { memberId: member.memberId } : {}), ...(positiveAmount(amount) ? { amount } : {}),
        } });
    }
    const collection = /받았|받음|갚았|갚음|수금(?:했|해|할|\s*$)/u.test(text);
    const transact = charge ? /충전해|충전\s*(?:좀|ㄱ|\d|영원)|넣어|충전금?\s*\d|충전\s*$/.test(text) || amount !== undefined && !readWords.test(text) : collection;
    if (/유효기간|언제까지|기한/u.test(text)) return answer(l('충전금은 유효기간이 없어요', 'Prepaid credit has no expiry', '预付款没有有效期限制', '預付款沒有有效期限制'));
    if (/감사|쿠폰/u.test(text)) return featureRead(credit, ['account.charge.total', 'account.charge.rank']);
    if (charge && oldVisitors.test(text)) return featureRead(credit, ['account.charge.inactive']);
    if (transact) {
      if (!query) return askTarget();
      if (matches.length > 1) return clarify('memberDisambiguator', l('연락처 끝 4자리를 알려 주세요', 'Enter the last four digits', '请输入号码后四位', '請輸入號碼末四碼'),
        next => routeMember(`${next} 회원 ${charge ? '충전' : '외상 수금해줘'} ${amount ?? ''}`, snapshot, locale, allowMemberDelete));
      if (!member) return refuse('invalid_target', missing, { featureId: members });
      const view = accounts(snapshot);
      const balance = view.status === 'ready' ? view.model.members.find(row => row.memberId === member.memberId)?.receivableBalance : undefined;
      if (!charge && balance === 0) return refuse('invalid_target', l('남은 외상이 없어요', 'No receivables remain', '没有剩余应收款', '沒有剩餘應收款'), { featureId: credit });
      if (!positiveAmount(amount) || !charge && balance !== undefined && amount > balance) {
        const maximum = !charge && balance !== undefined && positiveAmount(amount) && amount > balance
          ? `${l('남은 외상', 'Receivables remaining', '剩余应收款', '剩餘應收款')} ${tr(locale).format.money(balance, 'full')}\n` : '';
        return clarify('amount', maximum + l('얼마를 입력할까요?', 'Enter an amount', '要输入多少金额？', '要輸入多少金額？'),
          next => routeMember(`${member.memberId} 회원 ${charge ? '충전해줘' : '외상 수금해줘'} ${/원/u.test(next) ? next : `${next}원`}`, snapshot, locale, allowMemberDelete));
      }
      return refuse('widget_only', creditScreen, { featureId: credit, command: 'ui.openSettlement',
        draft: { purpose: charge ? 'charge_topup' : 'receivable_collection', memberId: member.memberId, amount } });
    }
    const period = parseNavisPeriod(text);
    if (period) return featureRead(credit, [/외상|미수금/u.test(text) ? 'account.period.collection' : 'account.period.topup'], { kind: 'dateRange', ...period });
    if (charge && /제일|순위|가장/u.test(text)) return featureRead(credit, ['account.charge.members', 'account.charge.rank']);
    if (query) return memberRead(charge ? /내역|기록|쓴/u.test(text) ? 'chargeHistory' : 'charge' : 'receivable');
    return featureRead(credit, charge ? ['account.charge.total', 'account.charge.members'] :
      /누구|사람|손님/u.test(text) ? ['account.receivable.members', 'account.receivable.holder'] : ['account.receivable.total', 'account.receivable.members']);
  }

  if (passes.test(text)) {
    if (/끝나|만료/u.test(text)) return featureRead(members, ['memberships.endingThisWeek.count', 'memberships.endingThisWeek.member']);
    if (/몇/u.test(text)) return featureRead(members, ['memberships.active.count']);
  }
  if (/동의/u.test(text)) {
    if (changeWords.test(text) || /체크해/u.test(text)) return refuse('widget_only', membersScreen,
      member ? { featureId: members, command: 'members.setConsent', draft: { memberId: member.memberId } } : { featureId: members });
    if (query) return memberRead('consent');
  }
  if (/방문/u.test(text) && /추가|고쳐|넣어/u.test(text) && (query || /방문\s*(?:기록|횟수)/u.test(text))) return refuse('widget_only', membersScreen, { featureId: members });
  if (/방문일|마지막.*왔|최근에.*언제/u.test(text)) return memberRead('lastVisit');
  if (/예약|회원이야\s*연결/u.test(text)) {
    const explicitMember = /회원/u.test(text);
    if (link || bookingCreation.test(text) && (explicitMember || member)) {
      if (!query || !matches.length) return clarify('memberId', targetQuestion);
      const memberLookup = { kind: 'member' as const, querySlot: 'memberQuery' };
      if (link) {
        const guest = /(?:^|\s)([가-힣○]{2,5})\s*예약/u.exec(text)?.[1] ?? /(?:^|\s)([가-힣][○]{1,4})/u.exec(text)?.[1];
        if (!guest) return clarify('reservationId', l('어느 예약인가요?', 'Which reservation?', '是哪条预约？', '是哪筆預約？'));
        return {
          intent: { kind: 'command', command: 'booking.update', args: { patch: {} }, querySlot: 'reservationId' },
          slots: { memberQuery: query, reservationId: JSON.stringify({ name: guest }) },
          lookups: [{ kind: 'reservation', querySlot: 'reservationId', bind: ['reservationId'] }, { ...memberLookup, bind: ['patch', 'memberId'] }],
        };
      }
      const anchor = snapshot.pos?.businessDate ?? TODAY;
      const date = parseNavisDate(text.replace(/담주/u, '다음 주').replace(/(다음 주\s+[월화수목금토일])(?=\s|$)/u, '$1요일'), anchor);
      const clock = parseNavisTime(text.replace(/저녁/u, '오후'));
      const quantity = parseNavisQuantity(text);
      const partySize = quantity?.unit === 'person' ? quantity.value : parseNavisNumber(/(\d+)\s*인/u.exec(text)?.[1] ?? '');
      const time = clock && !/오전|오후|저녁|:/u.test(text) && Number(clock.slice(0, 2)) < 9 ? `${Number(clock.slice(0, 2)) + 12}${clock.slice(2)}` : clock;
      const field = !date || date < anchor ? 'date' : !time || slotHasPassed(date, time) ? 'time' : !partySize ? 'partySize' : undefined;
      if (field || !date || !time || !partySize) return clarify(field ?? 'date',
        l('예약 날짜, 시간, 인원을 확인해 주세요', 'Check the reservation date, time and party size', '请确认预约日期、时间和人数', '請確認預約日期、時間和人數'));
      const request = /요청(?:사항)?(?:은|에)?\s*[:：]?\s*(.+?)(?:\s*(?:적어\s*줘|부탁해))?$/u.exec(text)?.[1];
      return {
        intent: { kind: 'command', command: 'booking.create', args: {
          date: slot('date'), time: slot('time'), partySize: slot('partySize'), tableChoice: 'auto', ...(request ? { request: slot('request') } : {}),
        } },
        slots: { memberQuery: query, date, time, partySize, ...(request ? { request } : {}) },
        lookups: [{ ...memberLookup, bind: ['memberId'] }],
      };
    }
    if (query && bookingRead.test(text)) return memberRead(/오늘/u.test(text) ? 'visitsToday' : 'reservations');
    return;
  }

  if ((/회원.*(?:등록|추가|넣어)|(?:등록|추가).*회원|신규.*(?:손님|추가)|새\s*(?:회원|손님)|\+82/u.test(text)
    || /(?:^|\s)82[\s.-]*1[\d .-]+\s*추가/u.test(text)) && !/(?:몇\s*명|등록\s*수|언제)/u.test(text)) {
    const name = query;
    const phone = extractPhone(text);
    const create = (value: string) => {
      const normalized = normalizeMemberPhone(value);
      if (!normalized || !name) return clarify('phone', phoneQuestion, create);
      const existing = duplicate(normalized);
      if (existing) return existing;
      const draft = () => proposal('members.create', { name: slot('name'), phone: slot('phone') }, { name, phone: normalized });
      return memberMatches(snapshot, name, locale).length ? clarify('confirmSameName',
        l('같은 이름의 회원이 있어요. 다른 분인가요?', 'Is this a different person with the same name?', '是同名的另一位会员吗？', '是同名的另一位會員嗎？'),
        next => /^(?:다른\s*분|네|예|맞아)/u.test(next) ? draft() : undefined) : draft();
    };
    return !name ? askTarget() : phone ? create(phone) : clarify('phone', phoneQuestion, create);
  }
  const candidatePhone = extractPhone(text);
  if (query && (/(?:이름|번호|연락처)/u.test(text) || candidatePhone && changeWords.test(text)) &&
    (changeWords.test(text) || candidatePhone || /그대로\s*저장/u.test(text))) {
    if (!matches.length) return refuse('invalid_target', missing, { featureId: members });
    const name = /이름(?:을|은|이)?\s*(?:오타야\s*)?([\p{L}○]{2,40}?)(?=\s*(?:으로|로|번호|$))/u.exec(text)?.[1]
      ?? /\s([가-힣]{2,4})\s+(?=0\d)/u.exec(text)?.[1];
    const phone = candidatePhone;
    const keptSuffix = /(?:연락처|번호)\s*(\d{4})\s*그대로/u.exec(text)?.[1];
    if (!phone && keptSuffix && member?.phone.endsWith(keptSuffix)) return answer(l('이미 같은 정보예요', 'The information is unchanged', '资料相同', '資料相同'));
    const update = (values: { name?: string; phone?: string }): DomainRoute => {
      if (values.phone && member) {
        const hit = duplicate(values.phone, member.customerId);
        if (hit) return hit;
      }
      const customer = member && customerOf(snapshot, member);
      if (member && (!values.name || values.name === customer?.name) && (!values.phone || values.phone === customer?.phone)) return answer(l('이미 같은 정보예요', 'The information is unchanged', '资料相同', '資料相同'));
      const { name, phone } = values;
      return proposal('members.update', { ...(name ? { name: slot('name') } : {}), ...(phone ? { phone: slot('phone') } : {}) }, values);
    };
    if (phone || name) return update({ ...(name ? { name } : {}), ...(phone ? { phone } : {}) });
    if (/연락처|번호/u.test(text)) return clarify('phone', phoneQuestion, next => {
      const number = normalizeMemberPhone(next);
      return number ? update({ phone: number }) : undefined;
    });
    return clarify('name', l('새 이름을 알려 주세요', 'Enter the new name', '请输入新姓名', '請輸入新姓名'),
      next => textField(next) ? update({ name: next }) : undefined);
  }
  if (/(?:회원|손님)/u.test(text) && deleteWords.test(text)) {
    if (/모두|전부|전체|한꺼번에|한\s*번에|싹|(?:^|\s)다\s|두\s*명|[2-9]\d*\s*명|둘\s*다/u.test(text) ||
      text.split(/(?:이랑|하고|[과와랑])\s+|[,·]\s*/u).filter(part => personMention(snapshot, part, locale)).length > 1) return refuse('widget_only',
      l('회원은 한 명씩 확인해 주세요', 'Check members one at a time', '请逐一核对会员', '請逐一核對會員'), { featureId: members });
    if (!query) return askTarget();
    if (!matches.length) return refuse('invalid_target', missing);
    if (member) {
      const blockers = selectMemberDeleteBlockers(snapshot, member.memberId);
      if (blockers.blocked) {
        const money = (value: number) => tr(locale).format.money(value, 'full');
        const values = [
          blockers.charge > 0 ? `${l('충전금', 'Prepaid balance', '预付款', '預付款')} ${money(blockers.charge)}` : '',
          blockers.receivable > 0 ? `${l('외상', 'Receivables', '应收款', '應收款')} ${money(blockers.receivable)}` : '',
          blockers.passes > 0 ? `${l('이용 중 회원권', 'Active passes', '有效会员券', '有效會員券')} ${tr(locale).format.number(blockers.passes)}` : '',
        ].filter(Boolean);
        return refuse('invalid_target', [...values, l('먼저 정리해 주세요', 'Clear these first', '请先结清', '請先結清')].join('\n'),
          { featureId: members, command: 'members.review', draft: { memberId: member.memberId } });
      }
    }
    return allowMemberDelete ? proposal('members.delete', {}, {}) : refuse('widget_only', membersScreen, { featureId: members });
  }
  if (/등급|단골|자주\s*방문|VIP/iu.test(text)) {
    if (/기준|어떻게\s*정해|몇\s*번/u.test(text)) return answer(l('최근 28일 방문으로 정해요\n4일 이상 단골\n2~3일 자주 방문\n1일 또는 방문 이력 없음은 가끔 방문\n최근 방문이 없으면 오랜 기간 미방문',
      'Grades use the last 28 days\n4+ days: Regular\n2–3 days: Frequent\n1 day or no history: Occasional\nNo recent visit: Inactive',
      '按最近 28 天到访天数分级\n4 天以上为常客\n2–3 天为经常到访\n1 天或无到访记录为偶尔到访\n近期未到访为长期未到访',
      '按最近 28 天到訪天數分級\n4 天以上為常客\n2–3 天為經常到訪\n1 天或無到訪記錄為偶爾到訪\n近期未到訪為長期未到訪'));
    if (/올려|정해|처리|지정|고정|바꿔|수정|돌려|풀어|정할래|로\s*해|VIP/u.test(text)) {
      if (!query) return askTarget();
      if (!matches.length) return refuse('invalid_target', missing);
      const desired = /자동|풀어/u.test(text) ? null : grade;
      const setGrade = (selected: MemberGrade | null) => proposal('members.setGrade', { grade: selected }, {});
      if (desired === undefined) return clarify('grade', l('어떤 등급으로 할까요?', 'Which grade?', '设为哪个等级？', '設為哪個等級？'),
        next => { const choice = gradeOf(next); return choice ? setGrade(choice) : undefined; });
      if (member && member.gradeOverride === desired) return answer(l('이미 같은 등급이에요', 'The grade is unchanged', '等级相同', '等級相同'));
      if (member && desired === member.grade && !member.manuallyGraded) return clarify('confirmPin',
        l('현재 등급을 직접 정함으로 둘까요?', 'Set this grade manually?', '要手动固定当前等级吗？', '要手動固定目前等級嗎？'),
        next => /^(?:네|예|맞아|고정)/u.test(next) ? setGrade(desired) : undefined);
      return setGrade(desired);
    }
    if (/분포|등급별|각각/u.test(text)) return featureRead(members, grades.map(grade => `members.${grade}.count`));
    if (grade && /몇|수\s*알려/u.test(text)) return featureRead(members, [`members.${grade}.count`]);
  }
  if (oldVisitors.test(text) && /몇|수/u.test(text)) return featureRead(members, ['members.inactive.count']);
  if (query && /(?:연락처|전화번호|번호).*(?:알려|뭐|전체)/u.test(text)) return refuse('widget_only',
    `${l('전체 연락처는 가려요', 'Full phone numbers are hidden', '完整号码已隐藏', '完整號碼已隱藏')}${member?.phone ? `\n${member.phone}` : ''}`,
    member ? { featureId: members, command: 'members.review', draft: { memberId: member.memberId } } : { featureId: members });
  if (query && /회원|손님|정보|알려|어떻게\s*돼|확인/u.test(text)) {
    if (!/회원|손님/u.test(text) && matches.length && snapshot.tables.staff.some(staff => !staff.archivedAt && sameName(staff.name, query))) {
      return clarify('recordKind', l('회원과 직원 중 누구인가요?', 'Member or staff?', '是会员还是员工？', '是會員還是員工？'),
        next => /회원/u.test(next) ? memberRead('memberQuery') : /직원/u.test(next) ? read('staff', 'name', query) : undefined);
    }
    if (matches.length || /회원/u.test(text)) return memberRead('memberQuery');
  }
  if (/회원.*(?:몇\s*명|전체|총원)/u.test(text)) return featureRead(members, ['members.count']);
}

function extractPhone(text: string) {
  const digits = /(?<!\d)(?:(?:\+?82[\s.-]*[01])|0)[\d\s.-]{8,17}(?=\D|$)/u.exec(text)?.[0];
  const words = /[공영][공영일이삼사오육칠팔구\s-]{9,19}/u.exec(text)?.[0];
  return normalizeMemberPhone(digits ?? words ?? '');
}

export function createMembersDomain({ allowMemberDelete = false }: { readonly allowMemberDelete?: boolean } = {}) {
  return {
    featureIds: [members, credit],
    commands: memberCommands.filter(command => command !== 'members.delete' || allowMemberDelete).map(memberAdapter),
    reads: [memberReader, noteReader],
    projectWidget: projectMembers,
    navigation: memberNavigation,
    routePresentation(text, snapshot, locale) {
      const memo = noteWords.test(text) && !/공급처|발주사|재고\s*품목|상품\s*메모|예약\s*메모/u.test(text);
      const grade = /등급|단골|VIP/iu.test(text) && /올려|정해|처리|지정|고정|바꿔|수정|돌려|풀어|정할래|로\s*해|VIP/u.test(text);
      if (moneyWords.test(text) && refundWords.test(text) || passes.test(text) && passAction.test(text)
        || bookingLink(text)
        || bookingRead.test(text) && (/회원/u.test(text) || memberMention(snapshot, text, locale))
        || bookingCreation.test(text) && (/회원/u.test(text) || personMention(snapshot, text, locale))
        || /회원|손님/u.test(text) && deleteWords.test(text)
        || (memo || grade) && personMention(snapshot, text, locale)) {
        return routeMember(text, snapshot, locale, allowMemberDelete);
      }
    },
    route(text, snapshot, locale, run) {
      // The legacy contextless regular-count call returns a member widget candidate.
      if (!run && /^단골(?:손님)?\s*(?:몇\s*명|수\s*알려)/u.test(text)) return;
      return routeMember(text, snapshot, locale, allowMemberDelete);
    },
    handoff(command, fields) {
      if (command === 'ui.openSettlement' && validateAgentPrefill(credit, fields) && stringValue(fields.memberId) && stringValue(fields.purpose)) {
        if (fields.purpose === 'refund') return { featureId: credit, view: 'charge', itemId: fields.memberId };
        return { featureId: credit, view: fields.purpose, itemId: fields.memberId, focus: 'action', prefill: { kind: 'widget-draft', command, fields } };
      }
      if ((command === 'memberships.useOnce' || command === 'memberships.cancelUse' || command === 'members.setConsent' || command === 'members.review' || command === 'memberships.sale')
        && stringValue(fields.memberId)) return { featureId: members, view: command.startsWith('memberships.') ? 'memberships' : 'list', itemId: fields.memberId };
    },
  } satisfies DomainAdapter;
}

export const membersDomain = createMembersDomain({ allowMemberDelete: true });
