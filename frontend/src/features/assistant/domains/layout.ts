import { getLayerCatalog, getRegistration, getRegistry } from '../../../catalog';
import type { CellPosition, CellSpan, DashboardLayerId, FeatureId, Locale, Panel, QueryCondition, RunState } from '../../../contracts';
import { addDays, TODAY } from '../../../data/db/time';
import { planNavisLayout, readNavisBoard, type NavisLayoutPlan, type NavisLayoutResult, type NavisLayoutStep } from '../../../state/navis-layout';
import { validateAgentCommandArgs, type AgentFact, type AgentKnownCommand, type AgentReadArgs, type AgentReadProjection, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import type { AgentProposalPreview } from '../navis-conversation';
import type { DomainAdapter, DomainRoute, DomainTurnInput, ReadToolAdapter, RunCommandAdapter, RunPreflight } from './registry';

const commands = [
  'layout.add_widget', 'layout.add_widgets', 'layout.remove_widget', 'layout.remove_widgets',
  'layout.move_widget', 'layout.resize_widget', 'layout.move_to_page', 'layout.add_page',
  'layout.swap_widgets', 'layout.set_condition', 'layout.start_with_three', 'layout.start_with_preset',
] as const satisfies readonly AgentKnownCommand[];
type LayoutCommand = typeof commands[number];
interface WidgetDraft {
  readonly featureId: FeatureId;
  readonly layer?: DashboardLayerId;
  readonly page?: number;
  readonly column?: number;
  readonly row?: number;
  readonly width?: CellSpan;
  readonly height?: CellSpan;
  readonly condition?: QueryCondition;
}
interface LayoutDraft extends Partial<WidgetDraft> {
  readonly destinationPage?: number;
  readonly widgets?: readonly WidgetDraft[];
  readonly featureIds?: readonly FeatureId[];
  readonly a?: FeatureId;
  readonly b?: FeatureId;
}

const asWire = ({ widgets, ...draft }: LayoutDraft): AgentWireArgs => widgets ? { ...draft, widgets: widgets.map(widget => ({ ...widget })) } : draft;
const phrase = (locale: Locale, ko: string, en: string, hans: string, hant = hans) =>
  ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
const name = (id: FeatureId, locale: Locale) => {
  const registration = getRegistration(id)!;
  return navisTranslator(locale).t(registration.nameKey);
};
const layerName = (layer: DashboardLayerId, locale: Locale) => navisTranslator(locale).t(`app.layer.${layer}`);
const pageLabel = (page: number, locale: Locale) => phrase(locale, `${page + 1}페이지`, `Page ${page + 1}`, `第 ${page + 1} 页`, `第 ${page + 1} 頁`);
const location = ({ row, column }: CellPosition, locale: Locale) => phrase(locale,
  `${row + 1}행 ${column + 1}열`, `Row ${row + 1}, column ${column + 1}`, `第 ${row + 1} 行第 ${column + 1} 列`);
const sizeLabel = (panel: Pick<Panel, 'width' | 'height'>) => `${panel.width}x${panel.height}`;
const conditionLabel = (condition: QueryCondition | undefined, locale: Locale) => condition?.kind === 'dateRange'
  ? `${condition.start}–${condition.end}` : condition?.kind === 'snapshot' ? condition.asOf : phrase(locale, '기본', 'Default', '默认', '預設');
const quantity = (n: number, locale: Locale) => phrase(locale, `${n}칸`, `${n} cells`, `${n} 格`);
const count = (n: number, locale: Locale) => phrase(locale, `${n}개`, String(n), `${n} 个`, `${n} 個`);
const empty = (locale: Locale) => phrase(locale, '비어 있어요', 'Empty', '空白', '空白');
const absent = (locale: Locale) => phrase(locale, '보드에 없어요', 'Off the board', '未放在看板上');
const noRoom = (locale: Locale) => phrase(locale, '자리가 없어요', 'There is no room', '没有空位', '沒有空位');
const fact = (key: string, value: AgentFact['value'], label: string, display = String(value), unit = 'text'): AgentFact => ({ key, value, unit, label, display });

export function projectNavisBoard(state: RunState | undefined, args: AgentReadArgs['get_board'], locale: Locale): Extract<AgentReadProjection, { tool: 'get_board' }> {
  const board = state && args.layer !== 'pos' ? readNavisBoard(state, args.layer, args.page === undefined ? undefined : args.page - 1) : undefined;
  const base = { tool: 'get_board' as const, args };
  if (!board) return { ...base, status: 'unavailable' };
  const label = layerName(board.layer, locale);
  return { ...base, facts: [
    fact('board.layer', board.layer, label, label),
    fact('board.activeLayer', board.activeLayer, phrase(locale, '현재 보드', 'Active board', '当前看板', '目前看板'), layerName(board.activeLayer, locale)),
    fact('board.page', board.page + 1, label, pageLabel(board.page, locale), 'page'),
    fact('board.currentPage', board.currentPage + 1, label, pageLabel(board.currentPage, locale), 'page'),
    fact('board.pageCount', board.pageCount, label, pageLabel(board.pageCount - 1, locale), 'page'),
    fact('board.grid.columns', board.columns, phrase(locale, '가로', 'Columns', '列'), quantity(board.columns, locale), 'cell'),
    fact('board.grid.rows', board.rows, phrase(locale, '세로', 'Rows', '行'), quantity(board.rows, locale), 'cell'),
    fact('board.cells.free', board.free, phrase(locale, '남은 자리', 'Free space', '剩余空位', '剩餘空位'), quantity(board.free, locale), 'cell'),
    fact('board.cells.positions', board.emptyCells.map(({ row, column }) => `${column},${row}`).join(' '),
      phrase(locale, '빈 칸', 'Free cells', '空格'), quantity(board.free, locale)),
    ...board.placements.flatMap(({ panel, page }) => {
      const key = `board.panel.${panel.featureId}`, label = name(panel.featureId, locale);
      return [fact(`${key}.page`, page + 1, label, pageLabel(page, locale), 'page'), ...(page === board.page ? [
        fact(`${key}.column`, panel.column, label, String(panel.column), 'cell'),
        fact(`${key}.row`, panel.row, label, String(panel.row), 'cell'),
        fact(`${key}.width`, panel.width, label, String(panel.width), 'cell'),
        fact(`${key}.height`, panel.height, label, String(panel.height), 'cell'),
        fact(`${key}.condition`, JSON.stringify(panel.condition ?? { kind: 'default' }), label, conditionLabel(panel.condition, locale)),
      ] : [])];
    }),
  ] };
}

const boardTool: ReadToolAdapter<'get_board'> = {
  tool: 'get_board',
  read(_snapshot, args, locale, slots, _targets, run) {
    const projection = projectNavisBoard(run, args, locale);
    if ('status' in projection || !run || args.layer === 'pos' || !slots.boardQuestion) return projection;
    const board = readNavisBoard(run, args.layer, args.page === undefined ? undefined : args.page - 1)!;
    const label = layerName(board.layer, locale);
    if (slots.boardQuestion === 'free') return { facts: projection.facts.filter(item => item.key === 'board.cells.free') };
    if (slots.boardQuestion === 'pages') return { facts: (['management', 'marketing'] as const).map(layer => {
      const count = run.boards[layer].pages.length;
      return fact(`board.${layer}.pageCount`, count, layerName(layer, locale), pageLabel(count - 1, locale), 'page');
    }) };
    if (slots.boardQuestion === 'unplaced') {
      const placed = new Set(board.placements.map(({ panel }) => panel.featureId));
      const missing = getLayerCatalog(run.screenPreset.id, board.layer).filter(widget => !placed.has(widget.id));
      return { facts: missing.length ? missing.map(widget => fact(`board.unplaced.${widget.id}`, widget.id, name(widget.id, locale), absent(locale)))
        : [fact('board.unplaced', 0, label, phrase(locale, '안 놓은 위젯이 없어요', 'Every widget is placed', '已放置所有组件', '已放置所有小工具'))] };
    }
    if (slots.boardQuestion === 'widget') {
      const target = board.placements.find(item => item.panel.featureId === slots.boardFeature);
      const id = typeof slots.boardFeature === 'string' ? getRegistration(slots.boardFeature)?.id : undefined;
      if (!id) return { status: 'missing' };
      return { facts: [fact(`board.panel.${id}.summary`, target?.page ?? -1, name(id, locale), target
        ? `${sizeLabel(target.panel)} · ${location(target.panel, locale)}${target.page === board.page ? '' : ` · ${pageLabel(target.page, locale)}`}` : absent(locale))] };
    }
    return { facts: board.panels.length ? board.panels.map(panel => fact(`board.panel.${panel.featureId}.summary`, panel.featureId,
      name(panel.featureId, locale), `${sizeLabel(panel)} · ${location(panel, locale)}`)) : [fact('board.empty', 0, label, empty(locale))] };
  },
};

function placement(run: RunState, layer: DashboardLayerId, featureId: FeatureId | undefined) {
  if (!featureId) return undefined;
  return run.boards[layer].pages.flatMap((page, index) => page.panels.filter(panel => panel.featureId === featureId).map(panel => ({ panel, index })))[0];
}

function draftAddress(command: LayoutCommand, draft: LayoutDraft, run: RunState) {
  const layer = draft.layer ?? (command === 'layout.start_with_preset' ? 'marketing' : command === 'layout.start_with_three' ? 'management' : run.activeBoard);
  const board = run.boards[layer];
  const featureId = draft.featureId ?? draft.featureIds?.[0] ?? draft.a;
  const existing = placement(run, layer, featureId);
  const useExisting = !['layout.add_widget', 'layout.add_widgets', 'layout.add_page', 'layout.start_with_three', 'layout.start_with_preset'].includes(command);
  const page = draft.page !== undefined ? draft.page - 1 : (useExisting ? existing?.index : undefined) ?? board.currentPage;
  return { layer, board, page, featureId, existing };
}

function prepareLayout(command: LayoutCommand, draft: LayoutDraft, run: RunState): NavisLayoutResult {
  const { layer, board, page } = draftAddress(command, draft, run);
  if (draft.widgets?.some(widget => widget.layer && widget.layer !== layer || widget.page !== undefined && widget.page !== page + 1)) {
    return { kind: 'invalid', code: 'INVALID_POSITION' } as const;
  }
  const featureId = draft.featureId!;
  const add = (widget: WidgetDraft): NavisLayoutStep => {
    const { featureId, width = 1, height = 1, column, row, condition = { kind: 'default' } } = widget;
    return { kind: 'layout', page, intent: column === undefined || row === undefined
      ? { type: 'add-candidate-tap', featureId, width, height, condition }
      : { type: 'add-ai', featureId, width, height, column, row, condition } };
  };
  const steps: readonly NavisLayoutStep[] = command === 'layout.add_widgets' ? draft.widgets!.map(add)
    : command === 'layout.remove_widgets' ? draft.featureIds!.map(featureId => ({ kind: 'layout', page: draft.page !== undefined ? page : placement(run, layer, featureId)?.index ?? page, intent: { type: 'remove', featureId } }))
    : [((): NavisLayoutStep => {
      switch (command) {
        case 'layout.add_widget': return add({ ...draft, featureId });
        case 'layout.remove_widget': return { kind: 'layout', page, intent: { type: 'remove', featureId } };
        case 'layout.move_widget': return { kind: 'layout', page, intent: { type: 'move', featureId, column: draft.column!, row: draft.row! } };
        case 'layout.resize_widget': return { kind: 'layout', page, intent: { type: 'resize', featureId, width: draft.width!, height: draft.height! } };
        case 'layout.move_to_page': return { kind: 'transfer', page, featureId, destinationPage: draft.destinationPage! - 1 };
        case 'layout.set_condition': return { kind: 'condition', page, featureId, condition: draft.condition! };
        case 'layout.swap_widgets': return { kind: 'swap', page, a: draft.a!, b: draft.b! };
        case 'layout.add_page': return { kind: 'append' };
        case 'layout.start_with_three': case 'layout.start_with_preset': return { kind: 'starter', page };
      }
    })()];
  const focus = command === 'layout.move_to_page' ? draft.destinationPage! - 1 : command === 'layout.add_page' ? board.pages.length : undefined;
  return planNavisLayout(run, layer, steps, focus);
}

function previewFor(command: LayoutCommand, draft: LayoutDraft, plan: NavisLayoutPlan, locale: Locale, businessDate: string): AgentProposalPreview {
  const layer = layerName(plan.layer, locale);
  const featureIds = draft.widgets?.map(widget => widget.featureId) ?? draft.featureIds ?? (draft.a && draft.b ? [draft.a, draft.b] : draft.featureId ? [draft.featureId] : []);
  const old = plan.previousPages.flatMap((entry, page) => entry.panels.map(panel => ({ panel, page })));
  const next = plan.pages.flatMap((panels, page) => panels.map(panel => ({ panel, page })));
  const removing = command === 'layout.remove_widget' || command === 'layout.remove_widgets';
  const title = removing ? phrase(locale, `${featureIds.map(id => name(id, locale)).join(' · ')} 뺄까요?`, 'Remove widgets?', '移除组件？', '移除小工具？')
    : command === 'layout.swap_widgets' ? phrase(locale, '두 위젯의 자리를 바꿀까요?', 'Swap the widgets?', '交换两个组件的位置？', '交換兩個小工具的位置？')
    : phrase(locale, `${layer} 보드를 바꿀까요?`, `Change the ${layer} board?`, `更改${layer}看板？`);
  const panelLabel = (placed: typeof old[number] | undefined) => placed
    ? `${pageLabel(placed.page, locale)} · ${sizeLabel(placed.panel)} · ${location(placed.panel, locale)}` : absent(locale);
  const fields = [...featureIds, ...plan.displaced.filter(id => !featureIds.includes(id))].map(id => {
    const before = old.find(item => item.panel.featureId === id), after = next.find(item => item.panel.featureId === id);
    const movedAside = plan.displaced.includes(id) && !featureIds.includes(id);
    const condition = command === 'layout.set_condition';
    const previous = condition ? conditionLabel(before?.panel.condition, locale) : panelLabel(before);
    let updated = condition ? conditionLabel(after?.panel.condition, locale) : panelLabel(after);
    if (condition && after?.panel.condition?.kind === 'dateRange' && after.panel.condition.end === businessDate && after.panel.condition.start === addDays(businessDate, -6)) {
      updated = `${phrase(locale, '최근 7일', 'Last 7 days', '最近 7 天')} · ${updated}`;
    }
    return { label: name(id, locale), before: previous, after: movedAside ? `${updated} · ${phrase(locale, '비켜요', 'Moves aside', '移开', '移開')}` : updated };
  });
  if (removing && !next.length) fields[fields.length - 1].after = phrase(locale, '마지막 위젯을 빼요', 'Removes the last widget', '移除最后一个组件', '移除最後一個小工具');
  if (command === 'layout.add_page') fields.push({ label: layer, before: pageLabel(plan.previousPages.length - 1, locale),
    after: `${pageLabel(plan.pages.length - 1, locale)} · ${phrase(locale, '되돌릴 수 없어요', 'Cannot be undone', '无法撤销', '無法復原')}` });
  if (command === 'layout.start_with_three' || command === 'layout.start_with_preset') {
    const names = next.map(({ panel }) => name(panel.featureId, locale)).join(' · ');
    fields.push({ label: count(next.length, locale), before: empty(locale), after: names });
  }
  return { title, target: featureIds[0] ? name(featureIds[0], locale) : layer, fields };
}

const runCommands = commands.map((command): RunCommandAdapter<{ readonly locale: Locale; readonly args: LayoutDraft }, AgentProposalPreview> => ({
  command, slots: {},
  resolve(value, slots) {
    return validateAgentCommandArgs(command, value) ? { args: value as LayoutDraft, locale: (slots.navisLocale as Locale | undefined) ?? 'ko' } : undefined;
  },
  preflight({ args, locale }, { run, snapshot }): RunPreflight<AgentProposalPreview> {
    const result = prepareLayout(command, args, run);
    if (result.kind !== 'ready') return { kind: result.kind };
    const { plan } = result;
    return { kind: 'ready', preview: previewFor(command, args, plan, locale, snapshot.pos?.businessDate ?? TODAY), execute(store) {
      const applied = store.actions.commitNavisLayout(plan);
      if (applied.status !== 'accepted') return { kind: applied.status === 'unchanged' ? 'unchanged'
        : applied.code === 'STALE_REVISION' ? 'conflict' : applied.code === 'CANCELLED' ? 'busy' : 'invalid' };
      if (!plan.undoKind || plan.layer === plan.originLayer) return { kind: 'applied' };
      const token = store.getState().boards[plan.layer].undo?.token;
      return { kind: 'applied', ...(token ? { undo: current => current.actions.undo(token).status === 'accepted' } : {}) };
    } };
  },
}));

const layoutVerb = {
  add: /추가|넣어|놓아|놔|올려|깔아|\b(?:add|place|put)\b/iu,
  remove: /빼\s*(?:줘|주세요)|빼고|빼기|제거|지워|(?:위젯|패널).*삭제|\bremove\b/iu,
  move: /옮겨|옮기|자리\s*바꿔|페이지로\s*보내|\bmove\b/iu,
  resize: /크게|작게|키워|줄여|늘려|(?:가로|세로)\s*\d+\s*칸|\d\s*[x×]\s*\d|\bresize\b/iu,
  starter: /추천.*(?:채워|배치.*시작)|\b(?:starter|recommended) layout\b/iu,
};
const surface = /위젯|패널|보드|대시보드|화면에|\b(?:widget|panel|board|dashboard)s?\b/iu;
const conditionRequest = /최근\s*(?:7|일곱)\s*일\s*기준|last 7 days.*(?:board|widget)/iu;
const boardRead = /보드에\s*(?:뭐|무엇)|(?:관리|마케팅)\s*화면에(?:는)?\s*(?:뭐|무엇)|몇\s*페이지까지|자리\s*몇\s*칸|(?:위젯|패널)\s*(?:크기|어디)|안\s*놓은\s*(?:위젯|패널)/u;
const pageCount = (text: string) => text.match(/(\d+)\s*페이지|페이지\s*(\d+)|\bpage\s+(\d+)/iu)?.slice(1).find(Boolean);
const pageAppend = (text: string) => /^(?:(?:관리|마케팅)\s*)?(?:(?:새|빈)\s*)?페이지\s*(?:한\s*장|하나|또)?\s*(?:추가|만들)|^add (?:a )?page\b/iu.test(text);
export function isNavisLayoutNavigationConflict(text: string): boolean {
  return boardRead.test(text) || pageAppend(text) || !!pageCount(text) &&
    (layoutVerb.move.test(text) || layoutVerb.add.test(text) && surface.test(text));
}
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
const couponChoices = ['slot-coupon', 'expiry-coupon', 'coupon-status'] as const;

function findFeatures(text: string, run: RunState, locale: Locale): FeatureId[] {
  const value = normalized(text), translator = navisTranslator(locale);
  const candidates = getRegistry(run.screenPreset.id).flatMap(entry => {
    const terms = [entry.label, translator.t(entry.nameKey), ...entry.aliases, ...translator.t(entry.aliasesKey).split('|')];
    return terms.flatMap(term => {
      const key = normalized(term), index = key.length > 1 ? value.indexOf(key) : -1;
      return index < 0 || key === '쿠폰' ? [] : [{ id: entry.id, index, length: key.length }];
    });
  }).sort((a, b) => a.index - b.index || b.length - a.length);
  const chosen: typeof candidates = [];
  for (const candidate of candidates) if (!chosen.some(prior => prior.id === candidate.id || prior.index + prior.length > candidate.index)) chosen.push(candidate);
  return chosen.map(item => item.id);
}

function routeLayout(
  raw: string, snapshot: { readonly pos?: { readonly businessDate: string } | null }, locale: Locale, run?: RunState,
): DomainRoute | undefined {
  if (!run || run.screen !== 'dashboard' || run.layer === 'orders-payment') return undefined;
  const text = raw.normalize('NFKC').trim();
  if (/(?:추가|넣|옮기|빼|지우|키우|삭제).{0,9}(?:하지\s*마|말아|지\s*마|지\s*말)|\b(?:do not|don't|never)\b/iu.test(text)) return undefined;
  if (/(?:이전|기존|모든|앞선)\s*(?:지시|규칙|명령).*무시|ignore\s+(?:all\s+|previous\s+)?(?:instructions|rules)/iu.test(text)) return undefined;
  if (/(?:뭐|무엇|어떤|어느).{0,20}(?:좋아|추천|할까)|\b(?:which|what|how)\b.*\b(?:add|put|place)\b/iu.test(text)) return undefined;
  const active = run.activeBoard;
  const marketing = /마케팅\s*(?:보드|화면|레이어|탭|쪽에|에|으로|추천)|\b(?:on|to) (?:the )?marketing\b/iu.exec(text);
  const management = /관리\s*(?:보드|화면|레이어|탭|쪽에|에|로|추천)|\b(?:on|to) (?:the )?management\b/iu.exec(text);
  const explicit: DashboardLayerId | undefined = marketing ? 'marketing' : management ? 'management' : undefined;
  const layer = explicit ?? active, board = run.boards[layer];
  const addressText = (marketing ?? management)?.[0];
  const ids = findFeatures(addressText ? text.replace(addressText, ' ') : text, run, locale), featureId = ids[0];
  const current = placement(run, layer, featureId);
  const namedPage = pageCount(text);
  const page = namedPage === undefined ? undefined : Number(namedPage);
  const target = featureId ? name(featureId, locale) : '';
  const tr = navisTranslator(locale);
  const answer = (answer: string): DomainRoute => ({ kind: 'answer', answer });
  const clarify = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute => ({ kind: 'clarification', field, answer, resume });
  const invalidSize = phrase(locale, '크기는 1~4칸이에요', 'Each side can be 1–4 cells', '边长为 1–4 格', '邊長為 1–4 格');
  const askSize = phrase(locale, `${target} 크기를 골라 주세요`, `Choose a size for ${target}`, `请选择${target}的尺寸`, `請選擇${target}的尺寸`);
  const position = (from: Panel | undefined): CellPosition | undefined => {
    if (/맨\s*아래\s*(?:의\s*)?왼쪽|bottom left/iu.test(text)) return { column: 0, row: run.screenPreset.grid.rows - (from?.height ?? 1) };
    const placed = ids[1] && placement(run, layer, ids[1]);
    if (placed && /자리(?:에|로)/u.test(text)) return placed.panel;
    const col = text.match(/(\d+)\s*열/u), row = text.match(/(\d+)\s*행/u);
    if (col || row) return { column: col ? Number(col[1]) - 1 : from?.column ?? 0, row: row ? Number(row[1]) - 1 : from?.row ?? 0 };
    if (!from) return undefined;
    if (/그대로|같은\s*자리/u.test(text)) return from;
    const relative = text.match(/(오른쪽|왼쪽|아래|위)(?:으?로)?\s*(한|두|세|네|\d+)\s*칸/u);
    if (!relative) return undefined;
    const distance = ({ 한: 1, 두: 2, 세: 3, 네: 4 } as Record<string, number>)[relative[2]] ?? Number(relative[2]);
    return { column: from.column + (relative[1] === '오른쪽' ? distance : relative[1] === '왼쪽' ? -distance : 0),
      row: from.row + (relative[1] === '아래' ? distance : relative[1] === '위' ? -distance : 0) };
  };
  const dimensions = text.match(/(\d+)\s*[x×]\s*(\d+)/iu), horizontal = text.match(/가로\s*(\d+)\s*칸/u), vertical = text.match(/세로\s*(\d+)\s*칸/u);
  const span = (current: Panel | undefined) => ({ width: Number(dimensions?.[1] ?? horizontal?.[1] ?? current?.width ?? 1) as CellSpan,
    height: Number(dimensions?.[2] ?? vertical?.[1] ?? current?.height ?? 1) as CellSpan });
  const address: Pick<LayoutDraft, 'layer'> = explicit ? { layer: explicit } : {};
  const moveFailure = () => {
    if (!featureId) return clarify('featureId', phrase(locale, '어느 패널을 옮길까요?', 'Which widget should move?', '要移动哪个组件？', '要移動哪個小工具？'));
    const registered = getRegistration(featureId)!;
    return answer(registered.layer === layer ? `${target} ${absent(locale)}` : tr.t('page.inOtherLayer', { name: target, layer: layerName(registered.layer, locale) }));
  };
  const turn = (command: LayoutCommand, draft: LayoutDraft): DomainRoute => {
    const { layer, board, page: resolvedPage, existing } = draftAddress(command, draft, run);
    const args = draft.page === undefined && resolvedPage !== board.currentPage ? { ...draft, page: resolvedPage + 1 } : draft;
    if (!validateAgentCommandArgs(command, asWire(args))) return { kind: 'refusal', reason: 'invalid_target', answer: tr.t('common.navis.agent.invalid') };
    const prepared = prepareLayout(command, args, run);
    if (prepared.kind !== 'ready') {
      const label = prepared.featureId ? name(prepared.featureId, locale) : target;
      if (prepared.code === 'DUPLICATE') return answer(prepared.page === (page === undefined ? board.currentPage : page - 1)
        ? tr.t('navis.card.placed', { name: label })
        : `${label} ${tr.t('page.alreadyOn', { n: (prepared.page ?? 0) + 1 })}${page === undefined ? '' : `\n${phrase(locale, '옮길까요?', 'Move it?', '要移动吗？', '要移動嗎？')}`}`);
      if (prepared.code === 'OTHER_LAYER' && prepared.featureId) return answer(tr.t('page.inOtherLayer', { name: label, layer: layerName(getRegistration(prepared.featureId)!.layer, locale) }));
      if (prepared.code === 'PAGE_LIMIT') return answer(tr.t('page.limit'));
      if (prepared.code === 'NO_CAPACITY') return answer(command === 'layout.move_to_page'
        ? phrase(locale, '옆 페이지에 자리가 없어요', 'There is no room on that page', '该页没有空位', '該頁沒有空位') : noRoom(locale));
      if (command === 'layout.start_with_three' || command === 'layout.start_with_preset') return answer(phrase(locale, '이미 패널이 있어요', 'The board already has widgets', '看板上已有组件', '看板上已有小工具'));
      if (prepared.code === 'OUTSIDE_GRID' && command === 'layout.resize_widget') return clarify('alternative', phrase(locale,
        `${label} 오른쪽 끝에 있어요. 다른 크기를 골라 주세요`, `${label} is at the right edge. Choose another size`, `${label}在右侧边缘，请选择其他尺寸`, `${label}在右側邊緣，請選擇其他尺寸`));
      if (prepared.code === 'UNSUPPORTED_CONDITION') return answer(tr.t('common.navis.agent.unsupportedPeriod'));
      if (prepared.code === 'NO_NEIGHBOR_PAGE') return clarify('confirmAddPage', phrase(locale, `${page}페이지가 없어요. 새 페이지를 만들까요?`, `Page ${page} does not exist. Add a page?`, `第 ${page} 页不存在，要添加一页吗？`, `第 ${page} 頁不存在，要新增一頁嗎？`),
        () => turn('layout.add_page', address));
      if (prepared.kind === 'unchanged' && existing) {
        if (command === 'layout.move_to_page') return answer(phrase(locale, `${label} ${existing.index + 1}페이지에 있어요`, `${label} is on page ${existing.index + 1}`, `${label}在第 ${existing.index + 1} 页`, `${label}在第 ${existing.index + 1} 頁`));
        const value = command === 'layout.resize_widget' ? sizeLabel(existing.panel) : location(existing.panel, locale);
        return answer(phrase(locale, `${label} 이미 ${value}이에요`, `${label} is already ${value}`, `${label}已经是${value}`, `${label}已經是${value}`));
      }
      return answer(prepared.kind === 'unchanged' ? `${label} ${absent(locale)}` : tr.t('common.navis.agent.invalid'));
    }
    const source = { layer, ...(args.page === undefined ? {} : { page: args.page }) };
    const additionalReadings = [projectNavisBoard(run, source, locale)];
    if (command === 'layout.move_to_page' && args.destinationPage !== undefined) {
      additionalReadings.push(projectNavisBoard(run, { layer, page: args.destinationPage }, locale));
    }
    return { intent: { kind: 'command', command, args: asWire(args) }, page: run.boards[run.activeBoard].currentPage + 1, additionalReadings };
  };

  if (boardRead.test(text)) {
    const boardQuestion = /몇\s*페이지까지/u.test(text) ? 'pages' : /자리\s*몇\s*칸/u.test(text) ? 'free'
      : /안\s*놓은/u.test(text) ? 'unplaced' : featureId && /(?:위젯|패널)\s*(?:크기|어디)/u.test(text) ? 'widget' : 'panels';
    const sourceLayer = boardQuestion === 'widget' && featureId ? getRegistration(featureId)!.layer : layer;
    return { intent: { kind: 'read', tool: 'get_board' }, reading: { tool: 'get_board', args: { layer: sourceLayer } },
      slots: { boardQuestion, ...(featureId ? { boardFeature: featureId } : {}) } } satisfies DomainTurnInput;
  }
  if (pageAppend(text)) return turn('layout.add_page', address);
  if (layoutVerb.starter.test(text)) return turn(layer === 'marketing' ? 'layout.start_with_preset' : 'layout.start_with_three', address);
  const adding = layoutVerb.add.test(text), removing = layoutVerb.remove.test(text), moving = layoutVerb.move.test(text), resizing = layoutVerb.resize.test(text);
  const couponMissing = /쿠폰/u.test(text) && !ids.some(id => couponChoices.some(choice => choice === id));
  if (couponMissing && (adding || removing) && surface.test(text)) {
    return clarify('featureId', couponChoices.map(id => name(id, locale)).join('\n'), value => {
      const selected = findFeatures(value, run, locale).find(id => couponChoices.some(choice => choice === id));
      return selected ? turn(adding ? 'layout.add_widget' : 'layout.remove_widget', { featureId: selected, ...address }) : undefined;
    });
  }
  if (adding && (surface.test(text) || featureId && (dimensions || horizontal || vertical || /자리에|맨\s*아래|둘\s*다/u.test(text)))) {
    if (!featureId || /^(?:메뉴|상품)\s+.+\s+\d+\s*원/u.test(text)) return !featureId
      ? clarify('featureId', tr.t('navis.placeWhich'), value => routeLayout(`${value} 위젯 추가해줘`, snapshot, locale, run)) : undefined;
    const size = span(undefined);
    if ([size.width, size.height].some(n => n < 1 || n > 4)) return { kind: 'refusal', reason: 'invalid_target', answer: invalidSize };
    const spot = position(undefined);
    if (ids.length > 1 && !spot && /이랑|랑|하고|둘\s*다|\band\b/iu.test(text)) {
      return turn('layout.add_widgets', { ...address, ...(page !== undefined ? { page } : {}), widgets: ids.map(featureId => ({ featureId, ...size })) });
    }
    return turn('layout.add_widget', { featureId, ...address, ...(page !== undefined ? { page } : {}), ...size,
      ...(spot ? { column: spot.column, row: spot.row } : {}) });
  }
  if (removing && (surface.test(text) || featureId && /^(?:마진|캘린더|브리핑|손익|재고|세무관리)\s*(?:이랑|랑|을|를|은|는|\s)/u.test(text))) {
    if (!featureId) return clarify('featureId', tr.t('common.navis.agent.chooseWidget'));
    if (ids.length > 1 && /이랑|랑|하고|둘\s*다|\band\b/iu.test(text)) return turn('layout.remove_widgets', { ...address, featureIds: ids });
    return turn('layout.remove_widget', { featureId, ...address, ...(current && current.index !== board.currentPage ? { page: current.index + 1 } : {}) });
  }
  if (moving && (featureId || /그거|그\s*패널|위젯|패널/u.test(text))) {
    if (!featureId || !current) return moveFailure();
    if (page !== undefined) return page < 1 || page > 5 ? answer(tr.t('page.limit'))
      : turn('layout.move_to_page', { featureId, layer, page: current.index + 1, destinationPage: page });
    if (ids[1] && /자리\s*바꿔/u.test(text)) return turn('layout.swap_widgets', { ...address, a: featureId, b: ids[1] });
    const spot = position(current.panel);
    if (!spot) return clarify('destination', phrase(locale, '어디로 옮길까요?', 'Where should it move?', '要移到哪里？', '要移到哪裡？'));
    const grid = run.screenPreset.grid;
    if (spot.column < 0 || spot.column + current.panel.width > grid.columns || spot.row < 0 || spot.row + current.panel.height > grid.rows) {
      return clarify('column', phrase(locale, `${target} 보드는 가로 ${grid.columns}칸이에요`, `The ${target} board is ${grid.columns} cells wide`, `${target}看板宽 ${grid.columns} 格`));
    }
    return turn('layout.move_widget', { featureId, ...address, column: spot.column, row: spot.row });
  }
  if (resizing && featureId && (current || surface.test(text))) {
    if (!current) return moveFailure();
    if (!dimensions && !horizontal && !vertical) return clarify('size', askSize, value => routeLayout(`${target} ${value}로 바꿔줘`, snapshot, locale, run));
    const size = span(current.panel);
    if ([size.width, size.height].some(n => n < 1 || n > 4)) return dimensions
      ? { kind: 'refusal', reason: 'invalid_target', answer: invalidSize }
      : clarify('size', `${invalidSize}\n${phrase(locale, '4칸으로 바꿀까요?', 'Use 4 cells?', '改为 4 格？', '改為 4 格？')}`);
    return turn('layout.resize_widget', { featureId, ...address, ...size });
  }
  if (conditionRequest.test(text) && featureId && current) {
    const end = snapshot.pos?.businessDate ?? TODAY;
    return turn('layout.set_condition', { featureId, ...address, condition: { kind: 'dateRange', start: addDays(end, -6), end } });
  }
  return undefined;
}

export const layoutDomain: DomainAdapter = { commands: [], reads: [], tools: [boardTool], runCommands, route: routeLayout };
