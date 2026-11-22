import { isDeepStrictEqual } from 'node:util';
import { AGENT_COMMANDS, validateAgentCommandArgs } from '../../shared/navis-agent-schema.mjs';

const boardLayers = ['management', 'marketing'];
const pageLimit = 5;
const between = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const refused = reason => ({ outcome: 'refused', reason });
const clarify = field => ({ outcome: 'clarify', field });
const ready = args => ({ outcome: 'ready', args });
const defaultCondition = { kind: 'default' };
const supportsCondition = (entry, condition) => condition.kind === 'default'
  || entry.conditions.some(known => isDeepStrictEqual(known, condition));

function boardLookups({ intent, layer }) {
  const args = intent.args ?? {};
  const target = args.layer ?? layer;
  if (!boardLayers.includes(layer) || !boardLayers.includes(target)) return [];
  const read = page => ({ name: 'get_board', args: { layer: target, ...(page === undefined ? {} : { page }) } });
  return [
    read(args.page),
    ...(intent.command === 'layout.move_to_page' && args.destinationPage !== undefined && args.destinationPage !== args.page
      ? [read(args.destinationPage)] : []),
  ];
}

function boardProjection(input, lookup, read) {
  if (read?.status !== 'ready' || !lookup) return;
  const { layer, page } = lookup.args;
  const facts = input.readings?.find(entry => entry.tool === 'get_board'
    && entry.args.layer === layer && entry.args.page === page)?.facts;
  if (!facts?.length) return;
  const values = new Map(facts.map(({ key, value }) => [key, value]));
  if (values.size !== facts.length) return;
  const pageCount = values.get('board.pageCount');
  if (!between(pageCount, 1, pageLimit)) return;
  const selected = values.get('board.page');
  const columns = values.get('board.grid.columns');
  const rows = values.get('board.grid.rows');
  const free = values.get('board.cells.free');
  const boundPage = page ?? (layer === input.layer ? input.page : undefined);
  if (page > pageCount) return { pageCount };
  if (!between(selected, 1, pageCount) || boundPage !== undefined && selected !== boundPage
    || !between(columns, 1, 8) || !between(rows, 1, 6) || columns * rows > 40 || !between(free, 0, columns * rows)) return;
  const pages = new Map();
  for (const [key, value] of values) {
    const match = /^board\.panel\.([\w-]+)\.page$/u.exec(key);
    if (!match) continue;
    if (!between(value, 1, pageCount)) return;
    pages.set(match[1], value);
  }
  return {
    pageCount, selected, columns, rows, free, pages,
    panel(featureId) {
      if (pages.get(featureId) !== selected) return;
      const field = name => values.get(`board.panel.${featureId}.${name}`);
      const panel = { column: field('column'), row: field('row'), width: field('width'), height: field('height') };
      if (between(panel.width, 1, 4) && between(panel.height, 1, 4)
        && !boundsField(panel, { columns, rows }, 'column', 'row')) return panel;
    },
  };
}

function boundsField({ column, row, width, height }, board, horizontal, vertical) {
  if (!between(column, 0, board.columns - width)) return horizontal;
  if (!between(row, 0, board.rows - height)) return vertical;
}

function prepareAdd(args, board, input, layer) {
  const widgets = args.widgets ?? [args];
  let space = 0;
  for (const widget of widgets) {
    const { featureId, column, row, width = 1, height = 1, condition = defaultCondition } = widget;
    if (widget.layer !== undefined && widget.layer !== layer || widget.page !== undefined && widget.page !== board.selected) {
      return refused('out_of_scope');
    }
    const entry = input.catalog.find(item => item.id === featureId);
    if (entry?.layer !== layer) return refused('out_of_scope');
    if (!supportsCondition(entry, condition)) return refused('invalid_target');
    if (board.pages.has(featureId)) return refused('duplicate');
    if ((column === undefined) !== (row === undefined)) {
      return clarify(args.widgets ? 'widgets' : column === undefined ? 'column' : 'row');
    }
    const issue = boundsField({ column: column ?? 0, row: row ?? 0, width, height }, board, 'column', 'row');
    if (issue) return clarify(args.widgets ? 'widgets' : issue);
    space += width * height;
  }
  return space <= board.free ? ready(args) : refused('unavailable');
}

function prepare({ input, reads }) {
  const { command, args = {} } = input.intent;
  const lookups = boardLookups(input);
  if (!lookups.length) return refused('out_of_scope');
  if (!validateAgentCommandArgs(command, args)) return refused('invalid_target');
  const board = boardProjection(input, lookups[0], reads[0]);
  if (!board) return refused('unavailable');
  const { layer } = lookups[0].args;
  if (args.page > board.pageCount) return clarify('page');

  if (command === 'layout.add_page') return board.pageCount === pageLimit ? refused('unavailable') : ready(args);
  if (command === 'layout.start_with_three' || command === 'layout.start_with_preset') {
    const requiredLayer = command === 'layout.start_with_three' ? 'management' : 'marketing';
    if (layer !== requiredLayer) return refused('out_of_scope');
    return board.pages.size ? refused('duplicate') : ready(args);
  }
  if (command === 'layout.add_widget' || command === 'layout.add_widgets') return prepareAdd(args, board, input, layer);

  const ids = args.featureIds ?? (command === 'layout.swap_widgets' ? [args.a, args.b] : [args.featureId]);
  const targets = ids.map(id => input.catalog.find(entry => entry.id === id));
  if (targets.some(target => target?.layer !== layer)) return refused('out_of_scope');
  const acrossPages = command === 'layout.remove_widgets' && args.page === undefined;
  if (ids.some(id => acrossPages ? !board.pages.has(id) : board.pages.get(id) !== board.selected)) return refused('invalid_target');
  if (command === 'layout.remove_widget' || command === 'layout.remove_widgets') return ready(args);
  if (command === 'layout.set_condition') {
    return supportsCondition(targets[0], args.condition) ? ready(args) : clarify('condition');
  }

  const panel = board.panel(ids[0]);
  if (!panel) return refused('unavailable');
  if (command === 'layout.move_to_page') {
    const { destinationPage } = args;
    if (destinationPage === board.selected) return refused('duplicate');
    if (destinationPage > board.pageCount) return clarify('destinationPage');
    const destination = boardProjection(input, lookups[1], reads[1]);
    return destination?.pageCount === board.pageCount && destination.pages.get(ids[0]) === board.selected
      && destination.free >= panel.width * panel.height ? ready(args) : refused('unavailable');
  }
  if (command === 'layout.swap_widgets') {
    const second = board.panel(ids[1]);
    if (!second) return refused('unavailable');
    const fits = (from, to) => !boundsField({ ...from, column: to.column, row: to.row }, board, 'a', 'b');
    return fits(panel, second) && fits(second, panel) ? ready(args) : refused('invalid_target');
  }

  const isMove = command === 'layout.move_widget';
  const next = isMove ? { ...panel, column: args.column, row: args.row } : { ...panel, width: args.width, height: args.height };
  const issue = boundsField(next, board, isMove ? 'column' : 'width', isMove ? 'row' : 'height');
  if (issue) return clarify(issue);
  if (isDeepStrictEqual(panel, next)) return refused('duplicate');
  return next.width * next.height - panel.width * panel.height <= board.free ? ready(args) : refused('unavailable');
}

export const layoutAdapters = AGENT_COMMANDS.filter(command => command.startsWith('layout.'))
  .map(command => ({ command, lookups: boardLookups, prepare }));
