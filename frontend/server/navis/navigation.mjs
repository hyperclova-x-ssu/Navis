import {
  AGENT_NAVIGATION_COMMANDS,
  agentNavigationIssue,
  agentNavigationRefs,
  validateAgentNavigationWireArgs,
} from '../../shared/navis-agent-schema.mjs';

function fact(projections, key) {
  const values = projections.flatMap(reading => (reading.facts ?? [])
    .filter(item => item.key === key).map(item => item.value));
  return values.length && values.every(value => value === values[0]) ? values[0] : undefined;
}

function pageValue(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 5 ? value : undefined;
}

// All facts refer to this request's browser snapshot. A page-scoped projection
// can locate a panel, while totals come only from an unpaged board projection.
export function readNavigationState(readings = []) {
  const boards = readings.filter(reading => reading.tool === 'get_board');
  const display = readings.filter(reading => reading.tool === 'get_ui_state'
    && (!reading.args.section || reading.args.section === 'display' || reading.args.section === 'pos'));
  const boardTotal = (layer, key) => fact(boards.filter(reading => reading.args.layer === layer && reading.args.page === undefined), key);
  function panelPage(layer, featureId) {
    const panelKey = `board.panel.${featureId}.page`;
    const projections = boards.filter(reading => reading.args.layer === layer && (reading.args.page === undefined
      || fact([reading], panelKey) === reading.args.page));
    const page = pageValue(fact(projections, panelKey));
    const total = pageValue(boardTotal(layer, 'board.pageCount'));
    return page && (total === undefined || page <= total) ? page : undefined;
  }
  return {
    display: key => fact(display, key),
    pageCount: layer => pageValue(boardTotal(layer, 'board.pageCount')),
    panelCount: layer => boardTotal(layer, 'board.panelCount'),
    panelPage,
  };
}

function scopeIssue(command, args, input, handles) {
  for (const field of Object.keys(args)) {
    const scoped = agentNavigationRefs(command, args, field).every(ref => {
      if (ref.slot) return input.slots.includes(ref.slot);
      return handles.get(ref.handle)?.some(scope => ref.kinds?.includes(scope.kind)
        && (field !== 'itemId' || !input.intent.querySlot || scope.querySlot === input.intent.querySlot));
    });
    if (!scoped) return field;
  }
  return undefined;
}

const clarify = (field, choices) => ({ outcome: 'clarify', field, choices });
const unavailable = () => ({ outcome: 'refused', reason: 'unavailable' });
const already = () => ({ outcome: 'reply' });

function prepareNavigation(command, { input, projection }) {
  const args = input.intent.args ?? {};
  const state = readNavigationState(input.readings);
  const pages = () => Array.from({ length: state.pageCount(input.layer) ?? 0 }, (_, index) => index + 1);
  const issue = agentNavigationIssue(command, args, true) ?? scopeIssue(command, args, input, projection.handles);
  if (issue) return clarify(issue, command === 'ui.go_to_page' && issue === 'page' ? pages() : undefined);

  const layer = args.layer ?? input.layer;
  const display = state.display;
  const placedPage = () => state.panelPage(layer, args.featureId);
  const navigate = (address = args) => ({ outcome: 'navigate', args: address });

  if (command !== 'ui.close_chat' && display('ui.busy') === 1) return unavailable();
  switch (command) {
    case 'ui.switch_layer':
      if (layer === input.layer) return already();
      return display('ui.editing') === 1 ? unavailable() : navigate();
    case 'ui.go_to_page': {
      if (layer === 'pos') return unavailable();
      const count = state.pageCount(layer);
      if (input.page === args.page) return already();
      if (count === undefined) return unavailable();
      return args.page <= count ? navigate() : clarify('page', pages());
    }
    case 'ui.show_panel': {
      const homeLayer = projection.catalog.get(args.featureId)?.layer;
      const targetLayer = args.layer ?? homeLayer ?? layer;
      if (homeLayer && homeLayer !== targetLayer || targetLayer !== input.layer && display('ui.editing') === 1) return unavailable();
      const page = state.panelPage(targetLayer, args.featureId);
      if (!page) return unavailable();
      return args.page === undefined || args.page === page ? navigate({ ...args, layer: targetLayer, page }) : clarify('page', [page]);
    }
    case 'ui.open_widget_help':
      return placedPage() === (input.page ?? 1) ? navigate() : unavailable();
    case 'ui.go_back':
      return display('ui.backAvailable') === 0 && display('ui.overlay') === 'none' ? already() : navigate();
    case 'ui.close_overlay':
      return display('ui.overlay') === 'none' ? already() : navigate();
    case 'ui.enter_layout_edit':
      return layer === 'pos' || state.panelCount(layer) === 0 ? unavailable()
        : display('ui.editing') === 1 ? already() : navigate();
    case 'ui.exit_layout_edit':
      return display('ui.editing') === 0 ? already() : navigate();
    case 'ui.open_settings':
      return args.view === 'tables' && display('ui.tablesConfigurable') === 0 ? unavailable() : navigate();
    case 'ui.set_pos_tab':
      return layer !== 'pos' || args.tab === 'tables' && display('ui.pos.tablesEnabled') === 0 ? unavailable() : navigate();
    default:
      // Detail routes do not depend on placement, and closing availability is
      // shown by the destination itself. Neither route changes the active board.
      return navigate();
  }
}

/** Register view-only intent handlers through the N01 adapter composition root. */
export const navigationAdapters = AGENT_NAVIGATION_COMMANDS.map(command => Object.freeze({
  command,
  prepare(context) {
    const result = prepareNavigation(command, context);
    if (result.outcome === 'navigate' && !validateAgentNavigationWireArgs(command, result.args)) return unavailable();
    return result;
  },
}));
