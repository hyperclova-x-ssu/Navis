import { fingerprint, InsightError, isDate, isUuid } from '../../scope.ts';
import type { GrantProvider } from './bizinfo.ts';
import { grantSync } from './grant-refresh.ts';
import { byId, conflict, create, currentChecklist, list, missing, undo,
  type Context, type Data, type Kind, type Row } from './records.ts';

export const invalid = (field: string) => new InsightError(400, `INVALID_${field.toUpperCase()}`);
export const isObject = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
export function object(value: unknown, allowed: string[]) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid('request');
  return value;
}
export function string(value: unknown, field: string, limit: number, allowEmpty = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.trim().length > limit || (!allowEmpty && !value.trim())) throw invalid(field);
  return value.trim();
}
export function uuid(value: unknown, field = 'id') {
  if (!isUuid(value)) throw invalid(field);
  return value;
}
export function integer(value: unknown, field: string, max = 2_147_483_647) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw invalid(field);
  return value;
}
function choice(value: unknown, field: string, values: readonly string[]) {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid(field);
  return value;
}
export function businessDay(value: Date, timezone: unknown, dayStart: unknown) {
  if (typeof timezone !== 'string' || typeof dayStart !== 'string'
    || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(dayStart)) {
    throw new InsightError(503, 'STORE_CLOCK_UNAVAILABLE');
  }
  let local: string;
  try {
    local = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(value);
  } catch {
    throw new InsightError(503, 'STORE_CLOCK_UNAVAILABLE');
  }
  const day = local.slice(0, 10);
  const boundary = dayStart.length === 5 ? `${dayStart}:00` : dayStart;
  return local.slice(11) >= boundary ? day : new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
}

export type CommandOptions = {
  provider: GrantProvider;
  verifyPhoto?: (ctx: Pick<Context, 'storeId' | 'actorId'>, fileId: string) => Promise<boolean>;
};
const manualFields = ['title', 'section', 'category', 'body', 'cautions', 'steps'];
const categories = ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene', 'store-info'];
const statuses = ['applied', 'reviewing', 'selected', 'rejected', 'completed'];
type Step = { body: string; photoKey?: string };

async function manual(ctx: Context, values: Data, options: CommandOptions) {
  const section = choice(values.section, 'section', ['handover', 'store-info']);
  const category = choice(values.category, 'category', categories);
  if ((section === 'store-info') !== (category === 'store-info')) throw invalid('category');
  const raw = values.steps ?? [];
  if (!Array.isArray(raw) || raw.length > 50) throw invalid('steps');
  const steps: Step[] = [];
  for (const value of raw) {
    const step = typeof value === 'string' ? { body: value } : object(value, ['body', 'photoKey']);
    const body = string(step.body, 'step', 1000);
    if (step.photoKey === undefined) {
      steps.push({ body });
    } else {
      const photoKey = uuid(step.photoKey, 'photo');
      if (!options.verifyPhoto) throw new InsightError(503, 'FILE_VERIFICATION_UNAVAILABLE');
      if (!await options.verifyPhoto({ storeId: ctx.storeId, actorId: ctx.actorId }, photoKey)) throw invalid('photo');
      steps.push({ body, photoKey });
    }
  }
  return { section, category, title: string(values.title, 'title', 160),
    body: string(values.body ?? '', 'body', 4000, true), cautions: string(values.cautions ?? '', 'cautions', 2000, true),
    steps, checklist: category === 'opening' || category === 'closing' };
}

function requireRevision(row: Row, input: Data) {
  if (row.revision !== integer(input.expectedRevision, 'expected_revision')) throw conflict('STALE_REVISION');
}
function requireExtra(input: Data) {
  if (input.confirmed !== true) throw conflict('EXTRA_CONFIRMATION_REQUIRED');
}
async function requireRow(ctx: Context, kind: Kind, id: string) {
  const row = await byId(ctx, kind, id);
  if (!row) throw missing();
  return row;
}
function change(row: Row, data: Data) {
  return { resourceId: row.id, revision: row.revision,
    changes: fingerprint(row.data) === fingerprint(data) ? [] : [{ ...row, data }] };
}
const created = (row: ReturnType<typeof create>) => ({ resourceId: row.id, changes: [row] });
const archived = (row: Row) => ({ resourceId: row.id, changes: [{ ...row, archived: true }] });
const emptyList = { limit: 100, cursor: null, from: null, to: null };

