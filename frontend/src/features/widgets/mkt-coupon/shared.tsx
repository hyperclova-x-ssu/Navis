/**
 * Shared pieces of the mkt-coupon folder (T-059): translator, M-27 value highlight, panel/detail state views,
 * the send phase machine (confirm -> sending 600 ms -> sent), idempotency keys and the focus-on-action helper.
 * No RunStore here: widgets talk to the data store through the hooks and to the shell through the host.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { DetailRef, MessageParams, WidgetHost } from '../../../contracts';
import { useAccountController } from '../../../app/account-context-value';
import { koreanScreenText, useBundle } from '../../../i18n';
import type { Formatters, Translator } from '../../../i18n';
import { useOptionalWidgetDataStore, useWidgetDataStore } from '../../../data/react';
import { dataBundle, resolveDataText, type DataCommandResult, type DataText } from '../../../data/widget-data';
import type { WidgetView } from '../../../data/widget-data';
import { ActionButton, Icon, PanelState, StatusBadge, maskName, motionTokens, useKitT, useUi } from '../../../ui';
import { mktCouponBundle } from './messages';
import { koreanLang, keepKoreanDots } from '../mkt-local/fit';
import './widget.css';

export interface Mkt {
  readonly locale: string;
  readonly t: (key: string, params?: MessageParams) => string;
  readonly f: Formatters;
  /** Resolves a data text (message key + params, or raw owner text). */
  readonly dt: (text: DataText | null | undefined) => string;
  readonly money: (won: number) => string;
  readonly count: (n: number, unit: 'person' | 'pcs' | 'count') => string;
}

/** Translator for this folder: data bundle (names, sms bodies, state sentences) + folder bundle + common bundle. */
export function useMkt(): Mkt {
  const tr = useBundle(dataBundle, mktCouponBundle) as unknown as Translator;
  return useMemo(() => {
    const t = (key: string, params?: MessageParams) => tr.locale === 'ko' ? keepKoreanDots(tr.t(key, params)) : tr.t(key, params);
    return {
      locale: tr.locale,
      t,
      f: tr.format,
      dt: (text) => resolveDataText((key, params) => t(key, params), text),
      money: (won) => tr.format.money(won, 'full'),
      count: (n, unit) => tr.format.count(n, unit),
    };
  }, [tr]);
}

/**
 * D-333: how many real list rows a coupon panel may build. 2-high cards keep the budget they always had (`base`); 3-high cards list twice as many; 4-high cards
 * list every row the data holds (the extra ones are marked `data-mkt-extra`, and the fit guard drops them first when the card is tight).
 */
export function listRows(shape: string, height: number, base = 3, cap = Number.POSITIVE_INFINITY): number {
  if (shape !== 'S' && shape !== 'L') return base;
  return Math.min(cap, height >= 4 ? Number.POSITIVE_INFINITY : height === 3 ? base * 2 : base);
}
export const extraRow = (index: number, base = 3): { readonly 'data-mkt-extra'?: '' } => (index >= base ? { 'data-mkt-extra': '' } : {});

/** Large text (125%) shape facts shared by the four panels. */
export function usePanelMode(shape: string, editing: boolean) {
  const { textScale } = useUi();
  return { large: textScale === 125, minStage: (textScale === 125 ? 1 : 0) as 0 | 1, isQ: shape === 'Q', isW: shape === 'W', editing };
}

const keptByStore = new WeakMap<object, Map<string, unknown>>();
/**
 * H5: a choice made in a detail (who is unchecked) survives closing and reopening it. The value is kept per data store, so a new run starts clean,
 * and the widget clears it itself when a send makes the choice obsolete.
 */
export function useKept<T>(key: string, initial: T): readonly [T, (next: T) => void] {
  const store = useWidgetDataStore();
  const [value, setValue] = useState<T>(() => (keptByStore.get(store)?.has(key) ? keptByStore.get(store)!.get(key) as T : initial));
  const set = (next: T) => {
    let kept = keptByStore.get(store);
    if (!kept) { kept = new Map(); keptByStore.set(store, kept); }
    kept.set(key, next);
    setValue(next);
  };
  return [value, set];
}

