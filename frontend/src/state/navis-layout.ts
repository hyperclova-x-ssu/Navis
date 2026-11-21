import { getBusinessPreset, getLayerCatalog, getMarketingPreset, getRegistration } from '../catalog';
import type { CellPosition, CellSpan, DashboardLayerId, DashboardPage, ErrorCode, FeatureDefinition, FeatureId, LayoutIntent, Panel, QueryCondition, RunState, UndoEntry } from '../contracts';
import { isDataWidgetId, normalizeCondition } from '../data/conditions';
import { cellMask, evaluate, nearestEmptyRect, preview, readingOrder, samePanels } from '../layout';

export const PAGE_LIMIT = 5;

export type NavisLayoutStep =
  | { readonly kind: 'layout'; readonly page: number; readonly intent: Exclude<LayoutIntent, { type: 'starter' | 'restore' }> }
  | { readonly kind: 'transfer'; readonly page: number; readonly destinationPage: number; readonly featureId: FeatureId }
  | { readonly kind: 'condition'; readonly page: number; readonly featureId: FeatureId; readonly condition: QueryCondition }
  | { readonly kind: 'swap'; readonly page: number; readonly a: FeatureId; readonly b: FeatureId }
  | { readonly kind: 'starter'; readonly page: number }
  | { readonly kind: 'append' };

export interface NavisLayoutPlan {
  readonly runId: string;
  readonly layoutRevision: number;
  readonly originLayer: DashboardLayerId;
  readonly originPage: number;
  readonly layer: DashboardLayerId;
  readonly previousPages: readonly DashboardPage[];
  readonly previousPage: number;
  readonly pages: readonly (readonly Panel[])[];
  readonly page: number;
  readonly undoKind: UndoEntry['kind'] | null;
  readonly featureId?: FeatureId;
  readonly displaced: readonly FeatureId[];
}

type PlanRejection = { readonly kind: 'invalid' | 'unchanged'; readonly code?: ErrorCode | 'UNSUPPORTED_CONDITION'; readonly featureId?: FeatureId; readonly page?: number };
export type NavisLayoutResult = { readonly kind: 'ready'; readonly plan: NavisLayoutPlan } | PlanRejection;

export function readNavisBoard(state: RunState, layer: DashboardLayerId, index = state.boards[layer].currentPage) {
  const board = state.boards[layer];
  const page = board.pages[index];
  if (!page) return undefined;
  const grid = state.screenPreset.grid;
  const occupied = page.panels.reduce((mask, panel) => mask | cellMask(panel, grid), 0n);
  const emptyCells: CellPosition[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      if (!(occupied & (1n << BigInt(row * grid.columns + column)))) emptyCells.push({ column, row });
    }
  }
  return {
    ...grid, layer, activeLayer: state.activeBoard, page: index, currentPage: board.currentPage, pageCount: board.pages.length,
    free: emptyCells.length, emptyCells, panels: readingOrder(page.panels),
    placements: board.pages.flatMap((entry, page) => entry.panels.map(panel => ({ panel, page }))),
  };
}

