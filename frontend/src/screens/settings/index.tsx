import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { BusinessType, FeatureId, Locale, PreviewFamily, RunState, RunStore, TableLayout } from '../../contracts';
import { useBundle } from '../../i18n';
import { getRegistration } from '../../catalog';
import {
  ActionButton, ChoiceSubview, ContentCrossfade, ContentRecovery, DialogFrame, Icon, IconButton, LanguageSelect, LanguageSelectRow,
  LargeTextControl, ListSelectRow, SettingRow, OnboardingFooter, OverlayExitSurface, ThemeTabs, ScrollArea, consumeDismissSequence, useKitT, useUi, type CloseReason, type PresetLayout,
} from '../../ui';
import { ALL_DATA_WIDGET_IDS, NORMAL_VARIANT, previewVariantBundle, previewVariants, resolveVariant, variantLabelKey } from '../../data/widget-data';
import { BusinessOptions, type SessionActions } from '../onboarding';
import { TableEditor } from '../onboarding/TableEditor';
import type { TableSettingsPanelProps } from '../../ui/components/table-grid-editor';
import { iteration5Bundle } from '../onboarding/messages';
import { SessionActionsContext } from '../../app/session-actions';
import { createTableLayout, tableLayoutEnabled } from '../../layout/table-layout';
import { useAccountController } from '../../app/account-context-value';
import { resolveClosingVariant } from '../../data/widget-data';
import { useShellT } from './use-shell-t';
import { shellBundle } from './messages';
import { posBundle } from '../../i18n/messages/pos';
import { clearSettingsStart, peekSettingsStart, openUnpaidOrders, previewStatesEnabled } from './start-view';
import { selectPosPreferences } from '../../pos/tables';
import { tableFailureKey } from '../order/tables/actions';
import { tableTransferBundle } from '../order/tables/messages';
import { OrderPreferences } from './OrderPreferences';
import './settings.css';

export { ExampleStateChipForRun } from './ExampleChip';

export interface SettingsOverlayProps {
  readonly run: RunStore;
  readonly sessionActions?: Pick<SessionActions, 'updateSettings'>;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly returnFocusKey?: string;
  readonly tableLinkPicker?: TableSettingsPanelProps['linkPicker'];
  readonly tableLinkError?: string | null;
  /** Development-only AC-143 injection; ignored by production builds. */
  readonly verification?: { readonly failContent: boolean; readonly onRetry: () => void };
}
/** overview, then one level down (business, language, preview) and a second level under preview (by-widget, one widget). */
type View = 'stores' | 'pos-preferences' | 'pos-approval' | 'overview' | 'business' | 'payment' | 'tables' | 'closing' | 'language' | 'preview' | 'by-widget' | `widget:${string}`;
type Announcement = { readonly key: 'language.changed' | 'preview.family.changed' | 'settings.businessChanged' | 'settings.changed'; readonly business?: BusinessType; readonly value?: string; readonly n: number };
interface BodyProps {
  readonly run: RunStore; readonly state: RunState; readonly view: View; readonly setView: (view: View) => void; readonly onClose: () => void;
  readonly onChoose: (type: BusinessType, event: React.MouseEvent<HTMLButtonElement>) => void; readonly announce: (key: Announcement['key'], value?: string) => void;
  readonly interactive?: boolean; readonly highlightBusiness?: boolean; readonly failContent?: boolean; readonly updateSettings?: SessionActions['updateSettings'];
}
const noop = () => undefined;
const applied = (result:unknown):boolean => result===true || !!result && typeof result==='object' && 'ok' in result && result.ok===true;
const tablePopupStyle={width:'calc(var(--canvas-width) - var(--detail-inset) * 2)',height:'calc(var(--canvas-height) - var(--detail-inset) * 2)',maxWidth:'none',maxHeight:'none'} as const;
const parentOf = (view: View): View => view === 'closing' || view === 'pos-approval' ? 'by-widget' : view === 'by-widget' ? 'preview' : view.startsWith('widget:') ? 'by-widget' : 'overview';
const widgetOf = (view: View): FeatureId | null => view.startsWith('widget:') ? view.slice(7) as FeatureId : null;