let sequence = 0;
/** One key per opened form (SWARM: a one-time command needs an idempotencyKey created when the form opens). */
export const nextKey = (prefix: string): string => `${prefix}-${++sequence}`;
export function useFormKey(prefix: string): readonly [string, () => void] {
  const [key, setKey] = useState(() => nextKey(prefix));
  return [key, () => setKey(nextKey(prefix))];
}

/** M-27: a changed value gets the selection fill for 800 ms (no highlight on first render). Block level so MetricFit keeps its parent width. */
export function Live({ value, children, className = '' }: { readonly value: unknown; readonly children: ReactNode; readonly className?: string }) {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (Object.is(previous.current, value)) return undefined;
    previous.current = value;
    setChanged(true);
    const timer = window.setTimeout(() => setChanged(false), motionTokens.valueFlashHoldMs);
    return () => window.clearTimeout(timer);
  }, [value]);
  return <div className={`mkt-live ${className}`} data-changed={changed ? 'true' : undefined}>{children}</div>;
}

/** Inline variant for table cells and sentences. */
export function LiveText({ value, children }: { readonly value: unknown; readonly children: ReactNode }) {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (Object.is(previous.current, value)) return undefined;
    previous.current = value;
    setChanged(true);
    const timer = window.setTimeout(() => setChanged(false), motionTokens.valueFlashHoldMs);
    return () => window.clearTimeout(timer);
  }, [value]);
  return <span className="mkt-live-inline" data-changed={changed ? 'true' : undefined}>{children}</span>;
}

/** DS 11.5 state of a panel that is not `ready`: the message (and at most one action). Pressing never turns the sample state normal except retry. */
export function PanelNotReady({ view, widgetName, host, shape, width, onEmptyAction, emptyActionLabel, shortMessage }: {
  readonly shortMessage?: ReactNode;
  /** a shorter name for the empty-state button when the data bundle's name does not fit the 1x1 panel */ readonly emptyActionLabel?: string;
  readonly view: Exclude<WidgetView<unknown>, { status: 'ready' }>; readonly widgetName: string; readonly host: WidgetHost; readonly width: number; readonly shape: 'Q' | 'W' | 'T' | 'S' | 'L'; readonly onEmptyAction?: () => void;
}) {
  const { t, locale } = useMkt();
  const stateMessage = locale === 'ko' ? t(view.messageKey).replace(/ · /g, '\u00a0·\u00a0') : t(view.messageKey);
  if (view.status === 'error') return <div className="mkt-state"><PanelState tone="error" shape={shape} message={locale === 'ko' && (shape === 'Q' || (shape === 'W' && width <= 2)) ? t('widget.coupon.state.error.short') : stateMessage} shortMessage={t('widget.coupon.state.error.short')} action={{ label: t('common.retry'), widgetName, onPress: () => host.resetPreview() }} /></div>;
  return <div className="mkt-state"><PanelState tone="info" shape={shape} message={stateMessage} shortMessage={shortMessage} action={onEmptyAction && (emptyActionLabel || view.actionKey) ? { label: emptyActionLabel ?? t(view.actionKey!), widgetName, onPress: onEmptyAction } : undefined} /></div>;
}

/** Detail body for empty / error views (SCR-29 pattern inside a detail). */
export function DetailNotReady({ view, host, onEmptyAction, next }: {
  readonly view: Exclude<WidgetView<unknown>, { status: 'ready' }>; readonly host: WidgetHost; readonly onEmptyAction?: () => void;
  /** An empty state that has no action in the data text writes its next step and offers the button for it (A10). */ readonly next?: { readonly text: string; readonly label: string; readonly onPress: () => void };
}) {
  const { t } = useMkt();
  const error = view.status === 'error';
  return <div className="mkt-detail-state" data-tone={error ? 'error' : 'info'}>
    <p role={error ? 'alert' : 'status'}><Icon name={error ? 'error' : 'info'} aria-hidden />{t(view.messageKey)}</p>
    {error ? <ActionButton variant="secondary" onClick={() => host.resetPreview()}>{t('common.retry')}</ActionButton>
      : view.actionKey && onEmptyAction ? <ActionButton variant="secondary" onClick={onEmptyAction}>{t(view.actionKey)}</ActionButton>
        : next ? <><p className="mkt-detail-state__next">{next.text}</p><ActionButton variant="secondary" onClick={next.onPress}>{next.label}</ActionButton></> : null}
  </div>;
}

