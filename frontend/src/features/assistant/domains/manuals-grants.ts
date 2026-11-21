import type { DetailRef, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import { LEGACY_GRANT_EVALUATION_NOW, TODAY, dateOf, daysBetween, timeOf } from '../../../data/db/time';
import { normalizeCondition, resolveDataText, selectMenus, selectWidget, type DataCommand, type DataSnapshot, type ManualRow } from '../../../data/widget-data';
import { createTranslator, type MessageBundle, type Translator } from '../../../i18n';
import { mgmtMoneyBundle } from '../../widgets/mgmt-money/messages';
import { mgmtStoreBundle } from '../../widgets/mgmt-store/messages';
import { navisTranslator } from '../messages';
import {
  validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill,
  type AgentFact, type AgentMissingStatus, type AgentRecordKind, type AgentRecordMatch, type AgentWireArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { menuAgentDomain } from './menu';
import { normalizeNavisInput, normalizeNavisName, resolveNavisName } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets } from './registry';

const defaultCondition = { kind: 'default' } as const;
const manuals = 'manuals';
const grants = 'grants';
const statuses = ['applied', 'reviewing', 'selected', 'rejected', 'completed'] as const;
const commandNames = [
  'manuals.create', 'manuals.update', 'manuals.delete', 'manuals.toggleStep',
  'manuals.setPublished', // D-326 Q3: unpublish one published manual, extra confirmation, the receipt undo republishes
  'manuals.createDraftFromMemo', 'manuals.saveDraft', 'manuals.discardDraft',
  'grants.apply', 'grants.updateApplication', 'grants.deleteApplication', 'grants.markReviewed',
] as const;
type CommandName = typeof commandNames[number];
type Command = Extract<DataCommand, { type: CommandName }>;
type ManualStepInput = NonNullable<Extract<Command, { type: 'manuals.create' }>['steps']>[number];
type RecordKind = Extract<AgentRecordKind, 'manual' | 'manualDraft' | 'grantNotice' | 'grantApplication'>;

const translators = new Map<Locale, Translator>();
function tr(locale: Locale) {
  let translator = translators.get(locale);
  if (!translator) {
    const base = navisTranslator(locale);
    const widgets = createTranslator(locale, ...([mgmtStoreBundle, mgmtMoneyBundle] as unknown as MessageBundle<string>[]));
    translator = { ...base, has: key => widgets.has(key) || base.has(key),
      t: (key, params) => widgets.has(key) ? widgets.t(key, params) : base.t(key, params) };
    translators.set(locale, translator);
  }
  return translator;
}
const str = (value: unknown): value is string => typeof value === 'string';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const slot = (key: string) => ({ slot: key });
const manualModel = (snapshot: DataSnapshot) => {
  const view = selectWidget(snapshot, manuals, defaultCondition, 'normal');
  return view.status === 'ready' ? view.model : undefined;
};
const manualRows = (snapshot: DataSnapshot) => {
  const model = manualModel(snapshot);
  return model ? [...model.manuals, ...model.storeInfo] : [];
};
const manualTitle = (row: ManualRow, locale: Locale) => resolveDataText(tr(locale).t, row.title);
const noticeTitle = (snapshot: DataSnapshot, noticeId: string, locale: Locale) => {
  const notice = snapshot.tables.grantNotice.find(row => row.noticeId === noticeId);
  return notice ? tr(locale).t(notice.titleKey) : '';
};
const grantStatus = (locale: Locale, status: typeof statuses[number]) => tr(locale).t(`widget.grants.${status}`);
const isReviewed = (snapshot: DataSnapshot, noticeId: string) =>
  snapshot.tables.grantReview.some(row => row.noticeId === noticeId && row.reviewStatus === 'reviewed');
const isApplied = (snapshot: DataSnapshot, noticeId: string) =>
  snapshot.tables.grantApplication.some(row => row.noticeId === noticeId);
const canApply = (notice: DataSnapshot['tables']['grantNotice'][number]) =>
  notice.applyStart <= LEGACY_GRANT_EVALUATION_NOW && LEGACY_GRANT_EVALUATION_NOW <= notice.applyEnd;

interface SearchRow {
  readonly id: string;
  readonly label: string;
  readonly fields: NonNullable<AgentRecordMatch['fields']>;
}

function recordRows(kind: RecordKind, snapshot: DataSnapshot, locale: Locale): SearchRow[] {
  const { tables } = snapshot;
  if (kind === 'manual') return manualRows(snapshot).map(row => ({
    id: row.manualId, label: manualTitle(row, locale),
    fields: { section: row.section, checklist: row.checklist, published: true, stepNumbers: row.steps.map(step => step.stepNo),
      checkedSteps: row.steps.filter(step => step.checkedToday).map(step => step.stepNo) },
  }));
  if (kind === 'manualDraft') return tables.manualDraft.filter(row => row.status === 'draft').map(row => ({
    id: row.draftId, label: resolveDataText(tr(locale).t, row.title), fields: { section: row.section ?? 'handover' },
  }));
  if (kind === 'grantNotice') return tables.grantNotice.map(notice => ({
    id: notice.noticeId, label: tr(locale).t(notice.titleKey), fields: {
      date: dateOf(notice.applyEnd), canApply: canApply(notice), reviewed: isReviewed(snapshot, notice.noticeId), applied: isApplied(snapshot, notice.noticeId),
    },
  }));
  return tables.grantApplication.map(row => ({
    id: row.applicationId, label: noticeTitle(snapshot, row.noticeId, locale), fields: { date: row.appliedOn, status: row.status },
  }));
}

function matchesFor(kind: RecordKind, { snapshot, locale, query }: RecordSearch) {
  const rows = recordRows(kind, snapshot, locale);
  const byId = rows.find(row => row.id === query);
  const byName = resolveNavisName(query, rows, row => row.label);
  const selected = byId ? [byId] : byName.matches;
  return selected.map(row => ({ row, handle: `${kind}-${rows.indexOf(row) + 1}`,
    match: byId || normalizeNavisName(query) === normalizeNavisName(row.label) ? 'exact' as const : 'similar' as const }));
}

function reader(kind: RecordKind): RecordAdapter {
  return {
    kind,
    search(input) {
      return matchesFor(kind, input).map(({ row, handle, match }) => ({
        handle, match, fields: row.fields,
        ...(!input.privateLookup && row.label ? { label: row.label.slice(0, 180) } : {}),
      }));
    },
    resolve(input, handle) {
      return matchesFor(kind, input).find(row => row.handle === handle)?.row.id;
    },
  };
}

function expand(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, slots, targets));
  if (!object(value)) return value;
  if (str(value.slot)) return slots[value.slot];
  if (str(value.handle)) return targets.get(value.handle)?.id;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, slots, targets)]));
}

