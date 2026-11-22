import type { ManualInput } from '../../commands/management-types';
import type { DataSnapshot, GrantNotice, Manual } from '../../db/types';
import type { GrantApplication } from '../../db/management-types';
import { PortError, defineBinding, type CommandContext, type CommandRequest, type DomainAdapter, type LoadContext } from '../00';
import type { ChecklistDto, DraftDto, GrantApplicationDto, GrantNoticeDto, ManualDto, ManualsGrantsBriefingDto } from './dto';

const base = '/insight';
const raw = (value: string) => ({ raw: value });
// Existing widget and Navis translators accept verbatim data in localized fixture fields with this prefix.
const textKey = (value: string) => `seed:${value}`;

type OfficialNotice = GrantNotice & { readonly official: GrantNoticeDto; readonly businessDay: string };
export const isOfficialNotice = (notice: GrantNotice): notice is OfficialNotice => 'official' in notice && 'businessDay' in notice;
type InsightManual = Manual & { readonly businessDay: string };
const isInsightManual = (manual: Manual): manual is InsightManual => 'businessDay' in manual;
type OwnerApplication = GrantApplication & { readonly title: ReturnType<typeof raw>; readonly source: 'owner'; readonly receiptNumber: string | null };
export const isOwnerApplication = (application: GrantApplication): application is OwnerApplication => 'source' in application && application.source === 'owner';

const emptyTables = { manual: [], manualStep: [], manualDraft: [], checklistLog: [], grantNotice: [], grantReview: [], grantApplication: [] };
const page = <T>(ctx: LoadContext, resource: string, query?: Record<string, string>) =>
  ctx.reads.all<T>({ resource, path: `${base}/${resource}`, query: { limit: 100, ...query } }, { signal: ctx.signal });

const manualFields = ({ section, category, title, cautions, steps }: Partial<ManualInput>) => {
  const storeInfo = section === 'store-info' || category === 'store-info';
  const first = steps?.[0];
  return {
    section, category, title, cautions,
    ...(steps && (storeInfo ? { body: typeof first === 'string' ? first : first?.body ?? '', steps: [] } : { steps })),
  };
};

const create = (path: string, body: unknown): CommandRequest => ({ method: 'POST', path: `${base}/${path}`, body });
function change(ctx: CommandContext, method: CommandRequest['method'], resource: string, id: string, body: unknown, suffix = ''): CommandRequest {
  const expectedRevision = ctx.revision(`${resource}:${id}`);
  if (expectedRevision === undefined) throw new PortError(404, 'NOT_FOUND');
  return { method, path: `${base}/${resource}/${encodeURIComponent(id)}${suffix}`, body, expectedRevision };
}

function checkStep(ctx: CommandContext, manualId: string, stepNo: number, checked?: boolean): CommandRequest {
  const manual = ctx.snapshot.tables.manual.find(row => row.manualId === manualId);
  const expectedRevision = ctx.revision(`manuals:${manualId}`);
  if (!manual || !isInsightManual(manual) || expectedRevision === undefined) throw new PortError(404, 'NOT_FOUND');
  if (!manual.isPublished || !['opening', 'closing'].includes(manual.category)) throw new PortError(409, 'CONFLICT', 'CHECKLIST_UNAVAILABLE');
  const { businessDay } = manual;
  const isChecked = ctx.snapshot.tables.checklistLog.some(row => row.date === businessDay && row.manualId === manualId && row.stepNo === stepNo);
  return { ...create('checklists', { manualId, stepNo, checked: checked ?? !isChecked, businessDay, expectedChecklistRevision: ctx.revision(`checklists:${manualId}`) ?? 0 }), expectedRevision };
}

function grantNotice(row: GrantNoticeDto, businessDay: string): OfficialNotice {
  return {
    noticeId: row.id, titleKey: textKey(row.title), agencyKey: textKey(row.agency), regionKey: textKey(row.region),
    // The shared projection requires sortable stamps. The detail displays the authoritative date-only values.
    applyStart: row.startsOn ? `${row.startsOn}T00:00` : '', applyEnd: row.deadline ? `${row.deadline}T23:59` : '',
    conditionKeys: row.target ? [textKey(row.target)] : [], summaryKey: textKey(row.summary),
    matchStatus: row.matchStatus, official: row, businessDay,
  };
}