/** ‘확인 필요’ badge + the note sentences of a partial sample state. */
/** Keep a spaced separator with NBSP, and an unspaced separator with a zero-width word joiner. */
export const keepDots = (value: string): string => keepKoreanDots(value).replace(/([^\s\u2060])·/gu, '$1\u2060·');

export function NoteLine({ notes, compact = false }: { readonly notes: readonly { readonly messageKey: string; readonly params?: MessageParams }[] | undefined; readonly compact?: boolean }) {
  const { t } = useMkt();
  if (!notes || notes.length === 0) return null;
  return <div className="mkt-note">{notes.map((note) => { const sentence = t(note.messageKey, note.params); return <p key={note.messageKey}><StatusBadge kind="needsReview" /> <span className={`mkt-note__sentence${compact ? ' ui-sr-only' : ''}`} lang={koreanLang(sentence)}>{keepDots(sentence)}</span></p>; })}</div>;
}

export function SentStatus() {
  const { t } = useMkt();
  return <p className="ui-confirm-step__status" role="status"><Icon name="check" aria-hidden />{t('data.notices.notice.scheduled')}</p>;
}

export type Phase = 'form' | 'confirm' | 'sending' | 'sent';
/** confirm -> (press) sending for one step interval (static text, M-31) -> sent. Sending has no undo. */
export function useSendPhase() {
  const [phase, setPhase] = useState<Phase>('form');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const startSending = () => {
    setPhase('sending');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPhase('sent'), motionTokens.stepMs);
  };
  return { phase, setPhase, startSending };
}