function commandAdapter(type: CommandName): CommandAdapter<Command, { args: Record<string, unknown>; locale: Locale }> {
  return {
    command: type,
    featureId: type.startsWith('manuals.') ? manuals : grants,
    slots: { name: str, title: str, memo: str, cautions: str, resultMemo: value => value === null || str(value), steps: Array.isArray, stepNo: value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 },
    resolve(wire, slots, snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const args = expand(wire, slots, targets);
      if (!object(args) || !validateAgentCommandArgs(type, args)) return;
      if (type === 'manuals.toggleStep' && typeof args.checked !== 'boolean') return;
      // D-326 Q3: chat only takes a manual down. Publishing again is the receipt undo or the widget.
      if (type === 'manuals.setPublished' && args.published !== false) return;
      if (args.manualId && !manualRows(snapshot).some(row => row.manualId === args.manualId)) return;
      if (args.draftId && !snapshot.tables.manualDraft.some(row => row.draftId === args.draftId && row.status === 'draft')) return;
      const locale = slots.navisLocale;
      return { args, locale: locale === 'en' || locale === 'zh-Hans' || locale === 'zh-Hant' ? locale : 'ko' };
    },
    preflight({ args, locale }, { snapshot, proposalId, idempotencyKey }) {
      const t = tr(locale).t;
      const command = { ...args, type, ...(type === 'manuals.create' || type === 'manuals.createDraftFromMemo' || type === 'manuals.setPublished' || type === 'grants.apply' ? { idempotencyKey } : {}) } as Command;
      const manual = 'manualId' in command ? manualRows(snapshot).find(row => row.manualId === command.manualId) : undefined;
      const draft = 'draftId' in command ? snapshot.tables.manualDraft.find(row => row.draftId === command.draftId) : undefined;
      const application = 'applicationId' in command ? snapshot.tables.grantApplication.find(row => row.applicationId === command.applicationId) : undefined;
      const noticeId = 'noticeId' in command ? command.noticeId : application?.noticeId;
      if (command.type === 'grants.updateApplication' && application &&
        (command.status === undefined || command.status === application.status)
        && (command.resultMemo === undefined || (command.resultMemo ?? '') === resolveDataText(t, application.resultMemo))) {
        return { kind: 'unchanged' };
      }
      const context = { snapshot, tables: snapshot.tables, nextId: (prefix: string) => `${prefix}-navis-preview-${proposalId}` };
      const handler = handlers[type] as (input: typeof context, command: Command) => ReturnType<typeof handlers['manuals.create']>;
      const result = handler(context, command);
      if (!result.ok) return { kind: result.code === 'CONFLICT' ? 'conflict' : 'invalid', field: result.field, messageKey: result.messageKey };
      if (result.tables === snapshot.tables) return { kind: 'unchanged' };
      const after = { ...snapshot, tables: result.tables };
      const addedManual = result.tables.manual.find(row => !snapshot.tables.manual.some(before => before.manualId === row.manualId));
      const updatedManual = manualRows(after).find(row => row.manualId === (manual?.manualId ?? addedManual?.manualId));
      const createdDraft = result.tables.manualDraft.find(row => !snapshot.tables.manualDraft.some(before => before.draftId === row.draftId));
      const nextApplication = result.tables.grantApplication.find(row => application ? row.applicationId === application.applicationId : row.noticeId === noticeId);
      const noValue = t('common.navis.agent.none');
      const fields: { label: string; before: string; after: string }[] = [];
      const field = (label: string, previous?: string, next?: string) => {
        if ((previous || noValue) !== (next || noValue)) fields.push({ label, before: previous || noValue, after: next || noValue });
      };
      if (command.type === 'manuals.toggleStep') {
        const step = manual?.steps.find(row => row.stepNo === command.stepNo);
        if (step) {
          const done = t('common.done');
          const pending = { ko: '미완료', en: 'Incomplete', 'zh-Hans': '未完成', 'zh-Hant': '未完成' }[locale];
          field(resolveDataText(t, step.body), command.checked ? pending : done, command.checked ? done : pending);
        }
      } else if (createdDraft) {
        field(t('common.draft'), undefined, createdDraft.steps.map(step => resolveDataText(t, step)).join('\n'));
      } else if (command.type === 'manuals.discardDraft') {
        field(t('common.draft'), draft && resolveDataText(t, draft.title));
      } else if (command.type === 'manuals.setPublished') {
        const label = { ko: '게시', en: 'Published', 'zh-Hans': '发布', 'zh-Hant': '發布' }[locale];
        field(label, { ko: '게시 중', en: 'Published', 'zh-Hans': '已发布', 'zh-Hant': '已發布' }[locale],
          { ko: '게시 안 함', en: 'Not published', 'zh-Hans': '未发布', 'zh-Hant': '未發布' }[locale]);
      } else if (manual || updatedManual) {
        field(t('widget.manuals.draftTitle'), manual && manualTitle(manual, locale), updatedManual && manualTitle(updatedManual, locale));
        field(t('widget.manuals.category'), manual && t(manual.categoryKey), updatedManual && t(updatedManual.categoryKey));
        field(t('widget.manuals.procedures'), manual?.steps.map(step => resolveDataText(t, step.body)).join('\n'),
          updatedManual?.steps.map(step => resolveDataText(t, step.body)).join('\n'));
        field(t('widget.manuals.cautions'), manual && resolveDataText(t, manual.cautions), updatedManual && resolveDataText(t, updatedManual.cautions));
      } else if (command.type === 'grants.markReviewed') {
        field(t('widget.grants.notices'), t('common.navis.agent.none'), t('common.badge.reviewed'));
      } else {
        field(t('widget.grants.applicationStatus'), application && grantStatus(locale, application.status), nextApplication && grantStatus(locale, nextApplication.status));
        field(t('widget.grants.resultMemo'), application && resolveDataText(t, application.resultMemo), nextApplication && resolveDataText(t, nextApplication.resultMemo));
      }
      if (!fields.length) return { kind: 'unchanged' };
      const title = (() => {
        switch (command.type) {
          case 'manuals.createDraftFromMemo': return t('widget.manuals.makeDraft');
          case 'manuals.saveDraft': return t('widget.manuals.createDocument');
          case 'manuals.discardDraft': return t('common.draft');
          case 'manuals.delete': return t('widget.manuals.delete');
          case 'manuals.setPublished': return { ko: '매뉴얼 게시 취소', en: 'Unpublish manual', 'zh-Hans': '取消发布手册', 'zh-Hant': '取消發布手冊' }[locale];
          case 'grants.apply': return t('widget.grants.apply');
          case 'grants.deleteApplication': return t('widget.grants.delete');
          case 'grants.markReviewed': return t('common.markReviewed');
          default: return t(`widget.${type.split('.')[0]}.title`);
        }
      })();
      const target = manual ? manualTitle(manual, locale) : updatedManual ? manualTitle(updatedManual, locale)
        : createdDraft || draft ? resolveDataText(t, (createdDraft ?? draft)!.title) : noticeId ? noticeTitle(snapshot, noticeId, locale) : '';
      const removingStep = command.type === 'manuals.update' && manual && updatedManual && updatedManual.steps.length < manual.steps.length;
      return { kind: 'ready', command, preview: { title: target ? `${title} · ${target}` : title, target, fields },
        ...(removingStep || command.type === 'manuals.setPublished' ? { tier: 'extra-confirm' as const } : {}) };
    },
    undoToken: result => result.undoToken,
  };
}