function focusTarget(scope: ParentNode, explicit: HTMLElement | null | undefined, key: string) {
  if (explicit?.isConnected) return explicit;
  return Array.from(scope.querySelectorAll<HTMLElement>('[data-focus-key]')).find(element => element.dataset.focusKey === key)
    ?? scope.querySelector<HTMLElement>('main h1');
}
function dialogHeight(_view: View, _textScale: RunState['textScale'], layout: PresetLayout | null) {
  if (!layout) return undefined;
  return layout.settings.height;
}
/** The sub-views keep the overview's 640 height (SCR-28); their body scrolls. */
function useViewText(view: View) {
  const { t } = useBundle(shellBundle, previewVariantBundle, iteration5Bundle, posBundle);
  const widget = widgetOf(view);
  const title = view === 'stores' ? t('settings.switchStore') : view === 'pos-preferences' ? t('pos.settingsTitle') : view === 'pos-approval' ? t('pos.approvalExample') : view === 'payment' ? t('step.payment') : view === 'tables' ? t('step.tables') : view === 'closing' ? t('settings.closing') : view === 'business' ? t('settings.business') : view === 'language' ? t('common.language') : view === 'preview' ? t('common.previewStates')
    : view === 'by-widget' ? t('settings.byWidgetTitle') : widget ? t(`widget.${widget}.title` as never) : t('common.settings');
  return { title, description: undefined };
}

function WidgetVariantList({ state, setView, interactive }: { readonly state: RunState; readonly setView: (view: View) => void; readonly interactive: boolean }) {
  const { t } = useBundle(shellBundle, previewVariantBundle, iteration5Bundle, posBundle);
  // The registry and previewVariants own the current list; closing is a separate target.
  // D-365: a data id without a catalog widget (마케팅 성과's model stays for the chat) has nothing to preview.
  const widgets = ALL_DATA_WIDGET_IDS.filter((id): id is Exclude<typeof id, 'marketing-performance'> => Boolean(getRegistration(id)));
  const listed = widgets.filter(id => previewVariants(id).length >= 2);
  const hidden = widgets.length - listed.length;
  const valueOf = (id: FeatureId) => { const variant = resolveVariant(id, state.preview); return variant === NORMAL_VARIANT ? t('preview.family.normal') : t(variantLabelKey(id as never, variant) as never); };
  return <section className="settings-by-widget" aria-label={t('settings.byWidgetTitle')}>
    {hidden > 0 ? <p className="settings-description">{t('preview.family.singleHidden')}</p> : null}
    <div className="settings-by-widget__list">{listed.map(id => <ListSelectRow key={id} label={t(`widget.${id}.title`)} value={valueOf(id)} onPress={interactive ? () => setView(`widget:${id}`) : noop} />)}<ListSelectRow label={t('settings.closing')} value={resolveClosingVariant(state.preview)==='normal'?t('preview.family.normal'):resolveClosingVariant(state.preview)==='error'?t('settings.error'):t('settings.empty')} onPress={interactive ? () => setView('closing') : noop} /><span lang="ko"><ListSelectRow label={t('pos.approvalExample')} value={t(state.preview.pos==='payment-failure'?'pos.paymentFailure':'preview.family.normal')} onPress={interactive?()=>setView('pos-approval'):noop}/></span></div>
  </section>;
}

function WidgetVariantChoice({ run, state, featureId, onBack, onClose, interactive, announce }: { readonly run: RunStore; readonly state: RunState; readonly featureId: FeatureId; readonly onBack: () => void; readonly onClose: () => void; readonly interactive: boolean; readonly announce: BodyProps['announce'] }) {
  const { t } = useBundle(shellBundle, previewVariantBundle);
  const options = [{ value: NORMAL_VARIANT, label: t('preview.family.normal') }, ...previewVariants(featureId).map(variant => ({ value: variant.id, label: t(variant.labelKey as never) }))];
  const current = resolveVariant(featureId, state.preview);
  const familyDefault = resolveVariant(featureId, { family: state.preview.family, overrides: {} });
  return <ChoiceSubview<string> title={t(`widget.${featureId}.title` as never)} value={current} options={options} onBack={onBack} onClose={onClose} onChange={next => {
    if (!interactive) return;
    // Picking what the family would show anyway clears the widget's own pick.
    run.actions.setPreviewVariant(featureId, next === familyDefault ? null : next);
    announce('preview.family.changed');
  }} />;
}