/** Result of a command to the owner: success notice through the host (undo token only for pause / resume / extend), or the failure sentence. */
export function reportResult(result: DataCommandResult, host: WidgetHost, t: (key: string, params?: MessageParams) => string, fallbackKey: string): string | null {
  if (!result.ok) return t(result.messageKey);
  host.notify({ kind: 'success', messageKey: result.noticeKey ?? fallbackKey, ...(result.params ? { params: result.params } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
  return null;
}

/** `focus:'action'` (and the matching `view`) opens the detail with the first control of the main action focused. */
export function useActionFocus(ref: RefObject<HTMLElement | null>, detailRef: DetailRef, views: readonly string[] = []) {
  const wanted = detailRef.focus === 'action' || (detailRef.view !== undefined && views.includes(detailRef.view));
  useEffect(() => {
    if (!wanted) return;
    // The control that already holds the roving tab stop (the chosen chip) comes first: the form can open on a later slot than the first chip.
    const scope = ref.current?.querySelector<HTMLElement>('[data-first-control]');
    const first = scope?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
      ?? scope?.querySelector<HTMLElement>(':is(input:not([disabled]),button:not([disabled]),[role="slider"],[tabindex="0"])');
    first?.focus();
    // opening only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return wanted;
}

function CouponSmsFixedLine({ part, storeName, customerOnly, descriptionId }: { readonly part: 'ad' | 'optout'; readonly storeName?: string; readonly customerOnly?: boolean; readonly descriptionId?: string }) {
  const { t } = useMkt();
  const ad = part === 'ad';
  return <p className={`ui-sms-preview__fixed ui-sms-preview__${part}`} data-fixed={part}>
    <span lang="ko"><strong>{ad ? '(광고)' : '무료수신거부'}</strong>{ad && storeName ? ` ${storeName}` : null}</span>
    {!customerOnly && <span id={descriptionId} aria-hidden={descriptionId ? true : undefined} className="mkt-sms-help">
      {t(ad ? 'widget.slot-coupon.adHelp' : 'widget.slot-coupon.optOutHelp')}
    </span>}
  </p>;
}

function useCouponStoreName() {
  const account = useAccountController();
  const store = useOptionalWidgetDataStore();
  const fixture = account === null && !(store?.real && (['coupons', 'groups', 'inbox'] as const).some(domain => store.real?.mode(domain) === 'http'));
  const fixtureName = () => fixture ? store?.getSnapshot().tables.marketing.promoStore[0]?.name : undefined;
  const name = useSyncExternalStore(store?.subscribe ?? noStoreSubscription, fixtureName, fixtureName);
  return account?.storeName ?? name;
}

const noStoreSubscription = () => () => undefined;

export function SmsSetupHelp({ openSettings, settingsPath }: { readonly openSettings?: WidgetHost['openSettings']; readonly settingsPath?: boolean }) {
  const { t } = useMkt();
  return <div className="mkt-sms-setup">
    <p className="mkt-reason">{t(settingsPath ? 'widget.customer-groups.smsSetup' : 'widget.slot-coupon.smsSetup')}</p>
    {openSettings && <ActionButton variant="secondary" onClick={openSettings}>{t(settingsPath ? 'widget.customer-groups.openSettings' : 'widget.slot-coupon.openSettings')}</ActionButton>}
  </div>;
}

export function EditableSmsPreview({ body, onBodyChange, recipientCount }: { readonly body: string; readonly onBodyChange: (value: string) => void; readonly recipientCount?: number }) {
  const kit = useKitT();
  const storeName = useCouponStoreName();
  const id = useId();
  const customerOnly = recipientCount === undefined;
  const adHelp = `${id}-ad`;
  const optOutHelp = `${id}-optout`;
  const countLine = kit.t('ui.sms.line', { n: recipientCount ?? 0 });
  return <div className="mkt-sms-preview">
    <div className="ui-sms-preview" role="group" aria-label={kit.t('marketing.messagePreview')}>
      <CouponSmsFixedLine part="ad" storeName={storeName} customerOnly={customerOnly} descriptionId={customerOnly ? undefined : adHelp} />
      <div className="ui-field ui-sms-preview__body">
        <label className="ui-field__label" htmlFor={id}>{kit.t('ui.sms.bodyLabel')}</label>
        <div className="ui-field__control">
          <textarea id={id} className="ui-text-input ui-textarea" rows={3} value={body}
            aria-describedby={customerOnly ? undefined : `${adHelp} ${optOutHelp}`} onChange={event => onBodyChange(event.currentTarget.value)} />
        </div>
      </div>
      <CouponSmsFixedLine part="optout" customerOnly={customerOnly} descriptionId={customerOnly ? undefined : optOutHelp} />
      {!customerOnly && <p className="ui-sms-preview__line">{kit.locale === 'ko' ? koreanScreenText(countLine) : countLine}</p>}
    </div>
  </div>;
}

/** Read-only preview for expiry coupons and ending-soon reminders. */
export function FixedSmsPreview({ body, recipientCount, customerOnly }: { readonly body: string; readonly recipientCount: number; readonly customerOnly?: boolean }) {
  const { t, locale } = useMkt();
  const kit = useKitT();
  const storeName = useCouponStoreName();
  return <div className="ui-sms-preview mkt-sms-fixed" role="group" aria-label={t('marketing.messagePreview')}>
    <CouponSmsFixedLine part="ad" storeName={storeName} customerOnly={customerOnly} />
    <p className="mkt-sms-fixed__body">{body}</p>
    <CouponSmsFixedLine part="optout" customerOnly={customerOnly} />
    {locale !== 'ko' && !customerOnly ? <p className="ui-sms-preview__line">{kit.t('ui.sms.line', { n: recipientCount })}</p> : null}
  </div>;
}

/** Slot label ‘화 10~12시’ from a quiet slot. */
export function slotLabel(f: Formatters, slot: { readonly date: string; readonly startHour: number; readonly endHour: number }): string {
  return `${f.weekday(slot.date, 'short')} ${f.hourRange(slot.startHour, slot.endHour)}`;
}

/** RecipientList masks names itself (first character + circles); an already masked English name ‘Kim ○○’ would lose its letters, so the full name leads the meta line then. */
export function recipientMeta(display: string, meta: string): string {
  return maskName(display) === display ? meta : `${display}\u00A0·\u00A0${meta}`;
}