function fact(key: string, label: string, value: AgentFact['value'], display = String(value), unit = '', source?: string): AgentFact {
  return { key, label: label.slice(0, 250), value: str(value) ? value.slice(0, 500) : value, display: display.slice(0, 500),
    unit, ...(source ? { source: source.slice(0, 100) } : {}) };
}
const manualKey = (row: ManualRow) => `manuals.${row.manualId}`;
const noticeKey = (noticeId: string) => `grants.notice.${noticeId}`;
const applicationKey = (applicationId: string) => `grants.application.${applicationId}`;

function projectFacts(snapshot: DataSnapshot, feature: string, condition: QueryCondition, locale: Locale):
  { facts: readonly AgentFact[] } | { status: AgentMissingStatus } | undefined {
  if (feature !== manuals && feature !== grants) return;
  if (!normalizeCondition(feature, condition).ok) return { status: 'unsupported_period' as const };
  const t = tr(locale).t, format = tr(locale).format;
  const none = t('common.navis.agent.none');
  const facts: AgentFact[] = [];
  if (feature === manuals) {
    const model = manualModel(snapshot);
    if (!model) return { status: 'unavailable' as const };
    facts.push(fact('manuals.published.count', t('widget.manuals.handover'), model.publishedCount, format.count(model.publishedCount, 'item'), 'count'));
    facts.push(fact('manuals.store-info.count', t('widget.manuals.storeInfo'), model.storeInfoCount, format.count(model.storeInfoCount, 'item'), 'count'));
    for (const manual of [...model.manuals, ...model.storeInfo]) {
      const title = manualTitle(manual, locale);
      const body = resolveDataText(t, manual.body);
      const cautions = resolveDataText(t, manual.cautions);
      const key = manualKey(manual);
      facts.push(fact(`${key}.category`, title, manual.category, t(manual.categoryKey), '', title));
      facts.push(fact(`${key}.updatedAt`, title, manual.updatedAt, format.date(dateOf(manual.updatedAt), 'short'), 'date', title));
      facts.push(fact(`${key}.cautions`, t('widget.manuals.cautions'), cautions, cautions || none, '', title));
      if (body) facts.push(fact(`${key}.section.body`, title, body, body, '', title));
      const hours = body.split('\n').find(line => /^영업\s*시간\s*:/u.test(line))?.replace(/^영업\s*시간\s*:\s*/u, '');
      if (hours) facts.push(fact(`${key}.section.hours`, title, hours, hours, '', title));
      for (const step of manual.steps) {
        const body = resolveDataText(t, step.body);
        if (!body || manual.section === 'store-info') continue;
        const keyStep = `${key}.step.${step.stepNo}`;
        facts.push(fact(keyStep, t('widget.manuals.stepCount', { n: step.stepNo }), body, body, '', title));
        if (manual.checklist) facts.push(fact(`${keyStep}.checked`, body, Number(step.checkedToday),
          t(step.checkedToday ? 'data.notice.stepChecked' : 'data.notice.stepUnchecked'), 'flag', title));
      }
      if (manual.checklist) {
        const done = manual.steps.filter(step => step.checkedToday).length;
        facts.push(fact(`${key}.checklist.progress`, title, done, t('widget.manuals.progressSentence', { done, total: manual.steps.length }), 'count', title));
      }
    }
  } else {
    const view = selectWidget(snapshot, grants, condition, 'normal');
    if (view.status !== 'ready') return { status: view.status === 'empty' ? 'missing' as const : 'unavailable' as const };
    const model = view.model;
    const source = t(model.sourceKey);
    facts.push(fact('grants.candidates.count', t('widget.grants.reviewCandidates'), model.candidateCount, format.count(model.candidateCount, 'count'), 'count', source));
    facts.push(fact('grants.inProgress.count', t('widget.grants.applications'), model.inProgressCount, format.count(model.inProgressCount, 'count'), 'count', source));
    const eligibility = {
      ko: '최종 자격은 공식 공고에서 확인해요.', en: 'Check final eligibility in the official notice.',
      'zh-Hans': '最终资格请以官方公告为准。', 'zh-Hant': '最終資格請以官方公告為準。',
    }[locale];
    facts.push(fact('grants.eligibility', t('widget.grants.draftCheck'), 'unverified', eligibility, '', source));
    for (const notice of snapshot.tables.grantNotice) {
      const key = noticeKey(notice.noticeId), title = t(notice.titleKey);
      const date = dateOf(notice.applyEnd);
      const formattedEnd = `${format.date(date, 'short')} ${format.time(timeOf(notice.applyEnd))}`;
      const days = daysBetween(TODAY, date);
      const deadline = days < 0 ? formattedEnd : `${formattedEnd} · ${t('widget.grants.daysLeft', { n: days })}`;
      facts.push(fact(`${key}.deadline`, title, notice.applyEnd, deadline, 'date', source));
      facts.push(fact(`${key}.detail`, title, t(notice.summaryKey), undefined, '', source));
      notice.conditionKeys.forEach((message, index) => {
        facts.push(fact(`${key}.condition.${index}`, title, t(message), undefined, '', source));
      });
      facts.push(fact(`${key}.agency`, title, t(notice.agencyKey), undefined, '', source));
      facts.push(fact(`${key}.region`, title, t(notice.regionKey), undefined, '', source));
      facts.push(fact(`${key}.review`, title, Number(isReviewed(snapshot, notice.noticeId)),
        t(isReviewed(snapshot, notice.noticeId) ? 'common.markReviewed' : 'common.navis.agent.none'), 'flag', source));
    }
    for (const application of model.applications) {
      const title = noticeTitle(snapshot, application.noticeId, locale) || t('widget.grants.applicationName');
      const key = applicationKey(application.applicationId);
      facts.push(fact(`${key}.status`, title, application.status, grantStatus(locale, application.status), '', source));
      facts.push(fact(`${key}.date`, title, application.appliedOn, format.date(application.appliedOn, 'short'), 'date', source));
      const memo = resolveDataText(t, application.resultMemo);
      if (memo) facts.push(fact(`${key}.memo`, title, memo, undefined, '', source));
    }
  }
  return { facts };
}

