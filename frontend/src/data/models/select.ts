import { selectNotices } from '../iteration7/notices';
import { selectStoreEnvironment, type EnvironmentVariant } from '../iteration7/environment';
import { selectCustomOrders } from '../iteration7/custom-orders';
import { selectMemberAccounts } from '../iteration7/accounts';
import { selectMoneyRead } from '../pos/projection';
import { selectCustomOrderRead } from '../pos/projection';
/**
 * `selectWidget` (API-09 v4): pure projection of one widget from a snapshot, memoized per
 * (snapshot, featureId, normalized condition, variant) so every surface gets the same object.
 */
import type { FeatureId, QueryCondition } from '../../contracts';
import { conditionKey, defaultCondition, isDataWidgetId, normalizeCondition, type DataWidgetId } from '../conditions';
import { deepFreeze } from '../db/seed';
import type { DataSnapshot } from '../db/types';
import { findVariant, NORMAL_VARIANT, variantMessageKey } from '../preview/variants';
import { projectBriefing } from './briefing';
import { projectAiResponse, projectCommunity, projectLocalChanges, projectLocalTrends, projectTradeArea } from './local';
import { projectGrants, projectLedger, projectMargin, projectTax } from './money';
import { projectCustomerAnalysis, projectDemand, projectMemberships, projectVoiceBooking } from './customers';
import { projectFloorPlan, projectHiring, projectInterior, projectManuals } from './store';
import { projectCalendar, projectInventory, projectSuppliers } from './supply';
import { projectMenu } from '../derive/menu';
import { selectMembers } from '../derive/members';
import { ready } from './util';
import { projectStaffSchedule } from '../iteration7/staff';
import { marketingProjectors } from '../marketing/projectors';
import type { ModelMap, ModelOf, ModelReader, WidgetView } from './types';
import { emptyView, type ModelContext, type Projector } from './util';

const projectors: { readonly [F in DataWidgetId]: Projector<F> } = {
  'credit-receivable': (ctx,c,v)=>ready('credit-receivable',c,v,selectMemberAccounts(selectMoneyRead(ctx.snapshot))),
  'notice-send': (ctx,c,v)=>ready('notice-send',c,v,selectNotices(ctx.snapshot)),
  'store-environment': (ctx,c,v)=>ready('store-environment',c,v,selectStoreEnvironment(ctx.snapshot,v as EnvironmentVariant)),
  'custom-order': (ctx,c,v)=>ready('custom-order',c,v,selectCustomOrders(selectCustomOrderRead(ctx.snapshot))),
  'staff-schedule': projectStaffSchedule,
  briefing: projectBriefing, ledger: projectLedger, margin: projectMargin, tax: projectTax, grants: projectGrants,
  'customer-analysis': projectCustomerAnalysis, 'voice-booking': projectVoiceBooking,
  menu: projectMenu, members: (ctx, condition, variant) => {
    const model = selectMembers(ctx.snapshot, {});
    return model.total ? ready('members', condition, variant, model) : { status: 'empty', featureId: 'members', variant, messageKey: 'data.state.members.no-members', actionKey: 'data.management.action.addMember' };
  },
  calendar: projectCalendar, 'inventory-booking': projectInventory, suppliers: projectSuppliers, manuals: projectManuals,
  'local-changes': projectLocalChanges, 'trade-area': projectTradeArea, 'local-trends': projectLocalTrends, 'ai-response': projectAiResponse, community: projectCommunity,
  // plan-2 (DATA_MODEL 10.15.3, T-058)
  ...marketingProjectors,
};

const memo = new WeakMap<DataSnapshot, Map<string, WidgetView<unknown>>>();
const errorView = (featureId: FeatureId, variant: string, messageKey: string): WidgetView<never> => ({ status: 'error', featureId, variant, messageKey });