/** Resolve each step against a private copy. A rejected step discards the entire plan. */
export function planNavisLayout(
  state: RunState, layer: DashboardLayerId, steps: readonly NavisLayoutStep[], focusPage?: number,
  catalog: readonly FeatureDefinition[] = getLayerCatalog(state.screenPreset.id, layer),
): NavisLayoutResult {
  const board = state.boards[layer];
  const grid = state.screenPreset.grid;
  const pages = board.pages.map(page => page.panels);
  const displaced = new Set<FeatureId>();
  let undoKind: NavisLayoutPlan['undoKind'] = null;
  let featureId: FeatureId | undefined;
  const reject = (code: PlanRejection['code'], id?: FeatureId, page?: number): PlanRejection => ({ kind: 'invalid', code, featureId: id, page });
  const unchanged = (id?: FeatureId, page?: number, code?: PlanRejection['code']): PlanRejection => ({ kind: 'unchanged', code, featureId: id, page });
  const locate = (featureId: FeatureId) => pages.findIndex(panels => panels.some(panel => panel.featureId === featureId));
  const marked = (kind: UndoEntry['kind'], id?: FeatureId) => {
    if (!undoKind) {
      undoKind = kind;
      featureId = id;
    }
  };

  for (const step of steps) {
    if (step.kind === 'append') {
      if (pages.length >= PAGE_LIMIT) return reject('PAGE_LIMIT');
      pages.push([]);
      continue;
    }
    const before = pages[step.page];
    if (!before) return reject('NO_NEIGHBOR_PAGE', undefined, step.page);
    const id = step.kind === 'layout' ? step.intent.featureId : step.kind === 'swap' ? step.a : step.kind === 'starter' ? undefined : step.featureId;
    if (id && getRegistration(id)?.layer !== layer) return reject('OTHER_LAYER', id);
    if (step.kind === 'starter') {
      if (pages.some(panels => panels.length) || board.starter === 'running') return unchanged();
      const panels = layer === 'management'
        ? getBusinessPreset(state.businessType, layer).starterIds.map((featureId, column) => ({ featureId, column, row: 0, width: 1, height: 1 }))
        : getMarketingPreset(state.businessType);
      const checked = evaluate(panels.map(panel => ({ ...panel, condition: { kind: 'default' } })), grid, catalog);
      if (!checked.valid) return reject(checked.code);
      pages[step.page] = checked.panels;
      marked('starter-add');
      continue;
    }
    if (step.kind === 'swap') {
      const a = before.find(panel => panel.featureId === step.a);
      const b = before.find(panel => panel.featureId === step.b);
      if (!a || !b || a === b) return unchanged(!a ? step.a : step.b);
      const swapped = before.map(panel => panel === a ? { ...a, column: b.column, row: b.row } : panel === b ? { ...b, column: a.column, row: a.row } : panel);
      const checked = evaluate(swapped, grid, catalog);
      if (!checked.valid) return reject(checked.code, a.featureId);
      pages[step.page] = checked.panels;
      marked('move', a.featureId);
      continue;
    }
    if (step.kind === 'condition') {
      const target = before.find(panel => panel.featureId === step.featureId);
      if (!target) return unchanged(step.featureId);
      const result = normalizeCondition(step.featureId, step.condition);
      if (!result.ok) return reject('UNSUPPORTED_CONDITION', step.featureId);
      const after = before.map(panel => panel === target ? { ...target, condition: result.value } : panel);
      if (samePanels(before, after)) return unchanged(step.featureId, step.page);
      pages[step.page] = after;
      marked('move', step.featureId);
      continue;
    }
    if (step.kind === 'transfer') {
      const origin = before.find(panel => panel.featureId === step.featureId);
      if (!origin) return unchanged(step.featureId);
      if (step.destinationPage === step.page) return unchanged(step.featureId, step.page);
      const destination = pages[step.destinationPage];
      if (!destination) return reject('NO_NEIGHBOR_PAGE', step.featureId, step.destinationPage);
      const spot = nearestEmptyRect(destination, grid, origin.width, origin.height, origin.column, origin.row) ?? origin;
      const result = preview(destination, {
        type: 'add-ai', featureId: origin.featureId, column: spot.column, row: spot.row,
        width: origin.width as CellSpan, height: origin.height as CellSpan, condition: origin.condition ?? { kind: 'default' },
      }, grid, catalog);
      if (result.status !== 'accepted') return reject(result.code, step.featureId, step.destinationPage);
      pages[step.page] = before.filter(panel => panel !== origin);
      pages[step.destinationPage] = result.panels;
      result.displacements.forEach(item => displaced.add(item.featureId));
      marked('move-page', step.featureId);
      continue;
    }
    const { intent } = step;
    const adding = intent.type.startsWith('add-');
    const found = locate(intent.featureId);
    if (adding && found >= 0) return unchanged(intent.featureId, found, 'DUPLICATE');
    if (!adding && found !== step.page) return unchanged(intent.featureId);
    if ('condition' in intent && intent.condition && isDataWidgetId(intent.featureId) && !normalizeCondition(intent.featureId, intent.condition).ok) {
      return reject('UNSUPPORTED_CONDITION', intent.featureId);
    }
    const result = preview(before, intent, grid, catalog);
    if (result.status === 'rejected') return reject(result.code, intent.featureId, step.page);
    if (result.status !== 'accepted') return unchanged(intent.featureId, step.page, result.code);
    pages[step.page] = result.panels.map(panel => adding && panel.featureId === intent.featureId && !panel.condition
      ? { ...panel, condition: { kind: 'default' } } : panel);
    result.displacements.forEach(item => displaced.add(item.featureId));
    marked(adding ? 'add' : intent.type === 'remove' ? 'remove' : intent.type === 'resize' ? 'resize' : 'move', intent.featureId);
  }

  const page = focusPage ?? board.currentPage;
  if (!pages[page]) return reject('NO_NEIGHBOR_PAGE', undefined, page);
  if (pages.length === board.pages.length && pages.every((panels, index) => samePanels(panels, board.pages[index].panels))) return unchanged();
  return { kind: 'ready', plan: {
    runId: state.runId, layoutRevision: state.layoutRevision, originLayer: state.activeBoard,
    originPage: state.boards[state.activeBoard].currentPage, layer,
    previousPages: board.pages, previousPage: board.currentPage, pages, page, undoKind, featureId, displaced: [...displaced],
  } };
}