const manualWords = /매뉴얼|체크리스트|인수인계|매장\s*정보|오픈\s*(?:준비|체크)|manual|checklist|手[册冊]/iu;
const grantWords = /지원\s*(?:사업|금|공고|현황|자격|조건|받을|신청)|정부\s*지원|지원.*(?:신청|검토|선정)|신청서|스마트\s*상점|경영\s*안정|디지털\s*전환|(?:공식|지원)\s*공고|\bgrants?\b|政府扶持/iu;
const noAction = /^(?:["'“‘][^"'’”]+["'’”])\s*$|하지\s*마|말아\s*줘|지시\s*무시|ignore\s+(?:all|previous)|\b(?:don't|do not)\b/iu;
const open = /열(?:어|고)|띄워|상세\s*$|(?:탭|화면|목록).*?(?:가|이동)|보여\s*줘|볼래|\bopen\b/iu;
const remove = /지워|삭제|없애|버려|취소/u;
const edit = /바꿔|고쳐|변경|수정|옮겨|이동/u;
const numberedStep = /(\d+)\s*(?:번|단계)/u;
const multipleSteps = /\d+\s*(?:번|단계)?\s*[,·]\s*\d+|전부|모두|다\s*(?:끝|해제|체크)/u;
const otherFeatureRequest = /^(?:공지|휴무\s*공지)|배치|패널|위젯\s*(?:추가|지워|삭제)|대시보드|보드|페이지/u;
const compound = /알려주고|읽어주고|보여주고/u;
const readWords = /알려|뭐|어떤|얼마|몇|있어|어디|언제|어떻게|어디까지|얼마나/u;
const quote = /['"‘“]([^'"’”]+)['"’”]/u;
const tail = /(?:->|[:：]|\s-\s)(.+)$/u;
const answer = (value: string): DomainRoute => ({ kind: 'answer', answer: value });
const clarify = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute =>
  ({ kind: 'clarification', field, answer, ...(resume ? { resume } : {}) });
const refusal = (reason: 'unavailable' | 'unsupported' | 'widget_only' | 'invalid_target', answer?: string): DomainRoute =>
  ({ kind: 'refusal', reason, ...(answer ? { answer } : {}) });

function commandTurn(command: CommandName, args: AgentWireArgs, slots: LocalSlots = {},
  record?: { kind: RecordKind; id: string; field: string }): DomainTurnInput {
  const querySlot = record ? 'name' : command === 'manuals.create' ? 'title' : undefined;
  return {
    intent: { kind: 'command', command, args, ...(querySlot ? { querySlot } : {}) },
    slots: record ? { ...slots, name: record.id } : slots,
    ...(record ? { lookups: [{ kind: record.kind, querySlot: 'name', bind: [record.field] }] }
      : command === 'manuals.create' ? { lookups: [{ kind: 'manual', querySlot: 'title' }] } : {}),
  };
}

function readFacts(snapshot: DataSnapshot, feature: typeof manuals | typeof grants, locale: Locale,
  filter: (key: string) => boolean, onMissing?: DomainTurnInput['onMissing']): DomainTurnInput {
  const projection = projectFacts(snapshot, feature, defaultCondition, locale);
  const factKeys = projection && 'facts' in projection ? projection.facts.map(fact => fact.key).filter(filter) : [];
  return { intent: { kind: 'read', featureId: feature, condition: defaultCondition }, factKeys, onMissing };
}

function detail(featureId: typeof manuals | typeof grants, args: AgentWireArgs = {}, kind?: RecordKind, id?: string): DomainDetail {
  return { args: { featureId, ...args, ...(id ? { itemId: id } : {}) }, ...(kind && id ? { target: { kind, id }, querySlot: kind } : {}) };
}

function manualMention(rows: readonly ManualRow[], input: string, locale: Locale) {
  const text = normalizeNavisName(input);
  const exact = rows.filter(row => {
    const title = normalizeNavisName(manualTitle(row, locale));
    return title.length > 1 && text.includes(title);
  });
  if (exact.length) return exact;
  if (/오픈/u.test(input)) return rows.filter(row => row.checklist && row.category === 'opening');
  if (/마감/u.test(input)) return rows.filter(row => row.checklist && row.category === 'closing');
  if (/영업\s*시간/u.test(input)) return rows.filter(row => row.section === 'store-info' && /영업시간/u.test(normalizeNavisName(manualTitle(row, locale))));
  return [];
}

const grantSubject = /스마트(?:\s*상점)?|경영\s*안정|디지털\s*(?:전환|지원)/u;
function grantMention(snapshot: DataSnapshot, text: string, locale: Locale) {
  const input = normalizeNavisName(text);
  const quoted = text.match(quote)?.[1];
  const rows = snapshot.tables.grantNotice;
  const label = (row: (typeof rows)[number]) => tr(locale).t(row.titleKey);
  const exact = rows.filter(row => input.includes(normalizeNavisName(label(row))));
  if (exact.length) return exact;
  return quoted ? resolveNavisName(quoted, rows, label).matches : [];
}

function navigation(raw: string, snapshot: DataSnapshot, locale: Locale):
  (DomainDetail & { local?: true }) | null | undefined {
  const text = normalizeNavisInput(raw);
  if (noAction.test(text) || otherFeatureRequest.test(text)) return;
  const rows = manualRows(snapshot);
  const named = manualMention(rows, text, locale);
  const manual = named.length === 1 ? named[0] : undefined;
  const template = /신청서/u.test(text) && /초안|작성/u.test(text) && !/제출|대신\s*신청/u.test(text);
  if (template || open.test(text) && grantWords.test(text)) {
    const notices = grantMention(snapshot, text, locale);
    if (notices.length > 1 || !notices.length && grantSubject.test(text)) return null;
    if (template && !notices.length) return null;
    if (!template && /지원\s*현황|신청한\s*지원\s*사업/u.test(text)) {
      const application = notices[0] && snapshot.tables.grantApplication.find(row => row.noticeId === notices[0].noticeId);
      return detail(grants, { view: 'applications' }, 'grantApplication', application?.applicationId);
    }
    const view = template ? 'template' : /공식\s*공고/u.test(text) ? 'official' : 'notices';
    if (view === 'official' && !notices.length) return null;
    const body = template ? text.match(tail)?.[1]?.trim() : undefined;
    const prefill = body && validateAgentPrefill(grants, { body }) ? { body } : undefined;
    const plan = detail(grants, { view, ...(template ? { focus: 'action' } : {}), ...(prefill ? { prefill } : {}) },
      'grantNotice', notices[0]?.noticeId);
    // As with the menu form, typed prefill stays in the browser.
    return prefill ? { ...plan, local: true } : plan;
  }
  if (compound.test(text) && /마감|매뉴얼|체크리스트/u.test(text)) return null;
  const manualScreen = manualWords.test(text) || /마감.*문서|영업\s*시간.*문서|매장.*문서/u.test(text);
  if (!manualScreen || !open.test(text) && !/만드는\s*화면|추가하는\s*곳/u.test(text)) return;
  if (remove.test(text) || edit.test(text) && !/(?:고치|수정).*(?:폼|화면)/u.test(text) || /남은|주의|하는\s*일.*알려/u.test(text)) return null;
  const editing = /고치|수정/u.test(text) && !!manual;
  const create = !editing && /만드|새\s*매뉴얼|작성\s*창|추가/u.test(text);
  const section = manual?.section ?? (/매장\s*정보/u.test(text) ? 'store-info' : 'handover');
  if (!manual && !create && (/영업\s*시간|\d+\s*번/u.test(text) || named.length > 1)) return null;
  if (create) {
    const title = text.match(quote)?.[1];
    const cautions = text.match(/주의(?:사항|할\s*점)\s*[:：]\s*(.+)$/u)?.[1];
    const category = section === 'store-info' ? 'store-info' : readCategory(text, locale);
    const steps = readSteps(text);
    const prefill = { section, ...(title ? { title } : {}), ...(category ? { category } : {}),
      ...(cautions ? { cautions } : {}), ...(steps.length && steps.length <= 5 ? { steps } : {}) };
    const args = { view: section, focus: 'action', ...(validateAgentPrefill(manuals, prefill) ? { prefill } : {}) };
    const plan = detail(manuals, args);
    return 'steps' in prefill ? { ...plan, local: true } : plan;
  }
  return detail(manuals, { view: section, ...(editing ? { focus: 'action' } : {}) }, 'manual', manual?.manualId);
}

const categories = ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene'] as const;
function readCategory(text: string, locale: Locale) {
  const t = tr(locale).t;
  if (/위생\s*(?:분류|으로)/u.test(text)) return 'hygiene';
  const explicit = text.match(/분류(?:는|를)?\s*[:：]?\s*([^.,]+)/u)?.[1] ?? text;
  return categories.find(category => {
    const label = t(`data.manualCategory.${category}`);
    return !!label && explicit.includes(label);
  }) ?? (/위생/u.test(explicit) ? 'hygiene' : /분류.*청소/u.test(text) ? 'cleaning' : undefined);
}

function readSteps(text: string): string[] {
  const numbered = [...text.matchAll(/(?:^|[\s,])\d+\s*(?:단계|[.)])\s*([^,]+?)(?=(?:\s*,?\s+\d+\s*(?:단계|[.)]))|$)/gu)]
    .map(match => match[1].trim().replace(/[.,]$/u, ''));
  if (numbered.length) return numbered;
  const arrows = text.split(/\s*→\s*/u);
  if (arrows.length > 1) {
    arrows[0] = arrows[0].replace(/^.*(?:\([^)]+\)|[:：])\s*/u, '').trim();
    if (arrows[0] && !/만들|추가|문서/u.test(arrows[0])) return arrows;
  }
  return [];
}

