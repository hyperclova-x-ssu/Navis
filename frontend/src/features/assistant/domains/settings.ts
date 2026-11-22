import {
  AGENT_SETTINGS_COMMANDS, validateAgentToolArgs,
  type AgentFact, type AgentReadArgs, type AgentReadProjection, type AgentSettingsArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { getRegistration, getRegistry } from '../../../catalog';
import type { FeatureId, Locale, PreviewSelection, RunState, RunStore } from '../../../contracts';
import type { DataSnapshot } from '../../../data/db/types';
import { selectPosClosing } from '../../../data/pos/closing';
import { selectPosPreferences, tablesEnabled } from '../../../pos/tables';
import { NORMAL_VARIANT, previewVariantBundle, previewVariants, resolveClosingVariant, resolveVariant } from '../../../data/widget-data';
import { baseBundles, createTranslator, type MessageBundle, type Translator } from '../../../i18n';
import { iteration5Bundle } from '../../../screens/onboarding/messages';
import { shellBundle } from '../../../screens/settings/messages';
import { uiBundle } from '../../../ui/messages';
import type { AgentProposalPreview } from '../navis-conversation';
import type { AgentHandoff } from '../types';
import type { DomainAdapter, DomainRoute, LocalSlots, RunCommandAdapter, RunPreflight } from './registry';

const copy = {
  ko: {
    sample: '예시 상태 보기', detailFullscreen: '전체 화면', compact: '기본 크기', on: '켜짐', off: '꺼짐',
    already: (value: string) => `이미 ${value}예요`,
    themeQuestion: '라이트와 다크 중 어느 화면으로 볼까요?',
    localeQuestion: '간체와 번체 중 어떤 언어로 볼까요?',
    variantQuestion: (label: string, choices: string) => `${label} 상태를 골라 주세요.\n${choices}`,
    variantOptions: (label: string, choices: string) => `${label}에서 고를 수 있는 상태예요.\n${choices}`,
    inSettings: (label: string) => `${label}은 설정에서 바꿔 주세요`,
    closing: '마감 정산', closingStatus: '마감 상태', open: '마감 전', closed: '마감했어요',
    ready: '마감할 수 있어요', blocked: '마감할 수 없어요', canClose: '마감 가능 여부',
    unpaid: '미결제 주문', amountReceived: '계산 중 받은 돈', approval: '결제 승인', approvalPending: '승인 중', approvalIdle: '대기 없음',
    cash: '현금 시재', expectedCash: '예상 현금', countedCash: '실제 현금', cashDiff: '현금 차이', unchecked: '확인 전',
    history: '정산 이력', lastClosed: '최근 마감일', closeTime: '마감 시각', count: '결제 건수',
    paymentFailure: '결제 실패', closeByOwner: '마감 정산 창에서 직접 마감해 주세요\n열어 드릴까요?',
    reopenByOwner: '마감 되돌리기는 직접 눌러 주세요', drawerByOwner: '현금 시재에서 직접 해 주세요',
    refundByOwner: '환불은 주문/결제에서 직접 해 주세요', payAfterReopen: '마감을 되돌린 뒤 결제할 수 있어요',
  },
  en: {
    sample: 'Sample state', detailFullscreen: 'Full screen', compact: 'Default size', on: 'On', off: 'Off',
    already: (value: string) => `Already set to ${value}`,
    themeQuestion: 'Light or dark mode?', localeQuestion: 'Simplified or Traditional Chinese?',
    variantQuestion: (label: string, choices: string) => `Choose a state for ${label}.\n${choices}`,
    variantOptions: (label: string, choices: string) => `Available states for ${label}\n${choices}`,
    inSettings: (label: string) => `Change ${label} in Settings`,
    closing: 'Day close', closingStatus: 'Closing status', open: 'Open', closed: 'Closed',
    ready: 'Ready to close', blocked: 'Blocked', canClose: 'Closing eligibility',
    unpaid: 'Unpaid orders', amountReceived: 'Pending receipts', approval: 'Payment approval', approvalPending: 'Pending', approvalIdle: 'None pending',
    cash: 'Cash drawer', expectedCash: 'Expected cash', countedCash: 'Counted cash', cashDiff: 'Cash difference', unchecked: 'Unchecked',
    history: 'Closing history', lastClosed: 'Last closed date', closeTime: 'Closed at', count: 'Payments',
    paymentFailure: 'Payment failure', closeByOwner: 'Close the day in Day close.\nOpen it?',
    reopenByOwner: 'Press Reopen in Day close', drawerByOwner: 'Update the cash drawer in Day close',
    refundByOwner: 'Refund the payment in Orders & Payments', payAfterReopen: 'Reopen the day to accept payments',
  },
  'zh-Hans': {
    sample: '查看示例状态', detailFullscreen: '全屏', compact: '默认大小', on: '已开启', off: '已关闭',
    already: (value: string) => `已设为${value}`,
    themeQuestion: '要用浅色还是深色模式？', localeQuestion: '要用简体中文还是繁体中文？',
    variantQuestion: (label: string, choices: string) => `请选择${label}状态\n${choices}`,
    variantOptions: (label: string, choices: string) => `${label}的可选状态\n${choices}`,
    inSettings: (label: string) => `请在设置中更改${label}`,
    closing: '打烊结算', closingStatus: '打烊状态', open: '营业中', closed: '已打烊',
    ready: '可以打烊', blocked: '无法打烊', canClose: '能否打烊',
    unpaid: '未结账订单', amountReceived: '待结款已收金额', approval: '付款授权', approvalPending: '授权中', approvalIdle: '无待授权付款',
    cash: '收银现金', expectedCash: '预计现金', countedCash: '实点现金', cashDiff: '现金差额', unchecked: '未核对',
    history: '结算记录', lastClosed: '最近打烊日', closeTime: '打烊时间', count: '付款笔数',
    paymentFailure: '付款失败', closeByOwner: '请在打烊结算中操作\n要打开吗？',
    reopenByOwner: '请在打烊结算中撤销', drawerByOwner: '请在收银现金中操作',
    refundByOwner: '请在订单与付款中退款', payAfterReopen: '撤销打烊后可以收款',
  },
  'zh-Hant': {
    sample: '查看範例狀態', detailFullscreen: '全螢幕', compact: '預設大小', on: '已開啟', off: '已關閉',
    already: (value: string) => `已設為${value}`,
    themeQuestion: '要用淺色還是深色模式？', localeQuestion: '要用簡體中文還是繁體中文？',
    variantQuestion: (label: string, choices: string) => `請選擇${label}狀態\n${choices}`,
    variantOptions: (label: string, choices: string) => `${label}的可選狀態\n${choices}`,
    inSettings: (label: string) => `請在設定中更改${label}`,
    closing: '打烊結算', closingStatus: '打烊狀態', open: '營業中', closed: '已打烊',
    ready: '可以打烊', blocked: '無法打烊', canClose: '能否打烊',
    unpaid: '未結帳訂單', amountReceived: '待結款已收金額', approval: '付款授權', approvalPending: '授權中', approvalIdle: '無待授權付款',
    cash: '收銀現金', expectedCash: '預計現金', countedCash: '實點現金', cashDiff: '現金差額', unchecked: '未核對',
    history: '結算記錄', lastClosed: '最近打烊日', closeTime: '打烊時間', count: '付款筆數',
    paymentFailure: '付款失敗', closeByOwner: '請在打烊結算中操作\n要開啟嗎？',
    reopenByOwner: '請在打烊結算中撤銷', drawerByOwner: '請在收銀現金中操作',
    refundByOwner: '請在訂單與付款中退款', payAfterReopen: '撤銷打烊後可以收款',
  },
} as const;
const bundles = [shellBundle, iteration5Bundle, uiBundle, previewVariantBundle, ...baseBundles] as readonly MessageBundle<string>[];
const translators = new Map<Locale, Translator>();
function translator(locale: Locale): Translator {
  const existing = translators.get(locale);
  if (existing) return existing;
  const next = createTranslator(locale, ...bundles);
  translators.set(locale, next);
  return next;
}
const widgetLabel = (t: Translator, feature: FeatureId) => t.t(`widget.${feature}.title`);
const variantLabel = (t: Translator, feature: FeatureId, variant: string) => {
  const option = previewVariants(feature).find(item => item.id === variant);
  return option?.id === 'no-menus' ? t.t('preview.family.empty')
    : option ? t.t(option.labelKey) : t.t('preview.family.normal');
};
const familyLabel = (t: Translator, family: PreviewSelection['family']) => t.t(`preview.family.${family}`);
const themeLabel = (t: Translator, theme: RunState['theme']) => t.t(theme === 'dark' ? 'settings.modeDarkName' : 'settings.modeLightName');
const closingLabel = (t: Translator, variant: ReturnType<typeof resolveClosingVariant>) =>
  familyLabel(t, variant === 'no-payments' ? 'empty' : variant);
const posLabel = (t: Translator, scenario: PreviewSelection['pos']) =>
  scenario === 'payment-failure' ? copy[t.locale].paymentFailure : familyLabel(t, scenario ?? 'normal');

type SettingsCommand = keyof AgentSettingsArgs;
type SettingChange = { [K in SettingsCommand]: { command: K; args: AgentSettingsArgs[K] } }[SettingsCommand];
type SettingsDraft = { readonly target: SettingChange; readonly locale?: Locale };
const change = <K extends SettingsCommand>(command: K, args: AgentSettingsArgs[K]) => ({ command, args }) as SettingChange;
const busy = (state: RunState) => state.posUi.approval?.status === 'pending' || state.edit.gesture !== null ||
  state.gesturePreview !== null || state.exitPendingToken !== null || state.closingInput !== null;

interface SettingPlan {
  readonly preview: AgentProposalPreview;
  same(state: RunState): boolean;
  apply(run: RunStore, restore?: boolean): boolean;
}
function planSetting({ command, args }: SettingChange, state: RunState, locale: Locale): SettingPlan | 'invalid' | 'unchanged' {
  const t = translator(locale), c = copy[locale];
  const labels = (title: string, label: string, before: string, after: string) =>
    ({ title, target: label, fields: [{ label, before, after }] });
  function display<K extends 'theme' | 'textScale' | 'locale' | 'detailDialogFullscreen'>(
    key: K, next: RunState[K], label: string, name: (value: RunState[K]) => string, setter: (run: RunStore, value: RunState[K]) => void,
  ) {
    const current = state[key];
    if (current === next) return 'unchanged' as const;
    return {
      preview: labels(t.t('settings.display'), label, name(current), name(next)),
      same: (now: RunState) => now[key] === current,
      apply(run: RunStore, restore = false) {
        const value = restore ? current : next;
        if (run.getState()[key] !== (restore ? next : current)) return false;
        setter(run, value);
        return run.getState()[key] === value;
      },
    };
  }
  switch (command) {
    case 'settings.set_theme': return display('theme', args.theme, t.t('settings.mode'), value => themeLabel(t, value), (r, v) => r.actions.setTheme(v));
    case 'settings.set_text_scale': return display('textScale', args.scale, t.t('ui.largeText.label'), value => value === 125 ? c.on : c.off, (r, v) => r.actions.setTextScale(v));
    case 'settings.set_locale': return display('locale', args.locale, t.t('common.language'), value => t.t(`language.${value}`), (r, v) => r.actions.setLocale(v));
    case 'settings.set_detail_fullscreen': return display('detailDialogFullscreen', args.fullscreen, t.t('common.viewDetails'), value => value ? c.detailFullscreen : c.compact, (r, v) => r.actions.setDetailDialogFullscreen(v));
  }

  const current = state.preview;
  let next: PreviewSelection, label: string, before: string, after: string;
  switch (command) {
    case 'settings.set_preview_family': {
      if (current.family === args.family && !Object.keys(current.overrides).length && current.pos === undefined) return 'unchanged';
      const selection = { ...current, family: args.family, overrides: {} };
      delete selection.pos;
      next = selection;
      label = t.t('common.previewStates');
      before = current.pos ? posLabel(t, current.pos) : familyLabel(t, current.family);
      after = familyLabel(t, args.family);
      break;
    }
    case 'settings.set_closing_preview': {
      if (current.closing === (args.scenario ?? undefined)) return 'unchanged';
      const selection = { ...current };
      if (args.scenario === null) delete selection.closing;
      else selection.closing = args.scenario;
      next = selection;
      label = t.t('settings.closing');
      before = closingLabel(t, resolveClosingVariant(current));
      after = closingLabel(t, resolveClosingVariant(next));
      break;
    }
    case 'settings.set_pos_preview': {
      const paymentFailure = args.scenario === 'payment-failure';
      if (current.pos === (args.scenario ?? undefined) && (!paymentFailure || current.family === 'normal' && !Object.keys(current.overrides).length)) return 'unchanged';
      const selection = { ...current, ...(paymentFailure ? { family: 'normal' as const, overrides: {} } : {}) };
      if (args.scenario === null) delete selection.pos;
      else selection.pos = args.scenario;
      next = selection;
      label = t.t('app.layer.orders');
      before = posLabel(t, current.pos);
      after = posLabel(t, next.pos);
      break;
    }
    default: {
      const feature = getRegistration(args.featureId)?.id;
      if (!feature || !previewVariants(feature).length) return 'invalid';
      const variant = command === 'settings.reset_widget_preview' ? current.family === 'normal' ? null : NORMAL_VARIANT : args.variant;
      if (variant !== null && variant !== NORMAL_VARIANT && !previewVariants(feature).some(option => option.id === variant)) return 'invalid';
      if (current.overrides[feature] === (variant ?? undefined)) return 'unchanged';
      const overrides = { ...current.overrides };
      if (variant === null) delete overrides[feature];
      else overrides[feature] = variant;
      next = { ...current, overrides };
      label = widgetLabel(t, feature);
      before = variantLabel(t, feature, resolveVariant(feature, current));
      after = variantLabel(t, feature, resolveVariant(feature, next));
    }
  }
  // Remember only the resulting selection reference for the receipt's inverse.
  let applied: PreviewSelection | undefined;
  const countBefore = Object.keys(current.overrides).length, countAfter = Object.keys(next.overrides).length;
  const preview = labels(c.sample, label, before, after);
  if (countBefore !== countAfter && (command === 'settings.set_preview_family' || command === 'settings.set_pos_preview')) {
    preview.fields.push({ label: t.t('preview.family.byWidget'), before: t.format.count(countBefore, 'count'),
      after: t.format.count(countAfter, 'count') });
  }
  if (command === 'settings.set_pos_preview' && current.family !== next.family) {
    preview.fields.push({ label: t.t('common.previewStates'), before: familyLabel(t, current.family), after: familyLabel(t, next.family) });
  }
  return {
    preview,
    same: latest => latest.preview === current,
    apply(run, restore = false) {
      if (restore) return !!applied && run.actions.setPreviewSelection(current, applied);
      if (!run.actions.setPreviewSelection(next, current)) return false;
      applied = run.getState().preview;
      return true;
    },
  };
}

const adapters = AGENT_SETTINGS_COMMANDS.map((command): RunCommandAdapter<SettingsDraft, AgentProposalPreview> => ({
  command,
  slots: {},
  resolve(args, slots) {
    if (!validateAgentToolArgs('propose_action', { command, args })) return;
    const locale = slots.navisLocale;
    return { target: change(command, args as AgentSettingsArgs[typeof command]),
      ...(locale === 'ko' || locale === 'en' || locale === 'zh-Hans' || locale === 'zh-Hant' ? { locale } : {}) };
  },
  preflight({ locale, target }, { run }): RunPreflight<AgentProposalPreview> {
    if (busy(run)) return { kind: 'busy' };
    const plan = planSetting(target, run, locale ?? run.locale);
    if (typeof plan === 'string') return { kind: plan };
    return { kind: 'ready', preview: plan.preview, execute(store) {
      const latest = store.getState();
      if (busy(latest)) return { kind: 'busy' };
      if (!plan.same(latest)) return { kind: 'conflict' };
      if (!plan.apply(store)) return { kind: 'busy' };
      return { kind: 'applied', undo: current => !busy(current.getState()) && plan.apply(current, true) };
    } };
  },
}));

const fact = (key: string, value: string | number, label: string, display = String(value), unit = ''): AgentFact => ({ key, value, label, display, unit });
type Section = NonNullable<AgentReadArgs['get_ui_state']['section']>;
function uiState(state: RunState, locale: Locale, section?: Section, target?: FeatureId): readonly AgentFact[] {
  const t = translator(locale), c = copy[locale], { preview, shopSettings: shop } = state;
  const facts: AgentFact[] = [];
  if (!section || section === 'display') facts.push(
    fact('ui.theme', state.theme, t.t('settings.mode'), themeLabel(t, state.theme)),
    fact('ui.textScale', state.textScale, t.t('ui.largeText.label'), state.textScale === 125 ? c.on : c.off, '%'),
    fact('ui.locale', state.locale, t.t('common.language'), t.t(`language.${state.locale}`)),
    fact('ui.detailFullscreen', Number(state.detailDialogFullscreen), t.t('common.viewDetails'), state.detailDialogFullscreen ? c.detailFullscreen : c.compact),
  );
  if (!section || section === 'preview') {
    const n = Object.keys(preview.overrides).length;
    facts.push(fact('ui.preview.family', preview.family, c.sample, familyLabel(t, preview.family)),
      fact('ui.preview.overrideCount', n, t.t('common.previewStates'),
        t.t('preview.family.byWidgetChip', { n }).replace(/^.+?[:：]\s*/u, '')),
      fact('ui.preview.closing', preview.closing ?? 'inherit', t.t('settings.closing'), closingLabel(t, resolveClosingVariant(preview))),
      fact('ui.preview.pos', preview.pos ?? 'inherit', t.t('app.layer.orders'), posLabel(t, preview.pos)));
    if (target) {
      const label = widgetLabel(t, target), override = preview.overrides[target];
      if (override) facts.push(fact(`ui.preview.override.${target}`, override, label, variantLabel(t, target, override)));
      for (const option of previewVariants(target)) facts.push(fact(`ui.preview.variant.${target}`, option.id, label, t.t(option.labelKey)));
    }
  }
  if (!section || section === 'shop') {
    if (shop.businessType) facts.push(fact('shop.businessType', shop.businessType, t.t('settings.business'), t.t(`ui.business.${shop.businessType}`)));
    if (shop.paymentStyle) facts.push(fact('shop.paymentStyle', shop.paymentStyle, t.t('step.payment'), t.t(`payment.${shop.paymentStyle}`)));
  }
  if (!section || section === 'pos') {
    const pending = state.posUi.approval?.status === 'pending';
    const tables = tablesEnabled(shop) && selectPosPreferences(shop).showTables;
    facts.push(
      fact('ui.pos.approvalPending', Number(pending), c.approval, pending ? c.approvalPending : c.approvalIdle),
      fact('ui.pos.tablesEnabled', Number(tables), t.t('step.tables'), tables ? c.on : c.off),
    );
  }
  return facts;
}

function readUiState(snapshot: DataSnapshot, locale: Locale, slots: LocalSlots, state?: RunState, section?: Section) {
  if (!state || snapshot.runId !== state.runId) return { status: 'unavailable' as const };
  const target = typeof slots.previewFeature === 'string' ? getRegistration(slots.previewFeature)?.id : undefined;
  return { facts: uiState(state, locale, section, target) };
}

const statusKeys = ['closing.status', 'closing.closedAt'];
const eligibilityKeys = ['closing.pendingBills', 'closing.canClose', 'closing.pendingReceived', 'closing.approvalPending'];
const drawerKeys = ['closing.drawer.expected', 'closing.drawer.actual', 'closing.drawer.difference'];
const historyKeys = ['closing.history.count', 'closing.history.latestDate'];
const closingFacts: NonNullable<DomainAdapter['projectSource']> = (snapshot, source, condition, locale, run) => {
  const date = snapshot.pos?.businessDate;
  if (source !== 'pos' || !date || condition.kind === 'snapshot' && condition.asOf !== date ||
    condition.kind === 'dateRange' && (date < condition.start || date > condition.end)) return;
  const t = translator(locale), c = copy[locale], data = selectPosClosing(snapshot, { date, scenario: 'normal' });
  const { pendingBills, received, drawer, history } = data;
  const closed = data.status === 'closed', approval = run?.posUi.approval?.status === 'pending';
  const canClose = data.canClose && !approval;
  const money = (key: string, label: string, value: number) => fact(key, value, label, t.format.money(value, 'full'), 'KRW');
  const count = (key: string, label: string, value: number) => fact(key, value, label, t.format.count(value, 'count'), 'count');
  return [
    fact('closing.status', data.status, c.closingStatus, closed ? c.closed : c.open),
    ...(closed && data.closedAt ? [fact('closing.closedAt', data.closedAt, c.closeTime, data.closedAt.slice(11, 16))] : []),
    fact('closing.canClose', Number(canClose), c.canClose, canClose ? c.ready : c.blocked),
    count('closing.pendingBills', c.unpaid, pendingBills.length),
    ...(received ? [money('closing.pendingReceived', c.amountReceived, received)] : []),
    ...(approval ? [fact('closing.approvalPending', 1, c.approval, c.approvalPending)] : []),
    money('closing.drawer.expected', c.expectedCash, drawer.expected),
    ...(drawer.actual === null ? [fact('closing.drawer.actual', 'unconfirmed', c.countedCash, c.unchecked)] : [money('closing.drawer.actual', c.countedCash, drawer.actual)]),
    ...(drawer.difference === null ? [] : [money('closing.drawer.difference', c.cashDiff, drawer.difference)]),
    count('closing.history.count', c.history, history.length),
    ...(history[0] ? [fact('closing.history.latestDate', history[0].businessDate, c.lastClosed)] : []),
  ].map(item => ({ ...item, date }));
};

type Intent = SettingChange
  | { section: Section; factKeys?: readonly string[] }
  | { closingKeys: readonly string[] }
  | { question: 'theme' | 'locale' }
  | { variant: FeatureId; ask: boolean }
  | { refusal: 'closeByOwner' | 'reopenByOwner' | 'drawerByOwner' | 'refundByOwner' | 'payAfterReopen' | 'settings';
      label?: string; alternative?: AgentHandoff };

const themeOf = (text: string) => /다크|ᄃᄏ|어둡|어두운|\bdark\b/iu.test(text) ? 'dark'
  : /라이트|밝게|밝은|\blight\b/iu.test(text) ? 'light' : undefined;
const localeOf = (text: string) => /번체|繁體|繁体|대만식|traditional/iu.test(text) ? 'zh-Hant'
  : /간체|简体|簡體|simplified/iu.test(text) ? 'zh-Hans'
  : /영어|\benglish\b/iu.test(text) ? 'en' : /한국어|\bkorean\b/iu.test(text) ? 'ko' : undefined;
const refusal = (name: Extract<Intent, { refusal: unknown }>['refusal'], label?: string, alternative?: AgentHandoff): Intent =>
  ({ refusal: name, label, alternative });
const closingHandoff = (command: 'closing.closeDay' | 'closing.undoDay' | 'pos.drawerMovement'): AgentHandoff =>
  ({ featureId: 'pos-closing', command, draft: {} });
const closing = (keys: readonly string[]): Intent => ({ closingKeys: keys });
const readUi = (section: Section, factKeys?: readonly string[]): Intent => ({ section, factKeys });

function intentFor(input: string, locale: Locale): Intent | undefined {
  const text = input.normalize('NFKC').trim();
  if (/하지\s*마|말아\s*줘|무시해|[“”"'‘’]|(?:그리고|동시에|한꺼번에)\s/u.test(text)) return;
  const asks = /[?？]$|지금|알려\s*줘|(?:있어|어때|돼 있어)\s*[.!]?$/u.test(text);
  const reset = /정상|원래대로|되돌려|해제|예시 상태 풀/u.test(text);
  const example = /예시|시연|\bpreview\b/iu.test(text);
  const empty = /비어|빈\s*상태|빈\s*화면|없(?:음|는)\s*상태/u.test(text);
  const error = /불러오기\s*실패|오류|에러/u.test(text);
  const partial = /일부.*(?:없|안\s*된)/u.test(text);
  const previewChange = /(?:(?:상태|걸|예시)로|비어\s*있음으로)\s*(?:(?:바꿔|변경해|설정해|전환해|해\s*(?:줘|주세요)|보여|되돌려|돌려).*)?[.!?]*$/u.test(text)
    || /비어\s*있게\s*해|(?:정상\s*으로|원래대로)\s*(?:(?:바꿔|해|되돌려|돌려).*)?[.!?]*$/u.test(text);
  const showVariant = /(?:오류|에러(?:\s*났을\s*때)?|실패(?:하는)?|비어\s*있는|빈|없(?:음|는|을\s*때)|특수(?:한)?|망가진)\s*(?:상태|화면|상황)\s*(?:보여|확인해\s*볼래|보고\s*싶)/u.test(text);
  const previewRequest = example || previewChange || showVariant;
  const isClosing = /마감|정산\s*이력|시재|금고|입출금|(?:예상|실제)\s*현금/u.test(text);
  if (/마감(?:했|한|\s*끝났).*(?:결제|계산).*(?:받아|추가|해\s*줘)/u.test(text)) return refusal('payAfterReopen');
  if (/(?:결제.*(?:환불|취소)|환불).*(?:해\s*줘|처리해|해\s*주세요)/u.test(text)) {
    return refusal('refundByOwner', undefined, { featureId: 'pos' });
  }
  if (isClosing) {
    if (/시재|금고|입출금/u.test(text) && /기록해|기록을?\s*(?:지워|삭제)|내역.*(?:추가|지워)|시재.*(?:입력|바꿔|으로\s*해)/u.test(text)) {
      return refusal('drawerByOwner', undefined, /시작/u.test(text) ? closingHandoff('pos.drawerMovement') : undefined);
    }
    if (/마감.*(?:되돌려|취소해|풀어)/u.test(text) && !example) return refusal('reopenByOwner', undefined, closingHandoff('closing.undoDay'));
    if (/마감.*(?:가능|해도\s*돼|못\s*하)|미결제.*남았/u.test(text)) return closing(eligibilityKeys);
    if (/마감.*(?:했어|됐는지|상태\s*어때|상태\?)/u.test(text) && !previewRequest) return closing(statusKeys);
    if (/마감.*(?:해\s*줘|눌러|처리해)|영업\s*종료해/u.test(text) && !example && !empty && !error && !reset)
      return refusal('closeByOwner', undefined, closingHandoff('closing.closeDay'));
    if (previewRequest && /마감/u.test(text)) {
      if (error) return change('settings.set_closing_preview', { scenario: 'error' });
      if (empty || /결제\s*내역.*없/u.test(text)) return change('settings.set_closing_preview', { scenario: 'no-payments' });
      if (reset) return change('settings.set_closing_preview', { scenario: 'normal' });
    }
    if (/시재|현금/u.test(text) && /얼마|차이|(?:예상|실제)\s*현금/u.test(text)) return closing(drawerKeys);
    if (/정산\s*이력|마감\s*이력/u.test(text) && asks && !/열어|보여/u.test(text)) return closing(historyKeys);
    return;
  }
  if (/업종|결제\s*방식|테이블\s*배치|가게\s*설정|매장\s*설정|주문\/결제\s*설정/u.test(text) &&
    !/열(?:어|고|기)|바꾸고\s*싶/u.test(text)) {
    if (asks || /선불이야|후불이야|뭐로/u.test(text)) return readUi('shop');
    if (/바꿔|변경|입력|해\s*줘|지워|켜|끄/u.test(text)) {
      return refusal('settings', /업종/u.test(text) ? 'settings.business' : /결제\s*방식/u.test(text) ? 'step.payment'
        : /테이블\s*배치/u.test(text) ? 'step.tables' : 'app.layer.orders', { featureId: 'settings' });
    }
  }
  const correction = text.split(/\s*말고\s*/u).at(-1)!;
  const directThemeQuestion = /^(?:지금\s*)?(?:다크|라이트)\s*(?:야|인가요|인지|인가|맞(?:아|나요))[.!?？]*$/u;
  if (directThemeQuestion.test(text)) return readUi('display', ['ui.theme']);
  const theme = /화면|모드|^(?:다크|라이트|ᄃᄏ|어둡게|밝게)(?:로|\s*(?:바꿔|해\s*줘|$))|다시\s*밝은|\b(?:light|dark)\s+mode\b/iu.test(text)
    ? themeOf(correction) : undefined;
  const themeQuestion = /(?:모드|화면)\s*(?:이?야|인가요|인(?:지|가)|(?:이|가)?\s*맞(?:아|나요))(?:\s|[.!?]|$)/u.test(text);
  if (theme && (themeQuestion || /이야\s*어두운/u.test(text) || asks && !/바꿔|변경해|전환해|설정해|해\s*(?:줘|주세요)/u.test(correction))) {
    return readUi('display', ['ui.theme']);
  }
  if (theme) return change('settings.set_theme', { theme });
  if (/화면\s*모드|^모드\s*바꿔|밝기\s*좀\s*바꿔/u.test(text)) return asks ? readUi('display', ['ui.theme']) : { question: 'theme' };
  if (/큰\s*글자|글[자씨짜]|\blarge text\b/iu.test(text)) {
    if (asks || /켜져/u.test(text)) return readUi('display', ['ui.textScale']);
    if (/꺼|작게|원래|줄여/u.test(text)) return change('settings.set_text_scale', { scale: 100 });
    if (/큰|크게|키워|\bon\b/iu.test(text)) return change('settings.set_text_scale', { scale: 125 });
  }
  if (/지금.*언어|언어.*(?:뭐|무엇|설정).*돼/u.test(text)) return readUi('display', ['ui.locale']);
  const lang = /언어|(?:영어|한국어|중국어|간체|번체)로|^(?:简体中文|簡體中文|繁體中文|繁体中文|English(?: please)?|Korean)[.!]?$/iu.test(text)
    ? localeOf(correction) : undefined;
  if (lang) return change('settings.set_locale', { locale: lang });
  if (/중국어|차이니즈/u.test(text)) return { question: 'locale' };
  if (/자세히\s*보기|상세\s*창/u.test(text) && /전체\s*화면|풀스크린|기본\s*크기/u.test(text))
    return change('settings.set_detail_fullscreen', { fullscreen: !/기본|꺼|원래/u.test(text) });
  if (previewRequest && /(?:결제|카드\s*승인).*실패/u.test(text))
    return change('settings.set_pos_preview', { scenario: 'payment-failure' });
  if (example && asks && !previewChange && !showVariant) return readUi('preview', ['ui.preview.family', 'ui.preview.overrideCount', 'ui.preview.pos']);
  if (previewRequest) {
    const t = translator(locale);
    const compact = text.toLowerCase().replace(/\s+/gu, '');
    // D-365: 마케팅 성과 is gone, so a request about its preview must not turn into a change for every widget.
    if (/마케팅\s*성과|성과\s*위젯/u.test(text)) return;
    const feature = getRegistry('A').find(item => [item.label, widgetLabel(t, item.id)].some(label => compact.includes(label.toLowerCase().replace(/\s+/gu, ''))))?.id;
    if (feature && !/예시\s*상태\s*보기\s*(?:열어|띄워)/u.test(text)) {
      const opts = previewVariants(feature);
      if (!opts.length) return;
      if (reset) return change('settings.reset_widget_preview', { featureId: feature });
      if (error && opts.some(option => option.id === 'error')) return change('settings.set_preview_variant', { featureId: feature, variant: 'error' });
      const named = opts.find(option => text.includes(t.t(option.labelKey)) &&
        (option.id !== 'error' || error));
      const variant = named?.id ?? (feature === 'inventory-booking' && partial ? 'partial-data' : undefined);
      if (variant) return change('settings.set_preview_variant', { featureId: feature, variant });
      if (empty) {
        const choices = opts.filter(option => option.family === 'empty');
        return choices.length === 1 ? change('settings.set_preview_variant', { featureId: feature, variant: choices[0].id })
          : { variant: feature, ask: true };
      }
      if (/상태|망가진/u.test(text) && !/열어\s*줘$/u.test(text)) return { variant: feature, ask: false };
    }
    if (example || /패널|상태/u.test(text)) {
      if (reset) return change('settings.set_preview_family', { family: 'normal' });
      if (error) return change('settings.set_preview_family', { family: 'error' });
      if (/특수|일부\s*자료\s*없음/u.test(text)) return change('settings.set_preview_family', { family: 'special' });
      if (empty) return change('settings.set_preview_family', { family: 'empty' });
    }
  }
}

function routeSettings(input: string, locale: Locale, state?: RunState): DomainRoute | undefined {
  const intent = intentFor(input, locale);
  if (!intent) return;
  const c = copy[locale], t = translator(locale);
  if ('refusal' in intent) {
    const answer = intent.refusal === 'settings' ? c.inSettings(t.t(intent.label ?? 'common.settings')) : c[intent.refusal];
    return { kind: 'refusal', reason: 'widget_only', answer, ...(intent.alternative ? { alternative: intent.alternative } : {}) };
  }
  if ('closingKeys' in intent) return {
    intent: { kind: 'read', sourceId: 'pos', condition: { kind: 'default' } }, factKeys: intent.closingKeys,
  };
  if ('section' in intent) return {
    intent: { kind: 'read', tool: 'get_ui_state' },
    reading: { tool: 'get_ui_state', args: { section: intent.section } },
    factKeys: intent.section === 'preview' && state ? [
      'ui.preview.family',
      ...(Object.keys(state.preview.overrides).length ? ['ui.preview.overrideCount'] : []),
      ...(state.preview.pos !== undefined ? ['ui.preview.pos'] : []),
    ] : intent.factKeys,
  };
  if ('question' in intent) {
    const field = intent.question;
    return { kind: 'clarification', field, answer: field === 'theme' ? c.themeQuestion : c.localeQuestion,
      resume(value, current = state) {
        if (!current) return;
        const choice = value.normalize('NFKC').trim();
        if (field === 'theme') {
          const theme = themeOf(choice);
          return theme ? proposal(change('settings.set_theme', { theme }), current, locale) : undefined;
        }
        const language = localeOf(choice);
        return language ? proposal(change('settings.set_locale', { locale: language }), current, locale) : undefined;
      } };
  }
  if ('variant' in intent) {
    const feature = intent.variant, label = widgetLabel(t, feature);
    const options = previewVariants(feature), choices = options.map(option => t.t(option.labelKey)).join(' · ');
    if (!intent.ask) return { kind: 'answer', answer: c.variantOptions(label, choices) };
    return { kind: 'clarification', field: 'variant', answer: c.variantQuestion(label, choices),
      resume(value, current = state) {
        const selected = options.find(option => t.t(option.labelKey) === value || option.id === value);
        return selected && current ? proposal(change('settings.set_preview_variant', { featureId: feature, variant: selected.id }), current, locale) : undefined;
      } };
  }
  return state ? proposal(intent, state, locale) : undefined;
}

function proposal(intent: SettingChange, state: RunState, locale: Locale): DomainRoute {
  const plan = planSetting(intent, state, locale);
  if (plan === 'unchanged') {
    const t = translator(locale);
    const value = intent.command === 'settings.set_theme' ? themeLabel(t, state.theme)
      : intent.command === 'settings.set_locale' ? t.t(`language.${state.locale}`) : undefined;
    return { kind: 'answer', answer: value ? copy[locale].already(value) : t.t('common.navis.agent.unchanged'), cancelPending: true };
  }
  if (plan === 'invalid') return { kind: 'refusal', reason: 'invalid_target' };
  if (busy(state)) return { kind: 'refusal', reason: 'unavailable', answer: translator(locale).t('common.navis.agent.busy') };
  const feature = 'featureId' in intent.args ? getRegistration(intent.args.featureId)?.id : undefined;
  const section = intent.command.includes('preview') ? 'preview' : 'display';
  const extra: AgentReadProjection = { tool: 'get_ui_state', args: { section: 'pos' }, facts: uiState(state, locale, 'pos') };
  return {
    intent: { kind: 'command', ...intent },
    page: state.boards[state.activeBoard].currentPage + 1,
    ...(feature ? { slots: { previewFeature: feature } } : {}),
    reading: { tool: 'get_ui_state', args: { section } },
    additionalReadings: [extra],
  };
}

export const settingsDomain: DomainAdapter = {
  commands: [], reads: [], runCommands: adapters,
  tools: [{ tool: 'get_ui_state', read: (snapshot, args, locale, slots, _targets, run) =>
    readUiState(snapshot, locale, slots, run, (args as AgentReadArgs['get_ui_state']).section) }],
  routePresentation: (text, _snapshot, locale, run) => routeSettings(text, locale, run),
  projectSource: closingFacts,
  navigation: (text, _snapshot, locale) => intentFor(text, locale) ? null : undefined,
};
