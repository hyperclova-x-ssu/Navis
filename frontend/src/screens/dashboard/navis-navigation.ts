import { getLayerGroups, getRegistration, getRegistry } from '../../catalog';
import type { ClosingViewTab, DetailPrefill, DetailRef, FeatureId, GroupId, LayerId, RunState, RunStore } from '../../contracts';
import { findPlacement, selectTemplateInteractionBlocked } from '../../state';
import { selectPosPreferences, tablesEnabled } from '../../pos/tables';
import {
  agentCommandPolicy, agentHandoffFields, agentNavigationHandoffIssue, agentNavigationItemKinds, validateAgentCommandArgs,
  validateAgentDetailRef, validateAgentNavigationArgs, validateAgentNavigationWireArgs, validateAgentPrefill,
  type AgentFact, type AgentNavigationAction, type AgentNavigationCommand, type AgentReadProjection, type AgentSearchProjection, type AgentWireArgs,
} from '../../../shared/navis-agent-schema.mjs';
import { closingStartTab, openSettingsAt } from '../settings/start-view';
import { panelFocusKey } from './gestures';
import { createTranslator } from '../../i18n';
import { dataBundles, resolveDataText, TODAY, type WidgetDataStore } from '../../data/widget-data';
import { matchWidget, norm } from '../../features/assistant/question';
import { assistantDomains, readNavisCondition, widgetStatusQuery } from '../../features/assistant/snapshot';
import type { DomainDetail } from '../../features/assistant/domains/registry';
import { supportedConditions } from '../../data/conditions';
import { parseNavisNumber } from '../../features/assistant/navis-input';
import { navisTranslator } from '../../features/assistant/messages';

export const NAVIS_RETURN_FOCUS = 'dashboard-navis-return';

export type NavigationResult = 'opened' | 'already' | 'busy' | 'invalid' | 'unavailable' | 'stale' | 'noHistory';
type Args = Readonly<Record<string, unknown>>;
type Address = { readonly layer: LayerId; readonly page: number };
type NavigationPorts = {
  readonly highlight: (featureId: FeatureId) => void;
  readonly closeChat: () => void;
  readonly setDrawerSearch?: (enabled: boolean) => void;
  readonly posBusy?: () => boolean;
};

const draftViews: Partial<Record<FeatureId, string>> = {
  'notice-send': 'draft', 'slot-coupon': 'send', 'customer-groups': 'reach-out', 'promo-video': 'create',
};

function detailRef(args: Args): DetailRef | null {
  if (!validateAgentDetailRef(args)) return null;
  const featureId = getRegistration(args.featureId)?.id;
  if (!featureId) return null;
  const { view, tab, itemId, focus, date, time, hour, condition, filter, prefill } = args;
  const chosen = view ?? tab;
  if (featureId === 'inventory-booking' && chosen === 'history' && !itemId) return null;
  const displayDraft: DetailPrefill | undefined = prefill
    ? featureId === 'menu' && chosen === 'register'
      ? { kind: 'menu.create', name: typeof prefill.name === 'string' ? prefill.name : undefined,
          price: typeof prefill.price === 'number' ? prefill.price : undefined,
          category: prefill.category === 'drink' || prefill.category === 'dessert' ? prefill.category : undefined }
      : { kind: 'widget-draft', command: 'ui.openDetail', fields: prefill }
    : undefined;
  return { featureId, ...(chosen ? { view: chosen } : {}), ...(itemId ? { itemId } : {}), ...(focus ? { focus } : {}),
    ...(date ? { date } : {}), ...(time ? { time } : {}), ...(hour !== undefined ? { hour } : {}),
    ...(condition ? { condition } : {}), ...(filter ? { filter } : {}), ...(displayDraft ? { prefill: displayDraft } : {}) };
}

function address(state: RunState): Address {
  return { layer: state.layer, page: state.layer === 'orders-payment' ? 0 : state.boards[state.layer].currentPage };
}
const sameAddress = (a: Address, b: Address) => a.layer === b.layer && a.page === b.page;
const result = (success: boolean): NavigationResult => success ? 'opened' : 'unavailable';