async function titleAvailable(ctx: Context, title: string, except?: string) {
  const { rowCount } = await ctx.db.query(`SELECT 1 FROM insight.manuals_grants_record
    WHERE store_id=$1 AND kind='manual' AND NOT archived AND lower(data->>'title')=lower($2)
      AND ($3::uuid IS NULL OR id<>$3) LIMIT 1`, [ctx.storeId, title, except ?? null]);
  if (rowCount) throw conflict('DUPLICATE_MANUAL_TITLE');
}

export type Operation = 'create-manual' | 'edit-manual' | 'archive-manual' | 'publish' | 'create-draft'
  | 'save-draft' | 'archive-draft' | 'check' | 'sync' | 'review' | 'apply' | 'edit-application'
  | 'archive-application' | 'undo';

export async function perform(ctx: Context, operation: Operation, id: string | null, body: unknown, options: CommandOptions) {
  switch (operation) {
    case 'create-manual': {
      const input = object(body, [...manualFields, 'confirmDuplicate']);
      if (input.confirmDuplicate !== undefined && typeof input.confirmDuplicate !== 'boolean') throw invalid('request');
      const data = await manual(ctx, input, options);
      if (input.confirmDuplicate !== true) await titleAvailable(ctx, data.title);
      return created(create('manual', { ...data, isPublished: true, checklistVersion: 1 }));
    }
    case 'edit-manual': {
      const input = object(body, ['patch', 'expectedRevision']);
      const patch = object(input.patch, manualFields);
      const row = await requireRow(ctx, 'manual', id!);
      requireRevision(row, input);
      const data = await manual(ctx, { ...row.data, ...patch }, options);
      if (data.title !== row.data.title) await titleAvailable(ctx, data.title, row.id);
      const sameChecklist = data.category === row.data.category && fingerprint(data.steps) === fingerprint(row.data.steps);
      return change(row, { ...data, isPublished: row.data.isPublished,
        checklistVersion: sameChecklist ? row.data.checklistVersion : row.revision + 1 });
    }
    case 'archive-manual':
    case 'archive-draft':
    case 'archive-application': {
      const input = object(body, ['expectedRevision', 'confirmed']);
      requireExtra(input);
      const kind = { 'archive-manual': 'manual', 'archive-draft': 'draft', 'archive-application': 'application' } as const;
      const row = await requireRow(ctx, kind[operation], id!);
      requireRevision(row, input);
      return archived(row);
    }
    case 'publish': {
      const input = object(body, ['published', 'expectedRevision', 'confirmed']);
      if (typeof input.published !== 'boolean') throw invalid('published');
      if (!input.published) requireExtra(input);
      const row = await requireRow(ctx, 'manual', id!);
      requireRevision(row, input);
      if (row.data.section !== 'handover' && !input.published) throw conflict('PUBLISH_NOT_SUPPORTED');
      return change(row, { ...row.data, isPublished: input.published });
    }
    case 'create-draft': {
      const input = object(body, ['memo', 'section', 'cautions']);
      const memo = string(input.memo, 'memo', 4000);
      const section = choice(input.section ?? 'handover', 'section', ['handover', 'store-info']);
      const lines = memo.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const category = section === 'store-info' ? 'store-info' : 'new-staff';
      return created(create('draft', { memo, section, title: lines[0]!.slice(0, 160), category,
        body: section === 'store-info' ? memo : '',
        steps: section === 'handover' ? lines.slice(0, 50).map(line => ({ body: line.slice(0, 1000) })) : [],
        cautions: string(input.cautions ?? '', 'cautions', 2000, true), status: 'draft' }));
    }
    case 'save-draft': {
      const input = object(body, [...manualFields, 'expectedRevision']);
      const row = await requireRow(ctx, 'draft', id!);
      requireRevision(row, input);
      const data = await manual(ctx, { ...row.data, ...input }, options);
      await titleAvailable(ctx, data.title);
      const saved = create('manual', { ...data, isPublished: true, checklistVersion: 1 });
      return { resourceId: saved.id, changes: [saved, { ...row, archived: true }] };
    }
    case 'check': {
      const input = object(body, ['manualId', 'stepNo', 'checked', 'expectedRevision', 'expectedChecklistRevision', 'businessDay']);
      if (typeof input.checked !== 'boolean') throw invalid('checked');
      const row = await requireRow(ctx, 'manual', uuid(input.manualId));
      requireRevision(row, input);
      if (!row.data.checklist || !row.data.isPublished) throw conflict('CHECKLIST_UNAVAILABLE');
      const steps = row.data.steps as Step[];
      const stepNo = integer(input.stepNo, 'step', steps.length);
      const day = ctx.businessDay;
      if (input.businessDay !== undefined && input.businessDay !== day) throw conflict('BUSINESS_DAY_CHANGED');
      const current = await currentChecklist(ctx, row);
      if (input.expectedChecklistRevision !== undefined && input.expectedChecklistRevision !== (current?.revision ?? 0)) {
        throw conflict('STALE_REVISION');
      }
      const checked = new Set((current?.data.checkedSteps ?? []) as number[]);
      if (input.checked) checked.add(stepNo);
      else checked.delete(stepNo);
      const data = { manualId: row.id, manualRevision: row.data.checklistVersion, category: row.data.category, checkedSteps: [...checked].sort((a, b) => a - b),
        totalSteps: steps.length };
      if (current) return change(current, data);
      if (checked.size === 0) return { resourceId: row.id, revision: row.revision, changes: [] };
      return created(create('checklist', data, { parentId: row.id, businessDay: day }));
    }
    case 'sync': {
      const input = object(body, ['region', 'industry']);
      const region = string(input.region, 'region', 40);
      const industry = string(input.industry, 'industry', 80);
      return grantSync(ctx, { region, industry }, options.provider.mode, await options.provider.load(region));
    }
    case 'review': {
      const input = object(body, ['expectedRevision']);
      const row = await requireRow(ctx, 'notice', id!);
      requireRevision(row, input);
      return change(row, { ...row.data, reviewStatus: 'reviewed' });
    }
    case 'apply': {
      const input = object(body, ['noticeId', 'appliedOn', 'status', 'receiptNumber', 'resultMemo']);
      const notice = await requireRow(ctx, 'notice', uuid(input.noticeId, 'notice'));
      const [prior] = await list(ctx, 'application', { ...emptyList, parentId: notice.id });
      if (prior) throw conflict('APPLICATION_EXISTS');
      const appliedOn = input.appliedOn ?? ctx.businessDay;
      if (!isDate(appliedOn) || appliedOn > ctx.businessDay) throw invalid('applied_on');
      return created(create('application', { noticeId: notice.id, title: notice.data.title, appliedOn, source: 'owner',
        status: choice(input.status ?? 'applied', 'status', statuses), ...applicationDetails(input) }, { parentId: notice.id }));
    }
    case 'edit-application': {
      const input = object(body, ['expectedRevision', 'status', 'receiptNumber', 'resultMemo']);
      const row = await requireRow(ctx, 'application', id!);
      requireRevision(row, input);
      return change(row, { ...row.data, ...applicationDetails(input, true),
        status: choice(input.status ?? row.data.status, 'status', statuses) });
    }
    case 'undo':
      object(body, []);
      return undo(ctx, id!);
  }
}

function applicationDetails(input: Data, partial = false) {
  const details: Data = {};
  for (const [field, max] of [['receiptNumber', 120], ['resultMemo', 2000]] as const) {
    if (!partial || Object.hasOwn(input, field)) details[field] = input[field] == null ? null : string(input[field], field, max, true) || null;
  }
  return details;
}