function projectTables(manuals: readonly ManualDto[], drafts: readonly DraftDto[], checks: readonly ChecklistDto[],
  notices: readonly GrantNoticeDto[], applications: readonly GrantApplicationDto[], businessDay: string) {
  return {
    manual: manuals.map((row): InsightManual => ({ manualId: row.id, title: raw(row.title), section: row.section, category: row.category,
      cautions: raw(row.cautions), isPublished: row.isPublished, updatedAt: row.updatedAt, businessDay })),
    manualStep: manuals.flatMap(row => (row.section === 'store-info'
      ? [{ body: row.body.trim() || row.steps.map(step => step.body).join('\n') }].filter(step => step.body.trim())
      : row.steps)
      .map((step, index) => ({ ...step, manualId: row.id, stepNo: index + 1, body: raw(step.body) }))),
    manualDraft: drafts.map(row => ({ draftId: row.id, section: row.section, category: row.category, memo: row.memo,
      title: raw(row.title), cautions: raw(row.cautions), steps: row.section === 'store-info' ? [raw(row.body)] : row.steps.map(step => raw(step.body)), status: row.status })),
    checklistLog: checks.flatMap(row => row.checkedSteps.map(stepNo => ({ date: row.businessDay, manualId: row.manualId, stepNo }))),
    grantNotice: notices.map(row => grantNotice(row, businessDay)),
    grantReview: notices.map(row => ({ noticeId: row.id, reviewStatus: row.reviewStatus })),
    grantApplication: applications.map((row): OwnerApplication => ({ applicationId: row.id, noticeId: row.noticeId, appliedOn: row.appliedOn,
      status: row.status, resultMemo: row.resultMemo === null ? null : raw(row.resultMemo), title: raw(row.title), source: row.source, receiptNumber: row.receiptNumber })),
  };
}