export function createNavisNavigation(run: RunStore, ports: NavigationPorts) {
  const history: Address[] = [];
  let restoring = false;
  let revision = 0;
  const attach = () => run.subscribe((state, previous) => {
    const from = address(previous);
    const moved = !sameAddress(from, address(state));
    if (moved || state.overlay !== previous.overlay || state.edit.mode !== previous.edit.mode ||
      state.layoutRevision !== previous.layoutRevision || state.runId !== previous.runId) revision++;
    if (state.runId !== previous.runId) { history.length = 0; return; }
    if (restoring || state.screen !== 'dashboard' || previous.screen !== 'dashboard') return;
    if (moved) {
      history.push(from);
      if (history.length > 12) history.shift();
    }
  });

  /** Owner input is in progress or the screen is not ready. A pending overlay exit is not part of it: navigation waits that out (`exitWait`). */
  const busy = (s = run.getState()) => s.screen !== 'dashboard' || selectTemplateInteractionBlocked(s) ||
    s.idle.mode === 'idle' || !!s.idle.wakeInputToken || !!s.closingInput ||
    !!s.edit.gesture || !!s.gesturePreview || s.activeInputs.some(input => input.kind === 'pointer') ||
    s.posUi.approval?.status === 'pending' || !!ports.posBusy?.();

  /** Wait for the surface that owns the current exit animation to release its token. */
  function waitForExit(token: string, runId: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const check = () => {
        const state = run.getState();
        if (signal?.aborted || state.runId !== runId) finish(false);
        else if (state.exitPendingToken !== token) finish(!state.exitPendingToken && state.overlay.type === 'none');
      };
      const unsubscribe = run.subscribe(check);
      const abort = () => finish(false);
      function finish(ok: boolean) {
        unsubscribe();
        signal?.removeEventListener('abort', abort);
        resolve(ok);
      }
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  /** The overlay that was just closed is still playing its exit: wait until it releases, so a hand-off sent right after the close opens instead of being refused.
   * Nothing pending returns undefined (no extra tick); a promise resolves true when the wait did not end in a clean release (aborted or replaced). */
  function exitWait(signal?: AbortSignal): Promise<boolean> | undefined {
    const s = run.getState();
    if (!s.exitPendingToken || s.overlay.type !== 'none') return undefined;
    return waitForExit(s.exitPendingToken, s.runId, signal).then(released => !released);
  }

  async function afterOverlay(action: () => NavigationResult, signal?: AbortSignal): Promise<NavigationResult> {
    const before = run.getState();
    if (signal?.aborted) return 'stale';
    if (busy(before)) return 'busy';
    if (before.overlay.type === 'none') return action();
    const token = run.actions.closeOverlay('button');
    if (token && before.overlay.type === 'closing' && before.overlay.returnTo && run.getState().overlay.type === 'detail') {
      return afterOverlay(action, signal);
    }
    if (!token || !await waitForExit(token, before.runId, signal)) return 'stale';
    return busy() ? 'busy' : action();
  }

  async function openDetail(ref: DetailRef, signal?: AbortSignal): Promise<NavigationResult> {
    if (signal?.aborted) return 'stale';
    const waiting = exitWait(signal);
    if (waiting && await waiting) return 'stale';
    const s = run.getState();
    if (busy(s)) return 'busy';
    if (s.overlay.type === 'detail') {
      const current = s.overlay.stack?.at(-1) ?? { featureId: s.overlay.featureId };
      if (Object.keys(current).length === 1 && Object.keys(ref).length === 1 && current.featureId === ref.featureId) return 'already';
      return result(run.actions.openLinkedDetail(ref));
    }
    if (s.edit.mode === 'edit') return 'busy';
    return afterOverlay(() => result(run.actions.openDetailRef(ref, NAVIS_RETURN_FOCUS)), signal);
  }

  const closing = async (tab: ClosingViewTab | undefined, readOnly: boolean, signal?: AbortSignal): Promise<NavigationResult> => {
    if (signal?.aborted) return 'stale';
    const waiting = exitWait(signal);
    if (waiting && await waiting) return 'stale';
    const s = run.getState();
    if (busy(s)) return 'busy';
    if (s.overlay.type === 'detail') return result(run.actions.openClosing(NAVIS_RETURN_FOCUS, { tab, readOnly }));
    if (s.overlay.type === 'closing' && s.overlay.tab === tab && !!s.overlay.readOnly === readOnly) return 'already';
    return afterOverlay(() => result(run.actions.openClosing(NAVIS_RETURN_FOCUS, { tab, readOnly })), signal);
  };

  const restore = (): NavigationResult => {
    const state = run.getState();
    const prior = history.at(-1);
    if (!prior) return 'noHistory';
    restoring = true;
    try {
      if (prior.layer !== state.layer && !run.actions.switchLayer(prior.layer)) return 'busy';
      if (prior.layer !== 'orders-payment' && !run.actions.goToPage(prior.page)) return 'unavailable';
      history.pop();
      return 'opened';
    } finally { restoring = false; }
  };

  async function execute(command: string, args: Args, signal?: AbortSignal): Promise<NavigationResult> {
    if (signal?.aborted) return 'stale';
    const waiting = command === 'ui.close_chat' ? undefined : exitWait(signal);
    if (waiting && await waiting) return 'stale';
    const s = run.getState();
    if (command === 'ui.openDetail') {
      const ref = detailRef(args);
      return ref ? openDetail(ref, signal) : 'invalid';
    }
    if (command === 'ui.go_to_page' && typeof args.page === 'number' && Number.isSafeInteger(args.page) && (args.page < 1 || args.page > 5)) return 'unavailable';
    if (!validateAgentNavigationArgs(command, args)) return 'invalid';
    if (command === 'ui.close_chat') { ports.closeChat(); return 'opened'; }
    if (busy(s)) return 'busy';
    switch (command) {
      case 'ui.switch_layer': {
        const target = (args.layer === 'pos' ? 'orders-payment' : args.layer) as LayerId;
        if (s.layer === target) return 'already';
        if (s.edit.mode === 'edit') return 'busy';
        return afterOverlay(() => result(run.actions.switchLayer(target)), signal);
      }
      case 'ui.go_to_page': {
        const page = Number(args.page) - 1;
        if (s.layer === 'orders-payment' || !s.boards[s.layer].pages[page]) return 'unavailable';
        if (s.boards[s.layer].currentPage === page) return 'already';
        return afterOverlay(() => result(run.actions.goToPage(page)), signal);
      }
      case 'ui.show_panel': {
        const feature = getRegistration(String(args.featureId))?.id;
        if (!feature) return 'invalid';
        const placement = findPlacement(s, feature);
        if (!placement || (args.page !== undefined && args.page !== placement.pageIndex + 1)
          || (args.layer !== undefined && args.layer !== placement.layer)) return 'unavailable';
        if (s.edit.mode === 'edit' && s.layer !== placement.layer) return 'busy';
        return afterOverlay(() => {
          if (run.getState().layer !== placement.layer && !run.actions.switchLayer(placement.layer)) return 'busy';
          if (!run.actions.goToPage(placement.pageIndex)) return 'unavailable';
          ports.highlight(feature);
          return 'opened';
        }, signal);
      }
      case 'ui.open_drawer': {
        const group = (args.group ?? 'recommended') as GroupId;
        if (s.layer === 'orders-payment' || !getLayerGroups(s.layer).includes(group)) return 'unavailable';
        const show = () => {
          ports.setDrawerSearch?.(typeof args.query === 'string');
          return result(run.actions.openDrawer(group, typeof args.query === 'string' ? args.query : undefined));
        };
        return s.overlay.type === 'drawer' ? show() : afterOverlay(show, signal);
      }
      case 'ui.open_settings': {
        const view = args.view;
        if (view !== undefined && view !== 'preview' && view !== 'tables') return 'invalid';
        if (view === 'tables' && !tablesEnabled(s.shopSettings)) return 'unavailable';
        if (s.overlay.type === 'settings') return 'already';
        return afterOverlay(() => {
          if (view) openSettingsAt(run, view);
          else run.actions.openSettings();
          return result(run.getState().overlay.type === 'settings');
        }, signal);
      }
      case 'ui.open_closing':
        return closing(args.tab as ClosingViewTab | undefined, true, signal);
      case 'ui.open_widget_help': {
        const feature = getRegistration(String(args.featureId))?.id;
        if (!feature) return 'invalid';
        const fromDetail = s.overlay.type === 'detail' && s.overlay.featureId === feature;
        return result(run.actions.openWidgetHelp(feature, fromDetail ? 'detail' : 'panel',
          fromDetail ? `detail-help:${feature}` : panelFocusKey(feature)));
      }
      case 'ui.go_back':
        if (s.widgetHelp) return result(run.actions.closeWidgetHelp());
        if (s.overlay.type === 'detail' && run.actions.detailBack()) return 'opened';
        if (s.overlay.type !== 'none') return result(!!run.actions.closeOverlay('button'));
        return restore();
      case 'ui.close_overlay':
        return result(!!run.actions.closeOverlay('button'));
      case 'ui.skip_coaches':
        run.actions.skipWidgetCoaches();
        return 'opened';
      case 'ui.enter_layout_edit':
        if (s.layer === 'orders-payment' || s.panels.length === 0) return 'unavailable';
        if (s.edit.mode === 'edit') return 'already';
        return afterOverlay(() => { run.actions.enterEditing(); return result(run.getState().edit.mode === 'edit'); }, signal);
      case 'ui.exit_layout_edit':
        return s.edit.mode === 'view' ? 'already' : result(run.actions.finishEditing());
      case 'ui.set_pos_tab': {
        const tab = args.tab as RunState['posUi']['tab'];
        if (s.layer !== 'orders-payment' || (tab === 'tables' &&
          !(tablesEnabled(s.shopSettings) && selectPosPreferences(s.shopSettings).showTables))) return 'unavailable';
        return afterOverlay(() => result(run.actions.setPosUi({ ...run.getState().posUi, tab }, s.runId)), signal);
      }
      default:
        return 'invalid';
    }
  }

  function handoff(destination: { readonly featureId: string; readonly command?: string; readonly draft?: Args }, signal?: AbortSignal) {
    const { featureId, command, draft = {} } = destination;
    if (command === 'menu.create' && featureId === 'menu') {
      const { name, price, category } = draft;
      if (Object.keys(draft).some(key => !['name', 'price', 'category'].includes(key)) || !validateAgentPrefill(featureId, draft) ||
        (name !== undefined && (typeof name !== 'string' || !name.trim())) ||
        (price !== undefined && (typeof price !== 'number' || price < 1)) ||
        (category !== undefined && category !== 'drink' && category !== 'dessert')) return 'invalid';
      return openDetail({ featureId, view: 'register', prefill: { kind: 'menu.create', name, price, category } }, signal);
    }
    if (command) {
      const policy = agentCommandPolicy(command, draft);
      if (!policy || policy.policy === 'propose' || policy.featureId !== featureId || !validateAgentCommandArgs(command, draft) || agentNavigationHandoffIssue(command, draft)) return 'invalid';
    } else if (Object.keys(draft).length) return 'invalid';
    if (featureId === 'pos-closing') return closing(command === 'pos.drawerMovement' ? 'drawer' : 'sales', false, signal);
    if (featureId === 'settings') return execute('ui.open_settings', {}, signal);
    if (featureId === 'pos') return execute('ui.switch_layer', { layer: 'pos' }, signal);
    const feature = getRegistration(featureId)?.id;
    if (!feature) return 'invalid';
    const domainRef = command && assistantDomains.handoff(command, draft);
    if (domainRef) return domainRef.featureId === feature ? openDetail(domainRef, signal) : 'invalid';
    const fieldView = command === 'ui.setDraftField' && typeof draft.view === 'string' ? draft.view : undefined;
    if (fieldView && draftViews[feature] !== fieldView) return 'invalid';
    const view = command === 'ui.openSettlement' && typeof draft.purpose === 'string' ? draft.purpose : fieldView ?? draftViews[feature];
    const itemId = command === 'ui.openSettlement' && typeof draft.memberId === 'string' ? draft.memberId : undefined;
    const fields = command === 'ui.setDraftField' && typeof draft.field === 'string'
      ? { [draft.field]: draft.value } : command ? agentHandoffFields(command, draft as AgentWireArgs) : undefined;
    const prefill: DetailPrefill | undefined = command && fields ? { kind: 'widget-draft', command, fields } : undefined;
    return openDetail({ featureId: feature, ...(view ? { view } : {}), ...(itemId ? { itemId } : {}), ...(prefill ? { prefill } : {}) }, signal);
  }

  return { attach, execute, handoff, busy, revision: () => revision, hasHistory: () => history.length > 0 };
}

export type NavisNavigation = ReturnType<typeof createNavisNavigation>;
type RoutedAction = DomainDetail & { readonly command: AgentNavigationCommand; readonly local?: boolean; readonly unsupportedPeriod?: boolean };
type RoutingContext = {
  readonly state: RunState;
  readonly feature: FeatureId | null;
  readonly ingredient?: string;
  readonly menuItem?: string;
  readonly condition?: DetailRef['condition'];
  readonly reference?: FeatureId;
};

const koreanData = createTranslator('ko', ...dataBundles);
const navigationAliases: readonly [FeatureId, RegExp][] = [
  ['menu', /메뉴(?:판|\s+위젯)/u], ['custom-order', /케이크\s*주문/u],
  ['members', /ㅎㅇㅁㄹ/u], ['staff-schedule', /직원\s*스케줄/u], ['voice-booking', /^예약/u], ['manuals', /매뉴얼/u], ['grants', /지원사업/u],
  ['ai-response', /응대|답변\s*대기/u], ['community', /제안\s*(?:목록|화면)/u],
  ['customer-groups', /고객\s*그룹/u], ['coupon-status', /쿠폰\s*현황/u],
];

/** Only the private browser snapshot can turn a visible item name into an ID. */
export function classifyNavigation(text: string, state: RunState, snapshot: ReturnType<WidgetDataStore['getSnapshot']>, reference?: FeatureId) {
  if (widgetStatusQuery(text)) return;
  const domain = assistantDomains.navigation(text, snapshot, state.locale);
  if (domain === null) return;
  if (domain && validateAgentDetailRef(domain.args)) return { ...domain, command: 'ui.openDetail' as const };
  const normalized = norm(text);
  const matches = <T,>(items: readonly T[], label: (item: T) => string) => items.filter(item => {
    const value = norm(label(item));
    return value.length > 1 && normalized.includes(value);
  });
  const translator = navisTranslator(state.locale);
  const names = getRegistry(state.screenPreset.id).flatMap(registration =>
    [registration.label, ...registration.aliases, translator.t(registration.nameKey), ...translator.t(registration.aliasesKey).split('|')]
      .map(label => ({ id: registration.id, label: norm(label) })));
  const explicit = matches(names, entry => entry.label).sort((a, b) => b.label.length - a.label.length)[0]?.id;
  const stock = snapshot.tables.inventoryItem.filter(item => item.kind === 'ingredient' && !item.deletedAt);
  const stockLabel = (item: (typeof stock)[number]) => resolveDataText(koreanData.t, item.name ?? { key: item.nameKey });
  const exactStock = matches(stock, stockLabel);
  const words = new Set(text.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).map(norm));
  const ingredients = exactStock.length ? exactStock : stock.filter(item =>
    stockLabel(item).split(/\s+/u).some(word => /^\p{L}{2,}$/u.test(word) && words.has(norm(word))));
  const menus = matches(snapshot.tables.menuItem.filter(item => !item.deletedAt && item.kind !== 'retail'),
    item => resolveDataText(koreanData.t, item.name ?? { key: item.nameKey }));
  const feature = navigationAliases.find(([, pattern]) => pattern.test(text))?.[0] ?? explicit ?? matchWidget(text);
  const period = feature && ['ledger', 'margin', 'tax'].includes(feature) &&
    /최근|지난|이번\s*(?:주|달)|오늘|\d+\s*일|\d{4}-\d{2}-\d{2}/u.test(text)
    ? readNavisCondition(feature, text, snapshot.pos?.businessDate ?? TODAY) : undefined;
  const plan = routeNavisNavigation(text, { state, feature, condition: period ?? undefined,
    ingredient: ingredients.length === 1 ? ingredients[0].itemId : undefined,
    menuItem: menus.length === 1 ? menus[0].menuId : undefined, reference });
  return plan?.command === 'ui.openDetail' && period === null ? { ...plan, unsupportedPeriod: true } : plan;
}