function SettingsBody({ run, state, view, setView, onClose, onChoose, announce, updateSettings, interactive = true, highlightBusiness = false, failContent = false }: BodyProps) {
  if (failContent) throw new Error('Settings body verification failure');
  const { t } = useBundle(shellBundle, previewVariantBundle, iteration5Bundle, posBundle);
  const kit = useKitT();
  const picks = Object.keys(state.preview.overrides).length;
  // REAL-PLAN F00: stores and sign-out exist only when the account runs over HTTP.
  const account = useAccountController();
  const [switching, setSwitching] = useState(false);
  const unpaid = state.pos.bills.some(bill => bill.status === 'open' || bill.status === 'partial');
  const posPreferences = selectPosPreferences(state.shopSettings);
  const widget = widgetOf(view);
  const back = interactive ? () => setView(parentOf(view)) : noop;
  const close = interactive ? onClose : noop;
  let body;
  if (view === 'pos-preferences') body = <OrderPreferences run={run} onBack={back} onClose={close} interactive={interactive}/>;
  else if (view === 'business') body = <BusinessOptions value={state.businessType} compact focusOnMount={interactive} onChoose={onChoose} />;
  else if (view === 'payment') body = <ChoiceSubview title={t('step.payment')} value={state.shopSettings.paymentStyle ?? 'prepaid'} options={(['prepaid','postpaid'] as const).map(value=>({value,label:t(`payment.${value}`),description:t(`payment.${value}.description`)}))} onBack={back} onClose={close} onChange={paymentStyle=>{if(interactive && applied(updateSettings?.({...state.shopSettings,paymentStyle})))announce('settings.changed',t(`payment.${paymentStyle}`));}} />;
  else if (view === 'pos-approval') body = <div lang="ko"><ChoiceSubview title={t('pos.approvalExample')} value={state.preview.pos==='payment-failure'?'payment-failure':'normal'} options={[{value:'normal',label:t('preview.family.normal')},{value:'payment-failure',label:t('pos.paymentFailure'),lang:'ko'}]} onBack={back} onClose={close} onChange={value=>{if(interactive)run.actions.setPosPreview(value as 'normal'|'payment-failure');}}/></div>;
  else if (view === 'closing') body = <ChoiceSubview title={t('settings.closing')} value={resolveClosingVariant(state.preview)} options={[{value:'normal',label:t('preview.family.normal')},{value:'no-payments',label:t('settings.empty')},{value:'error',label:t('settings.error')}]} onBack={back} onClose={close} onChange={value=>{if(interactive)run.actions.setClosingPreview(value);}} />;
  else if (view === 'stores' && account) body = <ChoiceSubview title={t('settings.switchStore')} value={account.stores.find(store => store.current)?.storeId ?? ''} options={account.stores.map(store => ({ value: store.storeId, label: store.name }))} onBack={back} onClose={close} onChange={storeId => { if (!interactive || switching || storeId === account.stores.find(store => store.current)?.storeId) return; setSwitching(true); void account.switchStore(storeId).catch(() => setSwitching(false)); }} />;
  else if (view === 'language') body = <LanguageSelect locale={state.locale} onBack={back} onClose={close} onChange={(next: Locale) => { if (!interactive || next === state.locale) return; if (run.actions.setLocale(next)) announce('language.changed'); }} />;
  else if (view === 'preview') body = <>
    <ChoiceSubview<string> title={t('common.previewStates')} value={state.preview.pos==='payment-failure'?'payment-failure':state.preview.family} onBack={back} onClose={close} options={[...(['normal','empty','error','special'] as const).map(value=>({value,label:t(`preview.family.${value}`),description:value==='special'?t('preview.family.specialHint'):undefined})),{value:'payment-failure',label:t('pos.paymentFailure'),lang:'ko'}]} onChange={value=>{if(!interactive)return;if(value==='payment-failure'){run.actions.setPreviewFamily('normal');run.actions.setPosPreview('payment-failure');}else{run.actions.setPosPreview(null);run.actions.setPreviewFamily(value as PreviewFamily);}announce('preview.family.changed');}}/>
    <div className="settings-by-widget-row"><ListSelectRow label={t('settings.byWidgetTitle')} value={picks > 0 ? t('unit.item', { n: picks }) : t('settings.byWidgetNone')} onPress={interactive ? () => setView('by-widget') : noop} /></div>
  </>;
  else if (view === 'by-widget') body = <WidgetVariantList state={state} setView={setView} interactive={interactive} />;
  else if (widget) body = <WidgetVariantChoice run={run} state={state} featureId={widget} onBack={back} onClose={close} interactive={interactive} announce={announce} />;
  else body = <div className="settings-sections">
    <div role="group" aria-label={t('settings.store')}><h3>{t('settings.store')}</h3>
    {account && account.stores.length > 1 ? <ListSelectRow label={t('settings.switchStore')} value={account.storeName ?? ''} onPress={interactive ? () => setView('stores') : noop} /> : null}
    <div className="settings-business-select" data-business-highlight={highlightBusiness||undefined}><ListSelectRow label={t('settings.business')} value={state.businessType ? kit.t(`ui.business.${state.businessType}`) : t('settings.businessNone')} ariaLabel={t('settings.changeBusiness')} disabled={unpaid} onPress={interactive ? () => setView('business') : noop} /></div>
    {unpaid ? <ActionButton variant="ghost" disabled aria-describedby="settings-unpaid-reason">{t('step.payment')} · {state.shopSettings.paymentStyle ? t(`payment.${state.shopSettings.paymentStyle}`) : '—'}</ActionButton> : <ListSelectRow label={t('step.payment')} value={state.shopSettings.paymentStyle ? t(`payment.${state.shopSettings.paymentStyle}`) : '—'} onPress={interactive ? () => setView('payment') : noop} />}
    <div lang="ko"><ListSelectRow label={t('pos.settingsTitle')} value={t('pos.startValue',{tab:t(`pos.${posPreferences.startTab}`)})} onPress={interactive ? () => setView('pos-preferences') : noop}/>{unpaid ? <div><p id="settings-unpaid-reason">{t('pos.settingsBlocked')}</p><ActionButton variant="secondary" onClick={interactive ? () => openUnpaidOrders(run) : noop}>{t('pos.showOrders')}</ActionButton></div> : null}</div>
    <ListSelectRow label={t('step.tables')} value={tableLayoutEnabled(state.shopSettings.businessType,state.shopSettings.paymentStyle) ? state.shopSettings.tableLayout ? t('tables.total',{n:state.shopSettings.tableLayout.tables.length,m:state.shopSettings.tableLayout.tables.reduce((n,v)=>n+v.seats,0)}) : t('settings.noTables') : t('table.reason')} ariaLabel={state.shopSettings.tableLayout||state.locale!=='ko'?t('settings.editTables'):'테이블 배치하기'} disabled={!tableLayoutEnabled(state.shopSettings.businessType,state.shopSettings.paymentStyle)} onPress={interactive ? () => setView('tables') : noop} /></div>
    <div role="group" aria-label={t('settings.display')}><h3>{t('settings.display')}</h3>
    <SettingRow><section className="settings-mode" aria-label={t('settings.mode')}><h3 className="settings-label">{t('settings.mode')}</h3><ThemeTabs value={state.theme} onChange={interactive ? run.actions.setTheme : noop} /></section></SettingRow>
    <SettingRow><LargeTextControl checked={state.textScale === 125} onChange={interactive ? checked => run.actions.setTextScale(checked ? 125 : 100) : noop} /></SettingRow>
    <LanguageSelectRow locale={state.locale} onPress={interactive ? () => setView('language') : noop} />
    {account ? <SettingRow><ActionButton variant="secondary" disabled={switching} onClick={interactive ? () => { setSwitching(true); void account.signOut().catch(() => setSwitching(false)); } : noop}>{t('settings.signOut')}</ActionButton></SettingRow> : null}
    </div>
  </div>;
  return <ScrollArea role="region" aria-label={view === 'business' ? t('business.group') : t('settings.content')} className="settings-content">{body}</ScrollArea>;
}