function manualCreate(text: string, locale: Locale, fields: { title?: string; category?: string; steps?: readonly string[] } = {}): DomainRoute {
  const t = tr(locale).t;
  const storeInfo = /매장\s*정보/u.test(text);
  const section = storeInfo ? 'store-info' : 'handover';
  if (!storeInfo && !/인수인계|매뉴얼/u.test(text)) {
    return clarify('section', [t('widget.manuals.handover'), t('widget.manuals.storeInfo')].join(' / '), value =>
      /매장\s*정보|인수인계/u.test(value) ? manualCreate(`${text} ${value.trim()}`, locale, fields) : undefined);
  }
  const title = fields.title ?? text.match(quote)?.[1] ?? text.match(/(?:제목|이름)(?:은|은\s*|을)?\s+(.+)$/u)?.[1]
    ?? text.match(/^(.+?)\s*(?:매뉴얼|문서)\s*(?:새로\s*)?(?:하나\s*(?:더\s*)?)?(?:만들|추가)/u)?.[1]
    ?? (storeInfo ? text.match(/^(.+?)을?를?\s*매장\s*정보/u)?.[1] : undefined)
    ?? (storeInfo ? text.match(/매장\s*정보에\s+(.+?)\s*(?:적어|추가)/u)?.[1] : undefined);
  const category = fields.category ?? (storeInfo ? 'store-info' : readCategory(text, locale));
  const body = text.match(/(?:내용(?:은|을)?\s*[:：]?\s*|적어\s*줘\s*[:：]\s*)(.+)$/u)?.[1];
  const steps = fields.steps ?? (storeInfo && body ? [body.replace(/^['"‘“]|['"’”][.]?$/gu, '')] : readSteps(text));
  if (!title?.trim()) return clarify('title', t('widget.manuals.titleRequired'), value => manualCreate(text, locale, { ...fields, title: value.trim() }));
  if (!category) return clarify('category', t('data.error.categoryInvalid'), value =>
    manualCreate(text, locale, { title, steps, category: readCategory(value, locale) }));
  if (!steps.length) return clarify('steps', t('data.error.stepsRequired'), value => {
    const numbered = readSteps(value);
    return manualCreate(text, locale, { title, category, steps: numbered.length ? numbered : [value.trim()] });
  });
  return commandTurn('manuals.create', { section, title: slot('title'), category, steps: slot('steps') }, { title, steps });
}

function updateSteps(snapshot: DataSnapshot, manual: ManualRow, locale: Locale) {
  const t = tr(locale).t;
  return manual.steps.map(step => {
    const body = resolveDataText(t, step.body);
    const photoKey = snapshot.tables.manualStep.find(row => row.manualId === manual.manualId && row.stepNo === step.stepNo)?.photoKey;
    return photoKey ? { body, photoKey } : body;
  });
}

function manualRoute(text: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const t = tr(locale).t;
  const rows = manualRows(snapshot);
  const matches = manualMention(rows, text, locale);
  const manual = matches.length === 1 ? matches[0] : undefined;
  const draftRequest = /초안|메모로.*만들|매뉴얼로\s*저장/u.test(text) && !/신청서|지원사업|쿠폰|문자|공지|홍보|답장|리뷰|영상|안내문/u.test(text);
  if (draftRequest) {
    if (remove.test(text) || /저장/u.test(text)) {
      const drafts = snapshot.tables.manualDraft.filter(row => row.status === 'draft');
      const target = drafts.length === 1 ? drafts[0] : undefined;
      if (!target) return drafts.length ? clarify('draftId', t('common.navis.agent.chooseRecord')) : refusal('invalid_target');
      return commandTurn(remove.test(text) ? 'manuals.discardDraft' : 'manuals.saveDraft', {}, undefined,
        { kind: 'manualDraft', id: target.draftId, field: 'draftId' });
    }
    const memo = text.match(tail)?.[1]?.trim() ?? text.match(/\(([^)]+)\)\s*$/u)?.[1]?.trim();
    const create = (value: string) => commandTurn('manuals.createDraftFromMemo', {
      memo: slot('memo'), section: /매장\s*정보/u.test(text) ? 'store-info' : 'handover',
    }, { memo: value.trim() });
    return memo ? create(memo) : clarify('memo', t('data.error.memoRequired'), create);
  }

  if (/(?:와이파이|wifi).*?(?:비밀번호|비번|패스워드|password)/iu.test(text)) return refusal('unavailable');
  const stepNo = Number(text.match(numberedStep)?.[1]) || (/첫\s*단계/u.test(text) ? 1 : undefined);
  const checklistWrite = /(?:했어|끝냈|완료|체크\s*(?:해|다\s*해|취소|해제|풀)|켰어|켰다고|채웠어|켜.*표시|(?:번|단계)\s*체크\s*$|전부\s*풀)/u.test(text)
    && !/어디까지|얼마나|몇\s*단계|알려|뭐|검토|신청|서류/u.test(text);
  const namedStep = /조명/u.test(text) && /켰|켜/u.test(text) ? '조명'
    : /디저트\s*진열|진열대\s*채/u.test(text) ? '진열대'
      : /재고\s*확인/u.test(text) ? '재고' : undefined;
  if (checklistWrite && (stepNo || namedStep || manualWords.test(text) || /^(?:오픈|마감)\s*(?:다|전부)/u.test(text))) {
    const matchingSteps = namedStep ? rows.filter(row => row.checklist).flatMap(row => row.steps.filter(step =>
      resolveDataText(t, step.body).includes(namedStep)).map(step => ({ row, step }))) : [];
    const matchedStep = matchingSteps.length === 1 ? matchingSteps[0] : undefined;
    const target = manual ?? matchedStep?.row;
    if (!target) {
      if (manualWords.test(text) || /레시피|화장실|머신\s*세척/u.test(text)) return refusal('invalid_target');
      return namedStep ? refusal('invalid_target') : clarify('manualId', t('common.navis.agent.chooseRecord'));
    }
    if (!target.checklist) return refusal('invalid_target', t('data.management.error.NOT_CHECKLIST'));
    const checked = !/아직\s*안|체크\s*(?:다\s*)?(?:풀|해제|취소)|전부\s*풀|완료\s*취소/u.test(text);
    const many = multipleSteps.test(text);
    const remaining = target.steps.filter(step => step.checkedToday !== checked);
    if (many && !remaining.length) return answer(t('common.navis.agent.unchanged'));
    const chosenStep = many ? remaining.length === 1 && !/[,·]/u.test(text) ? remaining[0].stepNo : undefined : stepNo ?? matchedStep?.step.stepNo;
    const step = target.steps.find(row => row.stepNo === chosenStep);
    if (!step) {
      if (stepNo && !many) return answer(locale === 'ko' ? `${t('widget.manuals.stepCount', { n: target.steps.length })}까지 있어요.`
        : t('widget.manuals.stepCount', { n: target.steps.length }));
      return clarify('stepNo', t('common.navis.agent.chooseRecord'));
    }
    if (step.checkedToday === checked) return answer(t('common.navis.agent.unchanged'));
    return commandTurn('manuals.toggleStep', { stepNo: slot('stepNo'), checked }, { stepNo: step.stepNo },
      { kind: 'manual', id: target.manualId, field: 'manualId' });
  }

  const storeInfo = /매장\s*(?:정보|관련\s*문서)|영업\s*시간|몇\s*시까지\s*해|주말.*몇\s*시.*열|매장\s*운영\s*규칙|컵\s*규칙|주문\s*마감\s*몇\s*분/u.test(text);
  const manualTopic = manualWords.test(text) || storeInfo || !!manual && /^(?:오픈|마감)/u.test(text)
    || /(?:문서).*(?:만들|추가|지워|삭제)|청소·위생|(?:오픈|마감).*(?:체크|순서)/u.test(text)
    || /주의할\s*점|조심할\s*점|(?:화장실\s*청소|분리수거|재활용).*(?:분류|옮겨|이동|지워|삭제|없애)/u.test(text);
  if (!manualTopic) return;
  if (/게시\s*(?:취소|해제|중지|내려)|비공개|숨겨|공개\s*끄|내려\s*줘/u.test(text)) {
    // D-326 Q3: one published manual comes down by a card with extra confirmation. Several at once and store info stay in the widget.
    if (/전부|모두|전체|일괄|한꺼번에/u.test(text) || manual?.section === 'store-info') return refusal('widget_only');
    if (!manual) return matches.length > 1 ? clarify('manualId', t('common.navis.agent.chooseRecord')) : refusal('invalid_target');
    return commandTurn('manuals.setPublished', { published: false }, undefined, { kind: 'manual', id: manual.manualId, field: 'manualId' });
  }

  const read = (filter: (key: string) => boolean, missing = t('common.navis.noData')) => readFacts(snapshot, manuals, locale, filter, { answer: missing });
  if (storeInfo && /몇\s*개|개수/u.test(text)) return read(key => key === 'manuals.store-info.count');
  if (/최근|업데이트/u.test(text) && !/고쳐\s*줘|수정\s*해|바꿔\s*줘/u.test(text)) {
    const recent = new Set(manualModel(snapshot)?.recent.map(row => `${manualKey(row)}.updatedAt`));
    return read(key => recent.has(key));
  }
  const create = /(?:만들|추가|적어\s*줘)/u.test(text) && !/단계.*추가|맨\s*끝|마지막|주의|\d+\s*번\s*추가/u.test(text);
  if (create) {
    if (manual && /새로|하나\s*더/u.test(text)) {
      const candidate = text.match(quote)?.[1] ?? text.match(/^(.+?)\s*(?:매뉴얼|문서)/u)?.[1];
      if (candidate && normalizeNavisName(candidate) === normalizeNavisName(manualTitle(manual, locale))) return clarify('title', t('data.error.titleRequired'));
    }
    return manualCreate(text, locale);
  }
  const removeStep = (remove.test(text) || /빼줘/u.test(text)) && !!stepNo;
  const change = edit.test(text) || /빼줘/u.test(text) || removeStep || /맨\s*끝|마지막\s*단계|주의(?:사항|할\s*점).*(?:넣|추가|[:：])|\d+\s*번\s*추가/u.test(text);
  if (change) {
    if (!manual) return refusal('invalid_target');
    if (/빼줘/u.test(text) && !stepNo) return clarify('stepNo', t('common.navis.agent.chooseRecord'));
    const ref = { kind: 'manual' as const, id: manual.manualId, field: 'manualId' };
    const value = text.match(quote)?.[1] ?? text.match(tail)?.[1]?.trim();
    if (/제목|이름/u.test(text)) {
      const title = value ?? text.match(/(?:제목|이름)(?:을|를)?\s+(.+?)(?:으로|로)\s*(?:바꿔|수정|변경)/u)?.[1]
        ?? text.match(/→\s*(.+?)\s*이름/u)?.[1];
      if (!title) return clarify('title', t('widget.manuals.titleRequired'));
      return commandTurn('manuals.update', { patch: { title: slot('title') } }, { title }, ref);
    }
    if (/분류/u.test(text)) {
      const category = readCategory(text, locale);
      return category ? commandTurn('manuals.update', { patch: { category } }, {}, ref) : clarify('category', t('data.error.categoryInvalid'));
    }
    if (/주의/u.test(text)) {
      const cautions = value ?? text.match(/주의(?:사항|할\s*점)(?:에)?\s+(.+?)\s+(?:넣|추가)/u)?.[1];
      if (!cautions) return clarify('cautions', t('widget.manuals.cautions'));
      return commandTurn('manuals.update', { patch: { cautions: slot('cautions') } }, { cautions }, ref);
    }
    const steps: ManualStepInput[] = updateSteps(snapshot, manual, locale);
    const index = manual.steps.findIndex(row => row.stepNo === stepNo);
    if (removeStep && index >= 0) steps.splice(index, 1);
    else if (stepNo && index >= 0 && value) {
      const prior = steps[index];
      steps[index] = str(prior) ? value : { ...prior, body: value };
    } else if (/맨\s*끝|마지막\s*단계|\d+\s*번\s*추가/u.test(text)) {
      const appended = value ?? text.match(/마지막\s*단계로\s+(.+?)\s*넣/u)?.[1] ?? text.match(/체크리스트에\s+(.+?)\s*\d+\s*번/u)?.[1];
      if (!appended) return clarify('steps', t('data.error.stepsRequired'));
      steps.push(appended);
    } else if (manual.section === 'store-info' && value) steps.splice(0, steps.length, value);
    else if (manual.section === 'store-info' && /주말/u.test(text)) {
      const hour = Number(text.match(/(\d+)\s*시/u)?.[1]);
      const range = /((?:토요일|일요일|주말)\s+\d{2}:\d{2}~)\d{2}:\d{2}/gu;
      const body = resolveDataText(t, manual.body);
      if (!Number.isInteger(hour) || hour < 13 || hour > 23 || !range.test(body)) return clarify('steps', t('data.error.stepsRequired'));
      steps.splice(0, steps.length, body.replace(range, (_, prefix: string) => `${prefix}${hour}:00`));
    }
    else return clarify('steps', t('data.error.stepsRequired'));
    if (!steps.length) return clarify('steps', t('data.error.stepsRequired'));
    return commandTurn('manuals.update', { patch: { steps: slot('steps') } }, { steps }, ref);
  }
  if (remove.test(text)) {
    if (/전부|모두|전체|일괄|한꺼번에/u.test(text)) return refusal('widget_only');
    if (/^(?:청소|위생)(?:\s*관련)?\s*(?:문서|매뉴얼)/u.test(text)) return clarify('manualId', t('common.navis.agent.chooseRecord'));
    if (!manual) return refusal('invalid_target');
    return commandTurn('manuals.delete', {}, undefined, { kind: 'manual', id: manual.manualId, field: 'manualId' });
  }
  if (storeInfo) {
    if (/운영\s*규칙|컵\s*규칙|주문\s*마감\s*몇\s*분/u.test(text)) {
      const guidance = manualModel(snapshot)?.storeInfo.filter(row => /운영규칙|컵규칙|주문마감/u.test(normalizeNavisName(manualTitle(row, locale))));
      return read(key => !!guidance?.some(row => key === `${manualKey(row)}.section.body`));
    }
    const row = manual ?? (manualModel(snapshot)?.storeInfoCount === 1 ? manualModel(snapshot)?.storeInfo[0] : undefined);
    const hours = /영업\s*시간|몇\s*시|주말/u.test(text);
    return read(key => !!row && key === `${manualKey(row)}.section.${hours ? 'hours' : 'body'}`);
  }
  if (/청소|위생/u.test(text) && !manual) {
    const related = rows.filter(row => row.category === 'cleaning' || row.category === 'hygiene'
      || /청소|세척|위생/u.test(manualTitle(row, locale)));
    return read(key => related.some(row => key === `${manualKey(row)}.category`));
  }
  if (!manual) return /몇\s*개|개수|전체|목록/u.test(text) ? read(key => key === 'manuals.published.count') : undefined;
  const key = manualKey(manual);
  if (/주의|조심/u.test(text)) return read(name => name === `${key}.cautions`);
  if (/어디까지|얼마나|몇\s*단계.*했|진행/u.test(text)) return read(name => name === `${key}.checklist.progress`);
  if (/아직\s*안|남은/u.test(text)) {
    const pending = new Set(manual.steps.filter(step => !step.checkedToday).map(step => `${key}.step.${step.stepNo}`));
    return read(name => pending.has(name), t('common.navis.agent.none'));
  }
  if (stepNo) return read(name => name === `${key}.step.${stepNo}`);
  if (readWords.test(text) || /하는\s*일|절차|순서|읽어/u.test(text)) return read(name => name.startsWith(`${key}.step.`) && !name.endsWith('.checked'));
}

function grantRoute(text: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const t = tr(locale).t;
  const notices = grantMention(snapshot, text, locale);
  const notice = notices.length === 1 ? notices[0] : undefined;
  const applications = snapshot.tables.grantApplication;
  const matchingApplications = notice ? applications.filter(row => row.noticeId === notice.noticeId) : [];
  const statusesQuestion = /^(?:선정됐|떨어졌|결과\s*나왔)|결과\s*메모|디지털\s*지원/u.test(text);
  const grantTopic = grantWords.test(text) || !!notice || grantSubject.test(text) || statusesQuestion
    || /^(?:접수해\s*줘)|신청한\s*(?:거|지원)|진행\s*중\s*몇\s*건|신청\s*완료로\s*표시|내가\s*신청\s*가능/u.test(text);
  if (!grantTopic && !/선정될\s*확률|내가\s*뽑힐까/u.test(text)) return;

  const read = (filter: (key: string) => boolean, missing = t('common.navis.noData')) =>
    readFacts(snapshot, grants, locale, filter, { answer: missing });
  if (/(?:대신\s*신청|신청서\s*제출|사이트에\s*신청|^접수해\s*줘)/u.test(text)) {
    return refusal('widget_only', {
      ko: '공식 공고에서 직접 신청해 주세요.', en: 'Apply directly through the official notice.',
      'zh-Hans': '请通过官方公告直接申请。', 'zh-Hant': '請透過官方公告直接申請。',
    }[locale]);
  }
  if (/선정될\s*확률|내가\s*뽑힐까|받을\s*수\s*있을\s*것/u.test(text)) return refusal('unavailable');
  if (/받을\s*수\s*있어|자격\s*(?:돼|되)|내가\s*신청\s*가능/u.test(text)) {
    return read(key => key === 'grants.eligibility', t('widget.grants.officialNote'));
  }
  if (/신청서/u.test(text) && /초안|작성/u.test(text)) {
    return grantSubject.test(text) && !notice ? refusal('invalid_target') : clarify('noticeId', t('common.navis.agent.chooseRecord'));
  }
  if (/공식\s*공고/u.test(text) && open.test(text)) {
    return grantSubject.test(text) && !notice ? refusal('invalid_target') : clarify('noticeId', t('common.navis.agent.chooseRecord'));
  }

  const resultMemo = /(?:결과\s*)?메모/u.test(text);
  const markReview = /검토(?:했|\s*완료|\s*또)|(?:확인\s*끝|검토.*체크)/u.test(text) && !/끝낸\s*거|있어|알려/u.test(text);
  const recordApplication = /신청(?:했|했다고|\s*끝냈|\s*함|\s*완료).*|신청\s*완료로\s*표시/u.test(text)
    && !/신청했(?:던|나)|신청한|아직|언제|있어|알려/u.test(text);
  const grantRef = notice && { kind: 'grantNotice' as const, id: notice.noticeId, field: 'noticeId' };
  if (/신청/u.test(text) && /검토|메모|[+]|캘린더/u.test(text)
      && /그리고|표시하고|신청했|검토.*신청|[+]|메모는/u.test(text)) {
    return clarify('command', t('common.navis.agent.chooseRecord'));
  }
  if (markReview || recordApplication) {
    if (resultMemo) return clarify('command', t('common.navis.agent.chooseRecord'));
    if (!grantRef || !notice) return grantSubject.test(text) ? refusal('invalid_target') : clarify('noticeId', t('common.navis.agent.chooseRecord'));
    if (markReview && isReviewed(snapshot, notice.noticeId) || recordApplication && isApplied(snapshot, notice.noticeId)) return answer(t('common.navis.agent.unchanged'));
    if (recordApplication && !canApply(notice)) return refusal('invalid_target');
    return commandTurn(markReview ? 'grants.markReviewed' : 'grants.apply', {}, undefined, grantRef);
  }

  const status = /미선정|떨어졌|탈락/u.test(text) ? 'rejected'
    : /지원\s*완료|지원금\s*받았|완료\s*처리/u.test(text) ? 'completed'
      : /서류\s*심사|심사\s*중/u.test(text) ? 'reviewing'
        : /선정됐|선정이래|뽑혔|합격/u.test(text) ? 'selected' : undefined;
  const deleteApplication = /신청\s*(?:기록|내역)|지원\s*기록/u.test(text) && remove.test(text);
  const invalidStatus = /보류|취소됨|대기\s*중/u.test(text) && (edit.test(text) || /상태/u.test(text));
  if (invalidStatus) {
    return clarify('status', statuses.map(status => grantStatus(locale, status)).join(' / '));
  }
  if (deleteApplication || status && !readWords.test(text) || resultMemo && !/읽어|알려|뭐/u.test(text)) {
    if (deleteApplication && /전부|전체|모두|일괄/u.test(text)) return refusal('widget_only');
    const target = matchingApplications.length === 1 ? matchingApplications[0]
      : !notice && !grantSubject.test(text) && applications.length === 1 ? applications[0] : undefined;
    if (!target) return grantSubject.test(text) || notice ? refusal('invalid_target') : clarify('applicationId', t('common.navis.agent.chooseRecord'));
    const ref = { kind: 'grantApplication' as const, id: target.applicationId, field: 'applicationId' };
    if (deleteApplication) return commandTurn('grants.deleteApplication', {}, undefined, ref);
    const memo = resultMemo ? remove.test(text) || /비워/u.test(text) ? '' : text.match(quote)?.[1] ?? text.match(tail)?.[1]?.trim()
      ?? text.match(/메모(?:에)?\s+(.+?)\s*(?:적어|메모해)/u)?.[1] : undefined;
    if (resultMemo && memo === undefined) return clarify('resultMemo', t('widget.grants.resultMemo'));
    if ((status === undefined || status === target.status) && (memo === undefined || memo === resolveDataText(t, target.resultMemo))) {
      return answer(t('common.navis.agent.unchanged'));
    }
    return commandTurn('grants.updateApplication', { ...(status ? { status } : {}), ...(memo !== undefined ? { resultMemo: slot('resultMemo') } : {}) },
      memo !== undefined ? { resultMemo: memo } : {}, ref);
  }

  if (/진행\s*중|지금\s*심사\s*중|심사\s*중인/u.test(text)) return read(key => key === 'grants.inProgress.count');
  if (/내가\s*신청|지원\s*현황|신청한\s*지원|진행\s*상황|어떻게\s*됐/u.test(text)) {
    return read(key => notice ? matchingApplications.some(row => key.startsWith(`${applicationKey(row.applicationId)}.`))
      : !grantSubject.test(text) && key.startsWith('grants.application.'), t('widget.grants.noApplications'));
  }
  if (/빠른|임박|곧\s*마감/u.test(text)) {
    const view = selectWidget(snapshot, grants, defaultCondition, 'normal');
    const first = view.status === 'ready' ? view.model.notices.find(row => row.isCandidate) : undefined;
    return read(key => !!first && key === `${noticeKey(first.noticeId)}.deadline`, t('data.state.grants.none'));
  }
  if (notice) {
    const key = noticeKey(notice.noticeId);
    if (/조건|자격/u.test(text)) return read(name => name.startsWith(`${key}.condition.`));
    if (/어디|기관|지역/u.test(text)) return read(name => name === `${key}.agency` || name === `${key}.region`);
    if (/검토/u.test(text)) return read(name => name === `${key}.review`);
    if (/마감|언제|접수|신청\s*할\s*수/u.test(text)) {
      return read(name => name === `${key}.deadline` || matchingApplications.some(row => name === `${applicationKey(row.applicationId)}.status`));
    }
    return read(name => name === `${key}.detail`);
  }
  if (grantSubject.test(text)) return open.test(text) ? refusal('invalid_target') : read(() => false);
  if (/검토/u.test(text)) {
    const reviewed = new Set(snapshot.tables.grantNotice.filter(row => isReviewed(snapshot, row.noticeId)).map(row => `${noticeKey(row.noticeId)}.review`));
    return read(key => reviewed.has(key));
  }
  return read(key => key === 'grants.candidates.count');
}

/** Only validated, browser-local fields initialize the existing widget editors. */
export function manualsGrantsDetailPrefill(ref: DetailRef) {
  const prefill = ref.prefill;
  if ((ref.featureId !== manuals && ref.featureId !== grants) || prefill?.kind !== 'widget-draft'
    || !['ui.openDetail', 'ui.setDraftField'].includes(prefill.command)
    || !validateAgentPrefill(ref.featureId, prefill.fields)) return;
  return prefill.fields;
}

export const manualsGrantsDomain = {
  featureIds: [manuals, grants],
  commands: commandNames.map(commandAdapter),
  reads: (['manual', 'manualDraft', 'grantNotice', 'grantApplication'] as const).map(reader),
  projectWidget: projectFacts,
  navigation,
  routePresentation(raw, snapshot, locale) {
    const text = normalizeNavisInput(raw);
    if (noAction.test(text) || otherFeatureRequest.test(text)) return;
    if (/라[테떼].*우유/u.test(text) && /얼마나|몇\s*m[lL]|우유\s*양/u.test(text)) {
      const t = tr(locale).t;
      const exact = menuAgentDomain.route?.(`${text} 레시피`, snapshot, locale);
      if (exact) return exact;
      const names = selectMenus(snapshot, {}).rows.map(row => resolveDataText(t, row.name))
        .filter(name => normalizeNavisName(name).includes('라테'));
      return clarify('name', names.join(' / '), value => menuAgentDomain.route?.(`${value} 레시피`, snapshot, locale));
    }
    if (grantWords.test(text) || grantSubject.test(text)) return grantRoute(text, snapshot, locale);
    if (manualWords.test(text) || /메모로.*만들|매뉴얼로\s*저장|조명.*(?:켰|켜)|영업\s*시간|컵\s*규칙|조심할\s*점/u.test(text)) {
      return manualRoute(text, snapshot, locale);
    }
  },
  route(raw, snapshot, locale) {
    const text = normalizeNavisInput(raw);
    if (noAction.test(text) || otherFeatureRequest.test(text)) return;
    return grantRoute(text, snapshot, locale) ?? manualRoute(text, snapshot, locale);
  },
} satisfies DomainAdapter;