/** Recognize explicit UI requests before they reach the ordinary question or mutation paths. */
export function routeNavisNavigation(input: string, { state, feature, ingredient, menuItem, condition, reference }: RoutingContext): RoutedAction | undefined {
  const text = input.normalize('NFKC').trim();
  const compact = text.replace(/\s+/gu, '');
  if (/^(?:매출|입금|수입|일정|스케줄)\s*(?:좀\s*)?보여\s*줘[.!?]?$/u.test(text)) return;
  if (/하지\s*마|말아\s*줘|무시|ignore\s+|\b(?:don't|never|do not)\b|[“”"'‘’]/iu.test(text)) return;
  const to = (command: AgentNavigationCommand, args: AgentWireArgs = {}, local?: boolean): RoutedAction => ({ command, args, local });
  const open = /열(?:어|기|고)|보여\s*줘|띄워|자세히|상세\s*$|켜\s*줘|(?:화면|메뉴)(?:으로|로)?\s*(?:가|이동)|\b(?:open|show)\b|打开|開啟|顯示|显示/iu.test(text);
  if (/마감/.test(text) && /마감\s*(?:해\s*(?:줘|주세요)|처리|취소)|영업\s*종료/.test(text)) return;
  const closingTab = closingStartTab(text);
  if (closingTab) return to('ui.open_closing', { tab: closingTab });
  if (/^(?:Navis|나비스|채팅창?|대화창?|이제\s*그만\s*창)(?:을|를)?\s*닫/iu.test(text)) return to('ui.close_chat');
  if (/^(?:서랍|기능 목록|상세(?: 창)?|설정 창)(?:을|를)?\s*닫|^오른쪽\s*목록\s*치워/u.test(text)) return to('ui.close_overlay');
  if (/코치(?:마크)?|사용법 안내|안내\s*말풍선|튜토리얼\s*팁/u.test(text) && /그만|끄|건너뛰|넘겨|스킵/u.test(text)) return to('ui.skip_coaches');
  if (state.edit.mode === 'edit' && /^완료[.!]?$/u.test(text)) return to('ui.exit_layout_edit');
  if (/패널\s*위치\s*바꾸게/u.test(text)) return to('ui.enter_layout_edit');
  if (/배치\s*편집|편집\s*모드/u.test(text)) {
    if (/끝내|종료|완료|닫|나가|꺼/u.test(text)) return to('ui.exit_layout_edit');
    if (/들어|켜|시작|열/u.test(text)) return to('ui.enter_layout_edit');
  }
  if (/^(?:아까\s*보던\s*화면으로\s*)?돌아가(?:기|줘|주세요)?[.!?]?$/u.test(text) ||
      /^(?:방금\s*전\s*화면으로\s*가|뒤로\s*가기)|(?:이전|뒤)\s*(?:화면으로\s*)?돌아|^상세(?:\s*창)?에서\s*돌아|^(?:자세히 보기|열린 창) 닫고 (?:뒤로|돌아가)|^(?:뒤로|(?:go\s+)?back)$/iu.test(text)) return to('ui.go_back');
  if (/^(?:관리|마케팅|주문(?:\/결제)?|결제|POS|계산대)(?:\s*(?:화면|탭))?\s*(?:으로|로|을|를)?\s*(?:가|돌아|전환|이동|보여|열)/iu.test(text) || /^(?:관리|마케팅)\s*탭$/u.test(text)) {
    return to('ui.switch_layer', { layer: text.startsWith('관리') ? 'management' : text.startsWith('마케팅') ? 'marketing' : 'pos' });
  }
  const explicitPage = text.match(/(?:^|\s)([0-9]+)\s*페이지|\bpage\s+(\d+)\b/iu);
  const ordinal = text.match(/^([가-힣]+)\s*번째\s*페이지/u)?.[1];
  const spokenPage = ordinal && parseNavisNumber(ordinal);
  const relativePage = /^(?:다음\s*(?:페이지|장)|앞으로\s*한\s*페이지)/u.test(text) ? 1
    : /^(?:이전|앞)\s*페이지|^뒤로\s*한\s*페이지|^처음\s*페이지에서\s*한\s*장\s*앞으로/u.test(text) ? -1 : 0;
  if (explicitPage || spokenPage || relativePage || /^(?:첫|처음|마지막|맨\s*끝|끝)\s*페이지/u.test(text)) {
    const board = state.boards[state.activeBoard];
    const page = explicitPage ? Number(explicitPage[1] ?? explicitPage[2]) : spokenPage ? spokenPage : relativePage
      ? board.currentPage + 1 + relativePage : /^(?:첫|처음)/u.test(text) ? 1 : board.pages.length;
    return to('ui.go_to_page', { page }, page < 1 || page > 5);
  }
  const drawerSearch = text.match(/^(?:기능 목록|기능 서랍)(?:에서)?\s+(.+?)\s+검색/u)?.[1]
    ?? text.match(/^위젯\s*검색\s*열어서\s+(.+?)\s+찾아/u)?.[1]
    ?? text.match(/^기능\s*찾기에\s+(.+?)\s+쳐/u)?.[1];
  if (drawerSearch) return to('ui.open_drawer', { group: 'recommended', query: drawerSearch });
  if (/^(?:기능 목록|추천 (?:위젯|기능)|재고.*기능 서랍|위젯 더 추가)/u.test(text) && open || /카페한테 좋은 기능/u.test(text)) return to('ui.open_drawer', { group:
    state.activeBoard === 'management' && !/추천|카페한테/u.test(text) ? 'stock' : 'recommended' });
  if (open && /예시\s*상태|시연용\s*상태|^(?:앱\s*|환경)?설정/u.test(text)) {
    return to('ui.open_settings', /예시|시연용/u.test(text) ? { view: 'preview' } : {});
  }
  if (/^테이블\s*배치/u.test(text) && /바꾸고\s*싶|열어/u.test(text)) return to('ui.open_settings', { view: 'tables' });
  if (/^(?:영업\s*)?(?:마감|시재)/u.test(text) && open) {
    return to('ui.open_closing', { tab: /내역|기록|이력/u.test(text) ? 'history' : /시재|현금/u.test(text) ? 'drawer' : 'sales' });
  }
  if (ingredient && /입고\s*내역|재고/u.test(text) && open) {
    return to('ui.openDetail', { featureId: 'inventory-booking', itemId: ingredient, view: 'history' });
  }
  if (menuItem && feature === 'menu' && open) return to('ui.openDetail', { featureId: 'menu', itemId: menuItem });
  if (reference && /^(?:아까\s*)?그(?:거|것)(?:을)?\s*(?:열|보여)|^방금\s*얘기한\s*위젯\s*열/u.test(text)) return to('ui.openDetail', { featureId: reference });
  if (feature && compact !== '쿠폰열어줘' && !/공식.*사이트|브라우저|웹사이트/u.test(text)) {
    if (/어디(?:\s*(?:있|야)|[.!?]?$)|몇\s*페이지|보드에서\s*찾|(?:패널|위젯)\s*위치|응대\s*패널\s*보여/u.test(text)) return to('ui.show_panel', { featureId: feature });
    if (/위젯.*뭐\s*하는|위젯.*사용법|패널\s*설명|도움말/u.test(text)) return to('ui.open_widget_help', { featureId: feature });
    if (open || feature === 'briefing' && /한번\s*더/u.test(text)) {
      const view = feature === 'ledger' && /지출/u.test(text) ? 'expenses' :
        feature === 'ai-response' && /리뷰만|리뷰\s*탭/u.test(text) ? 'review' :
        feature === 'inventory-booking' && /판매\s*상품/u.test(text) ? 'products' : undefined;
      return to('ui.openDetail', { featureId: feature, ...(view ? { view } : {}), ...(condition ? { condition } : {}) });
    }
  }
}