export function selectWidget<F extends FeatureId>(snapshot: DataSnapshot, featureId: F, condition: QueryCondition, variant: string, viewContext?: import('../derive/operations').BriefingViewContext): WidgetView<ModelOf<F>> {
  let cache = memo.get(snapshot);
  if (!cache) memo.set(snapshot, (cache = new Map()));
  const normalized = normalizeCondition(featureId, condition);
  const key = `${featureId}|${normalized.ok ? conditionKey(normalized.value) : `!${normalized.code}`}|${variant}|${featureId === 'briefing' ? JSON.stringify(viewContext ?? {}) : 'normal'}`;
  const hit = cache.get(key);
  if (hit) return hit as WidgetView<ModelOf<F>>;
  let view: WidgetView<unknown>;
  if (!isDataWidgetId(featureId)) view = errorView(featureId, variant, 'data.error.unknownWidget');
  else if (!normalized.ok) view = errorView(featureId, variant, normalized.code === 'INVALID_CONDITION' ? 'data.error.invalidCondition' : 'data.error.unsupportedCondition');
  else {
    const def = variant === NORMAL_VARIANT ? undefined : findVariant(featureId, variant);
    if (variant !== NORMAL_VARIANT && !def) view = selectWidget(snapshot, featureId, normalized.value, NORMAL_VARIANT); // unknown variant → normal
    else if (def?.mode === 'error') view = errorView(featureId, variant, variantMessageKey(featureId, variant));
    else if (def?.mode === 'empty') view = emptyView(featureId, variant, undefined, def.actionKey);
    else view = (projectors[featureId] as Projector<DataWidgetId>)(contextFor(snapshot, featureId === 'briefing' ? viewContext : undefined), normalized.value, variant);
  }
  cache.set(key, deepFreeze(view));
  return view as WidgetView<ModelOf<F>>;
}

const contexts = new WeakMap<DataSnapshot, Map<string, ModelContext>>();
function contextFor(snapshot: DataSnapshot, viewContext?: import('../derive/operations').BriefingViewContext): ModelContext {
  let cache = contexts.get(snapshot);
  if (!cache) contexts.set(snapshot, cache = new Map());
  const contextKey = JSON.stringify(viewContext ?? {});
  let ctx = cache.get(contextKey);
  if (!ctx) {
    const read: ModelReader = <R extends keyof ModelMap>(id: R): ModelMap[R] => {
      if (!isDataWidgetId(id)) return readInternalModel(snapshot, id as InternalModelId) as ModelMap[R];
      const view = selectWidget(snapshot, id, defaultCondition(id), NORMAL_VARIANT);
      if (view.status !== 'ready') throw new Error(`Normal model of ${id} is not ready`);
      return view.model as ModelMap[R];
    };
    cache.set(contextKey, (ctx = { snapshot, read, viewContext }));
  }
  return ctx;
}

/** Normal-variant ready model (convenience for non-React readers such as Navis facts). */
export function readModel<F extends DataWidgetId>(snapshot: DataSnapshot, featureId: F): ModelMap[F] {
  return contextFor(snapshot).read(featureId);
}

export type InternalModelId = 'demand' | 'memberships' | 'hiring' | 'interior' | 'floor-plan';
const internalProjectors = { demand: projectDemand, memberships: projectMemberships, hiring: projectHiring, interior: projectInterior, 'floor-plan': projectFloorPlan };
const internalMemo = new WeakMap<DataSnapshot, Map<string, unknown>>();
export function readInternalModel<F extends InternalModelId>(snapshot: DataSnapshot, id: F, condition: QueryCondition = { kind: 'default' }): ModelMap[F] {
  let cache = internalMemo.get(snapshot);
  if (!cache) internalMemo.set(snapshot, cache = new Map());
  const key = `${id}:${JSON.stringify(condition)}`;
  if (cache.has(key)) return cache.get(key) as ModelMap[F];
  const view = internalProjectors[id](contextFor(snapshot), condition, 'normal');
  if (view.status !== 'ready') throw new Error(`Internal model ${id} is unavailable`);
  const model = deepFreeze(view.model);
  cache.set(key, model);
  return model as ModelMap[F];
}
export const readDemand = (s: DataSnapshot, condition?: QueryCondition) => readInternalModel(s, 'demand', condition);
export const readMemberships = (s: DataSnapshot) => readInternalModel(s, 'memberships');