function BackButton({ onBack }: { readonly onBack: () => void }) {
  const kit = useKitT();
  return <IconButton label={kit.t('ui.settings.back')} icon="arrow-left" variant="ghost" onClick={onBack} />;
}

function SettingsSession({ run, state, returnFocusRef, onClose, onChoose, announce, verification, updateSettings, tableLinkPicker, tableLinkError }: { readonly run: RunStore; readonly state: RunState; readonly returnFocusRef: RefObject<HTMLElement | null>; readonly onClose: (view: View, reason: CloseReason, tableDraft?:TableLayout) => void; readonly onChoose: (type: BusinessType) => void; readonly announce: BodyProps['announce']; readonly verification?: SettingsOverlayProps['verification']; readonly updateSettings?: SessionActions['updateSettings']; readonly tableLinkPicker?: SettingsOverlayProps['tableLinkPicker']; readonly tableLinkError?: string | null }) {
  const [view, changeView] = useState<View>(() => {
    if (peekSettingsStart(run) === 'tables') return 'tables';
    return previewStatesEnabled() ? 'preview' : 'overview';
  });
  const [tableDraft,setTableDraft]=useState(state.shopSettings.tableLayout ?? createTableLayout());
  const [error,setError]=useState<'session.error' | ReturnType<typeof tableFailureKey> | null>(null);const [highlightBusiness,setHighlightBusiness]=useState(false);
  useEffect(()=>{if(!highlightBusiness)return;const timer=window.setTimeout(()=>setHighlightBusiness(false),800);return()=>window.clearTimeout(timer);},[highlightBusiness]);
  const setView = (next:View) => {
    if(next==='tables')setTableDraft(state.shopSettings.tableLayout??createTableLayout());
    setError(null);
    changeView(next);
  };
  const saveSettings: SessionActions['updateSettings'] = settings => {const result=updateSettings?.({...settings,revision:settings.revision+1});const reason=result && typeof result === 'object' && 'reason' in result ? result.reason : undefined;setError(applied(result) ? null : reason === 'UNPAID_BILLS' || reason === 'TABLE_IN_USE' ? tableFailureKey({reason}) : 'session.error');return result;};
  const {t: t5}=useBundle(iteration5Bundle, posBundle, tableTransferBundle);
  useLayoutEffect(() => { clearSettingsStart(run); }, [run]);
  const kit = useKitT();
  const { title, description } = useViewText(view);
  const failContent = import.meta.env.DEV && verification?.failContent === true;
  const sub = view !== 'overview';
  const tableSummary=t5('tables.total',{n:tableDraft.tables.length,m:tableDraft.tables.reduce((n,v)=>n+v.seats,0)});
  const saveTables=()=>{
    if(!applied(saveSettings({...state.shopSettings,tableLayout:tableDraft})))return;
    announce('settings.changed',tableSummary);
    setView('overview');
  };
  return <DialogFrame open title={title} description={description} variant="settings" popupStyle={view === 'tables' ? tablePopupStyle : undefined} returnFocusRef={returnFocusRef} closeLabel={kit.t('common.close')}
    headerAction={sub ? <BackButton onBack={() => setView(parentOf(view))} /> : undefined} onClose={reason => onClose(view, reason,view==='tables'?tableDraft:undefined)} footer={view==='tables'?<OnboardingFooter summary={tableSummary}><ActionButton size="primary" onClick={saveTables}>{t5('save')}</ActionButton></OnboardingFooter>:undefined}>
    {tableLinkPicker?.disabled && (view === 'overview' || view === 'tables') ? <p lang="ko">테이블별 주문이 있는 후불형에서 연결할 수 있어요</p> : null}
    {view === 'tables' && tableLinkError ? <p role="alert">{tableLinkError}</p> : null}
    <ContentRecovery onRetry={import.meta.env.DEV ? verification?.onRetry : undefined}><ContentCrossfade contentKey={view}>{view === 'tables' ? <div className="t207-settings-tables"><TableEditor value={tableDraft} linkPicker={tableLinkPicker} onChange={next=>{const protectedIds=new Set([...state.pos.bills.filter(b=>b.status==='open'||b.status==='partial').flatMap(b=>b.tableId?[b.tableId]:[]),...state.pos.tableSessions.filter(s=>s.cleaning).map(s=>s.tableId)]);if([...protectedIds].some(id=>!next.tables.some(table=>table.tableId===id))){setError('pos.tableInUse');return;}setError(null);setTableDraft(next);}}/></div> : <SettingsBody highlightBusiness={highlightBusiness} updateSettings={saveSettings} run={run} state={state} view={view} setView={setView} failContent={failContent} announce={announce} onClose={() => onClose(view, 'button')} onChoose={(type, event) => { consumeDismissSequence(event.nativeEvent); if (run.getState().overlay.type !== 'settings') return; const result=saveSettings({...state.shopSettings,businessType:type}); if(applied(result)) {if(type!==state.businessType)setHighlightBusiness(true);onChoose(type);setView('overview');} }} />}</ContentCrossfade>{error?<p role="alert">{t5(error)}</p>:null}</ContentRecovery>
  </DialogFrame>;
}