export const manualsAdapter: DomainAdapter = {
  domain: 'manuals', sources: ['manuals', 'checklists', 'grants'],
  tables: ['manual', 'manualStep', 'manualDraft', 'checklistLog', 'grantNotice', 'grantReview', 'grantApplication'],
  clear: () => emptyTables,
  errorKeys: { DUPLICATE_MANUAL_TITLE: 'data.management.error.MANUAL_TITLE_EXISTS', CHECKLIST_UNAVAILABLE: 'data.management.error.NOT_CHECKLIST',
    BUSINESS_DAY_CHANGED: 'data.real.error.STALE_REVISION', INVALID_MEMO: 'data.error.memoRequired', INVALID_TITLE: 'data.error.titleRequired' },
  async load(ctx) {
    const briefing = await ctx.reads.one<ManualsGrantsBriefingDto>({ resource: 'manuals-grants-briefing', path: `${base}/manuals-grants-briefing` }, { signal: ctx.signal });
    const day = briefing.businessDay;
    const manuals = page<ManualDto>(ctx, 'manuals');
    const drafts = page<DraftDto>(ctx, 'manual-drafts');
    const checks = page<ChecklistDto>(ctx, 'checklists', { from: day, to: day });
    const notices = page<GrantNoticeDto>(ctx, 'grant-notices');
    const applications = page<GrantApplicationDto>(ctx, 'grant-applications');
    const [docs, unsaved, progress, official, owner] = await Promise.all([manuals, drafts, checks, notices, applications]);
    const versions = new Map(docs.items.map(row => [row.id, row.checklistVersion]));
    const current = progress.items.filter(row => row.businessDay === day && versions.get(row.manualId) === row.manualRevision);
    const pages = [docs, unsaved, progress, official, owner];
    return {
      tables: projectTables(docs.items, unsaved.items, current, official.items, owner.items, day),
      revisions: Object.fromEntries([
        ...docs.items.map(row => [`manuals:${row.id}`, row.revision]),
        ...unsaved.items.map(row => [`manual-drafts:${row.id}`, row.revision]),
        ...current.map(row => [`checklists:${row.manualId}`, row.revision]),
        ...official.items.map(row => [`grant-notices:${row.id}`, row.revision]),
        ...owner.items.map(row => [`grant-applications:${row.id}`, row.revision]),
      ]),
      asOf: [briefing.asOf, ...pages.map(result => result.asOf)].sort().at(-1)!,
      sourceRevision: Math.max(briefing.sourceRevision, ...pages.map(result => result.sourceRevision)),
      complete: pages.every(result => result.complete),
    };
  },
  commands: [
    defineBinding({ type: 'manuals.create', receiptBase: base, noticeKey: 'data.notice.manualSaved', request: command =>
      create('manuals', { ...manualFields(command), confirmDuplicate: command.confirmDuplicate }) }),
    defineBinding({ type: 'manuals.update', receiptBase: base, noticeKey: 'data.notice.manualSaved', request: (command, ctx) => {
      const current = ctx.snapshot.tables.manual.find(row => row.manualId === command.manualId);
      const scope = { section: current?.section, category: current?.category, ...command.patch };
      return change(ctx, 'PATCH', 'manuals', command.manualId, { patch: manualFields(scope) });
    } }),
    defineBinding({ type: 'manuals.delete', receiptBase: base, noticeKey: 'data.management.notice.deleted', request: (command, ctx) =>
      change(ctx, 'DELETE', 'manuals', command.manualId, { confirmed: true }) }),
    defineBinding({ type: 'manuals.setPublished', receiptBase: base, request: (command, ctx) =>
      change(ctx, 'POST', 'manuals', command.manualId, { published: command.published, confirmed: true }, '/publish') }),
    defineBinding({ type: 'manuals.createDraftFromMemo', receiptBase: base, noticeKey: 'data.notice.draftCreated', request: command =>
      create('manual-drafts', { memo: command.memo, section: command.section, cautions: command.cautions }) }),
    defineBinding({ type: 'manuals.saveDraft', receiptBase: base, noticeKey: 'data.notice.manualSaved', request: (command, ctx) => {
      const current = ctx.snapshot.tables.manualDraft.find(row => row.draftId === command.draftId);
      const category = command.category ?? (command.section === 'store-info' ? 'store-info' : current?.category);
      return change(ctx, 'POST', 'manual-drafts', command.draftId,
        manualFields({ ...command, category, section: command.section ?? current?.section }), '/save');
    } }),
    defineBinding({ type: 'manuals.discardDraft', receiptBase: base, request: (command, ctx) =>
      change(ctx, 'DELETE', 'manual-drafts', command.draftId, { confirmed: true }) }),
    defineBinding({ type: 'manuals.toggleStep', receiptBase: base, request: (command, ctx) => checkStep(ctx, command.manualId, command.stepNo, command.checked) }),
    defineBinding({ type: 'grants.syncNotices', request: command => create('grant-notices/sync', { region: command.region, industry: command.industry }) }),
    defineBinding({ type: 'grants.markReviewed', receiptBase: base, noticeKey: 'data.notice.grantReviewed', request: (command, ctx) =>
      change(ctx, 'POST', 'grant-notices', command.noticeId, {}, '/review') }),
    defineBinding({ type: 'grants.apply', receiptBase: base, request: command => create('grant-applications', { noticeId: command.noticeId }) }),
    defineBinding({ type: 'grants.updateApplication', receiptBase: base, noticeKey: 'data.management.notice.saved', request: (command, ctx) =>
      change(ctx, 'PATCH', 'grant-applications', command.applicationId, { status: command.status, resultMemo: command.resultMemo }) }),
    defineBinding({ type: 'grants.deleteApplication', receiptBase: base, noticeKey: 'data.management.notice.deleted', request: (command, ctx) =>
      change(ctx, 'DELETE', 'grant-applications', command.applicationId, { confirmed: true }) }),
  ],
};

export function businessDayForManual(snapshot: DataSnapshot, manualId: string): string | undefined {
  const row = snapshot.tables.manual.find(item => item.manualId === manualId);
  return row && isInsightManual(row) ? row.businessDay : undefined;
}