export function routeMenuForm(input: string) {
  const match = input.trim().match(/^(.+?)\s+메뉴\s*(?:등록|추가)\s*(?:폼|양식)(?:을|를)?\s*열(?:어|어줘|어주세요)[.!]?$/u);
  if (!match) return;
  const [, description] = match;
  const priceMatch = description.match(/\s+(\d[\d,]*)\s*원$/u);
  const name = priceMatch ? description.slice(0, priceMatch.index).trim() : description;
  return { featureId: 'menu', command: 'menu.create', draft: { name, ...(priceMatch ? { price: Number(priceMatch[1].replace(/,/gu, '')) } : {}) } };
}

/** Stock history is the ingredient grid's existing row expansion. The widget can
 * consume the same DetailRef directly when its domain slice owns that view. */
function openInventoryHistory(root: HTMLElement, itemId: string): boolean {
  const target = JSON.stringify([itemId, '$expand']);
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-widget="inventory-booking"] button[data-grid-target][aria-expanded]'))
    .find(node => node.dataset.gridTarget === target && !node.closest('[hidden],[inert],[aria-hidden="true"]'));
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
  if (button.getAttribute('aria-expanded') === 'false') button.click();
  button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return true;
}

/** Request-scoped references keep row IDs and the owner's search words in the browser. */
export function prepareNavigationRequest(plan: RoutedAction, state: RunState, navigation: NavisNavigation) {
  const revision = navigation.revision();
  const layer = state.layer === 'orders-payment' ? 'pos' : state.layer;
  const page = layer === 'pos' ? undefined : state.boards[layer].currentPage + 1;
  const localArgs = { ...plan.args };
  if (plan.command === 'ui.show_panel' && typeof plan.args.featureId === 'string') {
    const feature = getRegistration(plan.args.featureId);
    const placed = feature && findPlacement(state, feature.id);
    if (placed) Object.assign(localArgs, { layer: placed.layer, page: placed.pageIndex + 1 });
  }
  const args = { ...localArgs };
  const slots: Record<string, string | number> = {};
  const searches: AgentSearchProjection[] = [];
  if (typeof args.itemId === 'string') {
    if (plan.target && plan.target.id !== args.itemId) return;
    const handle = 'navis-detail-selection';
    const itemId = args.itemId;
    args.itemId = { handle };
    const kinds = agentNavigationItemKinds(args);
    const kind = plan.target?.kind ?? (kinds.length === 1 ? kinds[0] : undefined);
    if (!kind || !kinds.includes(kind)) return;
    const querySlot = plan.querySlot ?? 'target';
    slots[querySlot] = itemId;
    searches.push({ kind, querySlot, matches: [{ handle, match: 'exact' }] });
  }
  if (typeof args.query === 'string') {
    slots.query = args.query;
    args.query = { slot: 'query' };
  }
  if (args.prefill && typeof args.prefill === 'object') {
    const opaque: Record<string, AgentWireArgs[string]> = {};
    let sequence = 0;
    for (const [field, value] of Object.entries(args.prefill)) {
      const captured: Record<string, string | number> = {};
      function encode(item: AgentWireArgs[string]): AgentWireArgs[string] {
        if (typeof item === 'string' || typeof item === 'number') {
          const slot = `prefill${sequence++}`;
          captured[slot] = item;
          return { slot };
        }
        return item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, encode(child)])) : item;
      }
      const encoded = encode(value);
      if (validateAgentNavigationWireArgs(plan.command, { ...args, prefill: { [field]: encoded } })) {
        opaque[field] = encoded;
        Object.assign(slots, captured);
      } else opaque[field] = value;
    }
    args.prefill = opaque;
  }
  if (!validateAgentNavigationWireArgs(plan.command, args)) return;
  const fact = (key: string, value: string | number): AgentFact => ({ key, value, unit: '', label: key, display: String(value) });
  const readings: AgentReadProjection[] = [{ tool: 'get_ui_state', args: { section: 'display' }, facts: [
    fact('ui.busy', Number(navigation.busy())), fact('ui.backAvailable', Number(navigation.hasHistory())),
    fact('ui.overlay', state.overlay.type), fact('ui.editing', Number(state.edit.mode === 'edit')),
    fact('ui.tablesConfigurable', Number(tablesEnabled(state.shopSettings))),
    fact('ui.pos.tablesEnabled', Number(tablesEnabled(state.shopSettings) && selectPosPreferences(state.shopSettings).showTables)),
  ] }];
  const boardLayer = args.layer === 'management' || args.layer === 'marketing' ? args.layer : layer;
  if (boardLayer !== 'pos' && ['ui.go_to_page', 'ui.show_panel', 'ui.open_widget_help', 'ui.enter_layout_edit'].includes(plan.command)) {
    const board = state.boards[boardLayer];
    const placement = typeof args.featureId === 'string' ? getRegistration(args.featureId) : undefined;
    const placed = placement ? findPlacement(state, placement.id) : null;
    readings.push({ tool: 'get_board', args: { layer: boardLayer }, facts: [
      fact('board.pageCount', board.pages.length), fact('board.panelCount', board.pages[board.currentPage].panels.length),
      ...(placement && placed?.layer === boardLayer ? [fact(`board.panel.${placement.id}.page`, placed.pageIndex + 1)] : []),
    ] });
  }
  const agentTurn = { intent: { kind: 'command' as const, command: plan.command, args,
    ...(searches.length ? { querySlot: searches[0].querySlot } : {}) }, slots, page, navigationReadings: readings, navigationSearches: searches };
  const stable = (value: unknown): unknown => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]))
    : value;
  const resolve = (frame: AgentNavigationAction): AgentWireArgs | undefined => {
    if (navigation.revision() !== revision || frame.command !== plan.command || frame.runId !== state.runId || frame.layer !== layer || frame.page !== page ||
      JSON.stringify(stable(frame.args)) !== JSON.stringify(stable(args))) return;
    return localArgs;
  };
  return { agentTurn, resolve };
}

/** Apply a read-only seed through the widget's ordinary controls where those
 * controls have a stable, existing route. The DetailRef remains the hand-off. */
export function applyNavisDetailSelection(root: HTMLElement, ref: DetailRef): boolean {
  if (ref.featureId === 'inventory-booking' && ref.view === 'history' && ref.itemId) return openInventoryHistory(root, ref.itemId);
  if (!ref.condition || (ref.featureId !== 'ledger' && ref.featureId !== 'margin')) return true;
  const condition = ref.condition;
  const index = supportedConditions(ref.featureId).findIndex(candidate => candidate.kind === condition.kind && (
    candidate.kind !== 'dateRange' || condition.kind === 'dateRange' && candidate.start === condition.start && candidate.end === condition.end));
  const options = root.querySelector(`[data-widget="${ref.featureId}"] [role="radiogroup"].ui-chip-choice`)
    ?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
  const button = options?.[index];
  if (!button || button.disabled) return false;
  if (button.getAttribute('aria-checked') === 'false') button.click();
  return true;
}