/** Mount once under UiProvider; settings owns its active dialog and noninteractive exit. */
export function SettingsOverlay({ run, sessionActions, returnFocusRef, returnFocusKey = 'settings', verification, tableLinkPicker, tableLinkError }: SettingsOverlayProps) {
  const contextActions=useContext(SessionActionsContext);
  const updateSettings=sessionActions?.updateSettings ?? contextActions?.updateSettings;
  const state = useSyncExternalStore(run.subscribe, run.getState);
  const { layout, canvasElement } = useUi();
  const { t } = useShellT();
  const {t:t5}=useBundle(iteration5Bundle);
  const kit = useKitT();
  const targetRef = useRef<HTMLElement | null>(null);
  const [exitView, setExitView] = useState<View>('overview');
  const [exitTableDraft,setExitTableDraft]=useState<TableLayout|null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const active = state.overlay.type === 'settings';
  const exitText = useViewText(exitView);
  useLayoutEffect(() => {
    if (active) targetRef.current = focusTarget(canvasElement ?? document, returnFocusRef?.current, returnFocusKey);
  }, [active, returnFocusRef, returnFocusKey, canvasElement]);
  const close = (view: View, reason: CloseReason, tableDraft?:TableLayout) => {
    setExitView(view);
    setExitTableDraft(tableDraft??null);
    // Resolve again: a theme change or app composition may replace the trigger.
    const target = focusTarget(canvasElement ?? document, returnFocusRef?.current, returnFocusKey);
    targetRef.current = target;
    if (target?.tagName === 'H1' && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    run.actions.closeOverlay(reason);
    target?.focus({ preventScroll: true });
  };
  const announce:BodyProps['announce'] = (key,value) => setAnnouncement(previous => ({ key, value, n: (previous?.n ?? 0) + 1 }));
  // The sentence is built at render time, so a language change is announced in the new language.
  const sentence = announcement ? announcement.key==='settings.changed' ? t5('settings.changed',{value:announcement.value??''}) : announcement.key === 'settings.businessChanged' && announcement.business ? t('settings.businessChanged', { business: kit.t(`ui.business.${announcement.business}`) }) : announcement.key === 'settings.businessChanged' ? '' : t(announcement.key) : '';
  return <><p role="status" aria-live="polite" aria-atomic="true" className="ui-sr-only">{sentence}</p>
    {active ? <SettingsSession run={run} state={state} updateSettings={updateSettings} tableLinkPicker={tableLinkPicker} tableLinkError={tableLinkError} returnFocusRef={targetRef} verification={verification} announce={announce} onClose={close} onChoose={type => { if (type !== state.businessType) run.actions.showNotice({kind:'complete',messageKey:'settings.businessChanged',params:{business:kit.t(`ui.business.${type}`)}}); }} /> : state.overlay.type === 'none' && state.exitingOverlay?.type === 'settings' && state.exitPendingToken ? <OverlayExitSurface token={state.exitPendingToken} kind="settings" style={exitView==='tables'?tablePopupStyle:{ height: dialogHeight(exitView, state.textScale, layout) }} onComplete={run.actions.finishOverlayExit}>
      <header className="ui-overlay-header"><div className="ui-overlay-heading"><h2 className="ui-dialog-title">{exitText.title}</h2>{exitText.description ? <p className="ui-dialog-description">{exitText.description}</p> : null}</div><span className="settings-exit-close" aria-hidden="true"><Icon name="close" /></span></header>
      <div className="ui-overlay-body"><ContentRecovery>{exitView==='tables'&&exitTableDraft?<div className="t207-settings-tables"><TableEditor value={exitTableDraft} onChange={noop}/></div>:<SettingsBody run={run} state={state} view={exitView} setView={noop} onClose={noop} onChoose={noop} announce={noop} interactive={false} />}</ContentRecovery></div>
      <footer className="ui-overlay-note">{exitView==='tables'&&exitTableDraft?<OnboardingFooter summary={t5('tables.total',{n:exitTableDraft.tables.length,m:exitTableDraft.tables.reduce((sum,table)=>sum+table.seats,0)})}><ActionButton size="primary">{t5('save')}</ActionButton></OnboardingFooter>:null}</footer>
    </OverlayExitSurface> : null}
  </>;
}
