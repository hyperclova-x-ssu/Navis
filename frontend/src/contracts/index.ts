/** Public browser-module contracts. Core owns preset cell geometry; src/ui owns pixels. */
import type { ComponentType } from 'react';
import type { PosScenario, PosState, PosUiState } from './pos';
import type { NavisLayoutPlan } from '../state/navis-layout';
import type { LinkedOccupancyState, ObserveLinkedOccupancyInput } from '../data/iteration7/table-links';
export type * from './pos';
import type { DetailReturnState, ManagementTemplateId, OnboardingDraft, OnboardingState, RunSessionInput, SessionGate, SessionTransactionPort, ShopSettings, TableLayout, TemplateTour } from './session';
export type { ChangedValueSlot, DetailReturnState, ManagementTemplate, ManagementTemplateId, OnboardingDraft, OnboardingState, PaymentStyle, PreparedChange, PrepareResult, RunSessionInput, SessionGate, SessionTransaction, SessionTransactionPort, ShopSettings, StoreTable, TableLayout, TemplateTour } from './session';
export type BusinessType = 'cafe' | 'restaurant' | 'pub' | 'beauty' | 'retail' | 'academy' | 'fitness' | 'other';
export type FeatureId = 'menu' | 'inventory-booking' | 'suppliers' | 'ledger' | 'margin' | 'tax' | 'members' | 'customer-analysis' | 'manuals' | 'grants' | 'calendar' | 'voice-booking' | 'briefing' | 'staff-schedule' | 'store-environment' | 'custom-order' | 'notice-send' | 'credit-receivable' | 'local-changes' | 'trade-area' | 'local-trends' | 'ai-response' | 'community' | 'marketing-today' | 'slot-coupon' | 'expiry-coupon' | 'promo-video' | 'coupon-status' | 'customer-groups' | 'marketing-performance';
export type GroupId = 'recommended' | 'products' | 'stock' | 'finance' | 'members' | 'store' | 'misc' | 'schedule' | 'news' | 'money' | 'customers' | 'neighborhood';
export type CellSpan = 1 | 2 | 3 | 4;
export type ContentShape = 'Q' | 'W' | 'T' | 'S' | 'L';
export type Theme = 'light' | 'dark';
export type ErrorCode = 'UNKNOWN_FEATURE' | 'INVALID_SIZE' | 'NO_CAPACITY' | 'OUTSIDE_GRID' | 'DUPLICATE' | 'STALE_REVISION' | 'CANCELLED' | 'UNDO_UNAVAILABLE' | 'INVALID_POSITION' | 'INTERNAL_LAYOUT_ERROR' | 'PAGE_LIMIT' | 'NO_NEIGHBOR_PAGE' | 'OTHER_LAYER' | 'CONFLICT';
export interface CellPosition { readonly column: number; readonly row: number }
export interface GridSpec { readonly columns: number; readonly rows: number }
export type ScreenPresetId = 'A' | 'B';
export interface ScreenPreset { readonly id: ScreenPresetId; readonly baselineWidth: number; readonly baselineHeight: number; readonly grid: GridSpec }
export interface ViewportSnapshot { readonly width: number; readonly height: number }
export interface ViewportTransform { readonly scale: number; readonly offsetX: number; readonly offsetY: number; readonly width: number; readonly height: number; readonly originX: number; readonly originY: number }
export interface Panel extends CellPosition { readonly featureId: FeatureId; readonly width: number; readonly height: number; readonly condition?: QueryCondition }
export interface Displacement { readonly featureId: FeatureId; readonly from: CellPosition; readonly to: CellPosition; readonly causeFeatureId: FeatureId }
export interface Metric { readonly label: string; readonly value: number | string; readonly unit: string; readonly deltaDirection?: 'up' | 'down' | 'flat'; readonly deltaLabel?: string }
export interface Series { readonly axisLabels: readonly string[]; readonly series: readonly { readonly name: string; readonly values: readonly number[]; readonly unit: string }[] }
export interface ListItem { readonly id: string; readonly title: string; readonly subtitle?: string; readonly badge?: string }
export interface FeatureDefinition { readonly id: FeatureId; readonly label: string; readonly panelTitle: string; readonly aliases: readonly string[]; /** plan-2 (API-01 v4.1): 'recommended' is the home of marketing-today. */ readonly groupId: GroupId; readonly iconKey: string; /** DATA_MODEL 10.7 detail frame and body kind. */ readonly detail: { readonly frame: DetailFrame; readonly kind: DetailKind }; readonly searchText: string }
export interface ResolvedFeatureDefinition extends FeatureDefinition { readonly presetId: ScreenPresetId }
export type ResolvedCatalog = readonly ResolvedFeatureDefinition[];
export interface FeatureQuery { readonly presetId: ScreenPresetId; readonly group?: GroupId; readonly businessType?: BusinessType | null; readonly query?: string; /** v4: the layer whose registry entries are listed (API-01 v4). */ readonly layer: DashboardLayerId }
export interface BusinessPreset { readonly businessType: BusinessType | 'general'; readonly recommendationIds: readonly FeatureId[]; readonly starterIds: readonly FeatureId[]; readonly starterMessageKey: string; readonly label: string; /** v4 (DATA_MODEL 10.8). */ readonly layer: DashboardLayerId }
export type LayoutIntent =
  | { readonly type: 'add-tap'; readonly featureId: FeatureId }
  | { readonly type: 'add-drop'; readonly featureId: FeatureId; readonly column: number; readonly row: number }
  | { readonly type: 'add-candidate-tap'; readonly featureId: FeatureId; readonly width:number; readonly height:number; readonly condition:QueryCondition }
  | { readonly type: 'add-ai'; readonly featureId: FeatureId; readonly column:number; readonly row:number; readonly width:CellSpan; readonly height:CellSpan; readonly condition:QueryCondition }
  | { readonly type: 'move'; readonly featureId: FeatureId; readonly column: number; readonly row: number }
  | { readonly type: 'resize'; readonly featureId: FeatureId; readonly width: number; readonly height: number }
  | { readonly type: 'remove'; readonly featureId: FeatureId }
  | { readonly type: 'starter'; readonly featureIds: readonly FeatureId[] }
  | { readonly type: 'restore'; readonly panels: readonly Panel[] };
export interface LayoutResult { readonly status: 'accepted' | 'unchanged' | 'rejected'; readonly valid: boolean; readonly panels: readonly Panel[]; readonly displacements: readonly Displacement[]; readonly usedCells: number; readonly remainingCells: number; readonly code?: ErrorCode; readonly existingFeatureId?: FeatureId; /** v4: DUPLICATE on another page of the same layer (0-based page index). */ readonly existingPage?: number; readonly reason?: string }
export interface PendingLayoutResult { readonly status: 'pending'; readonly code?: never; readonly valid?: never; readonly existingFeatureId?: never; readonly existingPage?: never; readonly panels: readonly Panel[]; readonly displacements: readonly Displacement[]; readonly usedCells: number; readonly remainingCells: number }
export type LayoutResponse = LayoutResult | PendingLayoutResult;
export type CommandResult = LayoutResponse & { readonly revision: number; readonly highlightFeatureId?: FeatureId };
export interface LayoutIdentity { readonly runId: string; readonly baseRevision: number; readonly gestureToken: string; readonly requestId: number; readonly presetId: ScreenPresetId }
export interface LayoutWorkerRequest extends LayoutIdentity { readonly beforePanels: readonly Panel[]; readonly intent: LayoutIntent }
export interface LayoutWorkerResponse extends LayoutIdentity { readonly result: LayoutResult }
export interface LayoutAdapter { readonly ready: () => Promise<void>; readonly submit: (request: LayoutWorkerRequest, receive: (response: LayoutWorkerResponse) => void) => void; readonly cancel: () => void; readonly dispose: () => void }
export interface GesturePreview extends LayoutIdentity { readonly token: string; readonly source: 'drawer' | 'candidate' | 'panel' | 'resize' | 'keyboard'; readonly inputIntent: 'pending' | 'list' | 'drag'; readonly featureId: FeatureId; readonly beforePanels: readonly Panel[]; readonly intent: LayoutIntent; readonly status: 'pending' | 'accepted' | 'unchanged' | 'rejected'; readonly candidatePanels: readonly Panel[]; readonly displacements: readonly Displacement[]; readonly reason?: ErrorCode; readonly pointerId: number; readonly pendingCommit: boolean; readonly result: LayoutResult | null; /** v4: the board, the page the gesture started on and the page it currently targets. */ readonly layerId: DashboardLayerId; readonly sourcePage: number; readonly targetPage: number; /** v4: last position sent with updatePreview(token, {column,row,inside}). */ readonly position: PreviewPosition | null }
export type Overlay = { readonly type: 'none' } | { readonly type: 'drawer'; readonly group: GroupId; readonly query: string } | { readonly type: 'detail'; readonly featureId: FeatureId; readonly returnFocusKey: string; /** v4: [first detail, linked detail], at most 2; the last entry is shown. */ readonly stack?: readonly DetailRef[] } | { readonly type: 'settings' } | { readonly type: 'briefing' } | { readonly type: 'closing'; readonly returnFocusKey: string; readonly returnTo?: DetailReturnState; readonly tab?: ClosingViewTab; readonly readOnly?: boolean };
export type CoachStep = 'choose-feature' | 'resize-panel' | 'move-panel';
export interface GuidanceProgress { readonly firstHintSeen: boolean; readonly coach: Readonly<Record<CoachStep, 'unseen' | 'queued' | 'visible' | 'dismissed'>>; readonly active: CoachStep | null; readonly targetFeatureId: FeatureId | null; readonly queue: readonly CoachStep[]; readonly panelMilestones: { readonly first: boolean; readonly second: boolean }; readonly nextCoachAt: number; readonly dashboardReady: boolean; readonly visualPending: boolean; /** v4 widget explanations (F-21): absent = not seen. */ readonly widgetCoach: Readonly<Partial<Record<FeatureId, WidgetCoachStatus>>>; readonly widgetQueue: readonly FeatureId[]; readonly activeWidget: FeatureId | null }
export type UndoPauseReason = 'toast-focus' | 'toast-touch' | 'page-hidden';
export interface UndoEntry { readonly token: string; readonly kind: 'add' | 'move' | 'resize' | 'remove' | 'starter-add' | 'move-page'; readonly beforePanels: readonly Panel[]; /** v4: board, page to show after undo, and every page's panels before the change. beforePanels === beforePages[pageIndex]. */ readonly layerId: DashboardLayerId; readonly pageIndex: number; readonly beforePages: readonly (readonly Panel[])[]; readonly appliedRevision: number; readonly remainingMs: number; readonly expiresAt: number; readonly pausedReasons: readonly UndoPauseReason[]; readonly consumed: boolean }
export type BlockedReason = 'coaching' | 'drawer' | 'settings' | 'detail' | 'briefing' | 'closing' | 'onboarding' | 'template-tour' | 'edit' | 'pointer-active' | 'notice-visible' | 'overlay-exit' | 'page-hidden' | 'layout-pending';
export type InputSequence = { readonly kind: 'pointer'; readonly id: number } | { readonly kind: 'keyboard'; readonly id: string };
export interface WakeInputToken { readonly token: string; readonly input: InputSequence; readonly released: boolean }
export interface Notice { readonly kind: 'success' | 'error' | 'complete' | 'duplicate'; readonly id: string; readonly messageKey: string; readonly featureId?: FeatureId; readonly undoToken?: string; readonly panel?: Panel; readonly displacedCount?: number; readonly expiresAt: number; /** v4 (DATA_MODEL 10.4). */ readonly layerId?: DashboardLayerId; readonly params?: MessageParams; readonly undo?: NoticeUndo }
export interface RunState { readonly runId: string; readonly screenPreset: ScreenPreset; readonly screen: 'business-question' | 'dashboard'; readonly businessType: BusinessType | null; readonly panels: readonly Panel[]; readonly layoutRevision: number; readonly edit: { readonly mode: 'view' | 'edit'; readonly gesture: null | 'drag' | 'resize'; readonly gestureToken: string | null; readonly selectedFeatureId: FeatureId | null }; readonly gesturePreview: GesturePreview | null; readonly overlay: Overlay; readonly exitPendingToken: string | null; readonly exitingOverlay: Overlay | null; readonly closingInput: InputSequence | null; readonly guidance: GuidanceProgress; readonly starter: 'ready' | 'running' | 'completed'; readonly briefing: 'pending' | 'visible' | 'dismissed'; readonly briefingSafeSince: number | null; readonly idle: { readonly mode: 'active' | 'idle'; readonly lastInputAt: number; readonly blockedReasons: readonly BlockedReason[]; readonly wakeInputToken: WakeInputToken | null }; readonly activeInputs: readonly InputSequence[]; readonly pageHidden: boolean; readonly theme: Theme; readonly textScale: 100 | 125; readonly reducedMotion: boolean; readonly undo: UndoEntry | null; readonly notice: Notice | null;
  /** v4 (DATA_MODEL 10.2). panels·guidance·starter·undo·notice above mirror boards[activeBoard] (viewed page); only the store's write helper updates them. */
  readonly layer: LayerId; readonly activeBoard: DashboardLayerId; readonly boards: Readonly<Record<DashboardLayerId, DashboardBoard>>; readonly locale: Locale; readonly preview: PreviewSelection; readonly widgetHelp: WidgetHelp | null; readonly runRevision: number; readonly transactionId: string | null; readonly transitionToken: string; readonly onboarding: OnboardingState; readonly templateTour: TemplateTour | null; readonly shopSettings: ShopSettings;
  readonly pos: PosState; readonly posRevision: number; readonly posUi: PosUiState; readonly detailDialogFullscreen: boolean;
  readonly linkedOccupancy: LinkedOccupancyState; readonly linkedActiveZoneIds: readonly string[] }
export interface TimePolicy { readonly coachFirstMs: number; readonly coachGapMs: number; readonly hintDelayMs: number; readonly briefingSafeMs: number; readonly idleMs: number; readonly undoMs: number; readonly noticeMs: number; readonly completeMs: number; readonly existingHighlightMs: number }
export interface RunContext { readonly screenPreset: ScreenPreset; readonly catalog: ResolvedCatalog }
export interface RunResetOptions extends RunContext { readonly theme: Theme; readonly reducedMotion?: boolean }
export interface RunOptions extends RunResetOptions { readonly time: TimePolicy; readonly clock: () => number; readonly theme: Theme; readonly reducedMotion?: boolean; readonly createId?: () => string; readonly layoutAdapter?: LayoutAdapter; readonly previewGuard?: (request: PreviewRequest) => boolean; readonly sessionGate?: SessionGate }
export interface PreviewRequest { readonly source: GesturePreview['source']; readonly pointerId: number; readonly intent: LayoutIntent; readonly token?: string; readonly inputIntent?: GesturePreview['inputIntent'] }
export interface TimerScheduler { readonly schedule: (callback:()=>void,delayMs:number)=>unknown; readonly cancel: (handle:unknown)=>void }
export interface RunActions {
  readonly observeLinkedOccupancy: (input: ObserveLinkedOccupancyInput, expectedRunId?: string) => void;
  readonly reconcileLinkedOccupancy: (input: { readonly activeZoneIds: readonly string[]; readonly elapsedNow: number }, expectedRunId?: string) => void;
  /** Run-wide preference for ordinary detail windows; reset with the run. */
  readonly setDetailDialogFullscreen: (fullscreen: boolean) => void;
  readonly setPosPreview: (scenario: PosScenario | null) => void;
  /** Presentation only. Business changes must use session.prepare(pos.commit). */
  readonly setPosUi: (ui: PosUiState, expectedRunId: string) => boolean;
  readonly setOnboardingAnswer: (answer: Partial<OnboardingDraft>) => boolean;
  readonly onboardingBack: () => boolean;
  readonly saveOnboardingTables: (layout: TableLayout) => boolean;
  readonly skipOnboardingTables: () => boolean;
  readonly selectStartTemplate: (templateId: ManagementTemplateId) => boolean;
  readonly applyManagementTemplate: (templateId: ManagementTemplateId, baseLayoutRevision?: number) => CommandResult;
  readonly startEmpty: () => boolean;
  readonly templateAssembled: (completion: { readonly runId: string; readonly applyToken: string }) => boolean;
  readonly nextTemplateTour: () => boolean;
  readonly closeTemplateTour: () => boolean;
  readonly openClosing: (returnFocusKey: string, options?: { readonly tab?: ClosingViewTab; readonly readOnly?: boolean }) => boolean;
  readonly setClosingPreview: (variant: 'normal' | 'no-payments' | 'error' | null) => void;
  readonly resetClosingPreview: () => void;
  readonly chooseBusiness: (type:BusinessType|null)=>void;
  readonly skipBusiness: ()=>void;
  readonly applyLayoutIntent: (intent:LayoutIntent,baseRevision?:number)=>CommandResult;
  readonly commitAssistantBatch: (panels:readonly Panel[], baseRevision:number, runId:string)=>CommandResult;
  readonly commitNavisLayout: (plan:NavisLayoutPlan)=>CommandResult;
  readonly startWithThree: (baseRevision?:number)=>CommandResult;
  /** v4.1 (API-03): marketing board only, all pages empty. */
  readonly startWithPreset: (baseRevision?:number)=>CommandResult;
  /** v4.1: root detail for any registry widget; ref.focus is kept. */
  readonly openDetailRef: (ref:DetailRef,returnFocusKey:string)=>boolean;
  /** v4.1: mark every visible/queued F-03 step and widget explanation of the active board as dismissed. */
  readonly skipWidgetCoaches: ()=>void;
  readonly beginPreview: (request:PreviewRequest)=>string|null;
  /** v4: controllers send only a position (or a size); the store picks the intent. The (token, intent, insideGrid) form is still accepted (state tests drive intents directly). */
  readonly updatePreview: { (token:string,target:PreviewTarget):LayoutResponse; (token:string,intent:LayoutIntent,insideGrid?:boolean):LayoutResponse };
  readonly commitPreview: (token:string,insideGrid?:boolean)=>CommandResult;
  readonly cancelPreview: (token?:string)=>void;
  readonly cancelPreviewForViewportChange: ()=>void;
  readonly undo: (token:string)=>CommandResult;
  readonly pauseUndo: (reason:UndoPauseReason)=>void;
  readonly resumeUndo: (reason:UndoPauseReason)=>void;
  readonly setTheme: (theme:Theme)=>void;
  readonly setTextScale: (scale:100|125)=>void;
  readonly setReducedMotion: (reduced:boolean)=>void;
  readonly enterEditing: ()=>void;
  readonly selectPanel: (featureId:FeatureId)=>boolean;
  readonly finishEditing: ()=>boolean;
  readonly openDrawer: (group:GroupId,query?:string)=>boolean;
  readonly openSettings: ()=>boolean;
  readonly openDetail: (id:FeatureId,returnFocusKey:string)=>boolean;
  readonly closeOverlay: (reason?:'button'|'Esc'|'outside'|'drag-start',input?:InputSequence)=>string|null;
  readonly finishOverlayExit: (token:string)=>void;
  readonly visualSettled: ()=>void;
  readonly dismissCoach: ()=>boolean;
  readonly coachedAction: (step:CoachStep)=>boolean;
  readonly markFirstHintSeen: ()=>boolean;
  readonly inputStarted: (input:InputSequence)=>boolean;
  readonly inputEnded: (input:InputSequence)=>boolean;
  readonly consumeInput: (input:InputSequence,phase:'move'|'up'|'click'|'cancel')=>boolean;
  readonly setPageHidden: (hidden:boolean)=>void;
  readonly clearNotice: ()=>void;
  readonly tick: ()=>void;
  readonly resetRun: (options:RunResetOptions)=>void;
  /** v4 (API-03 v4). Every layout command applies to the active board's viewed page. */
  readonly switchLayer: (layer:LayerId)=>boolean;
  readonly goToPage: (index:number)=>boolean;
  readonly addPage: ()=>PageAddResult;
  readonly flipPageDuringGesture: (token:string,direction:PageDirection)=>PageFlipResult;
  readonly movePanelToPage: (featureId:FeatureId,direction:PageDirection)=>CommandResult;
  readonly openWidgetHelp: (featureId:FeatureId,origin:WidgetHelp['origin'],returnFocusKey:string)=>boolean;
  readonly closeWidgetHelp: ()=>boolean;
  readonly openLinkedDetail: (ref:DetailRef)=>boolean;
  readonly detailBack: ()=>boolean;
  readonly setLocale: (locale:Locale)=>boolean;
  readonly setPreviewFamily: (family:PreviewFamily)=>void;
  readonly setPreviewSelection: (next: PreviewSelection, expected: PreviewSelection) => boolean;
  readonly setPreviewVariant: (featureId:FeatureId,variant:string|null)=>void;
  readonly resetWidgetPreview: (featureId:FeatureId)=>void;
  readonly showNotice: (notice:NoticeRequest)=>void;
  readonly acknowledgeBriefing: ()=>void;
}
export interface RunStore { readonly catalog: ResolvedCatalog; readonly getState:()=>RunState; readonly subscribe:(listener:(state:RunState,previous:RunState)=>void)=>()=>void; readonly actions:RunActions; readonly nextDeadline:()=>number|null; readonly prepareLayout:()=>Promise<boolean>; readonly session: SessionTransactionPort<RunSessionInput>; readonly dispose:()=>void }

/** Iteration 4 (v4.0, API-03/11/12/13 v4, DATA_MODEL 10.2-10.6). Locale and locales are defined here only. */
export type Locale = 'ko' | 'en' | 'zh-Hans' | 'zh-Hant';
/** Settings display order. */
export const locales: readonly Locale[] = Object.freeze(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const);
export type MessageParams = Readonly<Record<string, string | number>>;
export type LayerId = 'orders-payment' | 'management' | 'marketing';
export type DashboardLayerId = 'management' | 'marketing';
export type PreviewFamily = 'normal' | 'empty' | 'error' | 'special';
/** overrides: widget -> variant id or 'normal' (DATA_MODEL 10.12). */
export interface PreviewSelection { readonly family: PreviewFamily; readonly overrides: Readonly<Partial<Record<FeatureId, string>>>; readonly closing?: 'normal' | 'no-payments' | 'error'; readonly pos?: PosScenario }
export type ClosingViewTab = 'sales' | 'drawer' | 'history';
/** A browser-local form seed. Widgets may use it to initialize their normal editor. */
export type DetailPrefill =
  | { readonly kind: 'menu.create'; readonly name?: string; readonly price?: number; readonly category?: 'drink' | 'dessert' }
  | { readonly kind: 'widget-draft'; readonly command: string; readonly fields: Readonly<Record<string, unknown>> };
export interface DetailRef {
  readonly featureId: FeatureId;
  readonly view?: string;
  readonly itemId?: string;
  /** Open with the primary action expanded. */
  readonly focus?: 'action';
  readonly date?: string;
  readonly condition?: QueryCondition;
  readonly time?: string;
  readonly hour?: number;
  readonly filter?: 'praise' | { readonly grade: 'regular' | 'frequent' | 'occasional' | 'inactive' };
  readonly prefill?: DetailPrefill;
}
export interface PreviewPosition { readonly column: number; readonly row: number; readonly inside: boolean }
export type PreviewTarget = PreviewPosition | { readonly width: number; readonly height: number };
export type PageDirection = -1 | 1;
export interface DashboardPage { readonly pageId: string; readonly panels: readonly Panel[] }
/** One per dashboard layer. Pages 1-5, appended only. revision counts this board's successful layout changes and undos. The board's first hint is guidance.firstHintSeen. */
export interface DashboardBoard { readonly layerId: DashboardLayerId; readonly pages: readonly DashboardPage[]; readonly currentPage: number; readonly revision: number; readonly guidance: GuidanceProgress; readonly starter: RunState['starter']; readonly undo: UndoEntry | null; readonly notice: Notice | null }
export type WidgetCoachStatus = 'queued' | 'visible' | 'dismissed';
export interface WidgetHelp { readonly featureId: FeatureId; readonly origin: 'panel' | 'detail'; readonly returnFocusKey: string }
export interface NoticeUndo { readonly target: 'layout' | 'data' | 'pos' | 'run'; readonly token: string }
export interface NoticeRequest { readonly kind: 'success' | 'complete' | 'error'; readonly messageKey: string; readonly params?: MessageParams; readonly undo?: NoticeUndo; readonly featureId?: FeatureId }
export type PageAddResult = { readonly ok: true; readonly index: number } | { readonly ok: false; readonly code: 'PAGE_LIMIT' };
export type PageFlipResult = { readonly ok: true; readonly pageIndex: number; readonly preview: LayoutResponse } | { readonly ok: false; readonly code: 'NO_NEIGHBOR_PAGE' | 'CANCELLED' };
/** Widget registry entry (DATA_MODEL 10.7). label is the LOCALES 4 Korean name for development display and Korean search only; screens use nameKey. Conditions live in src/data/conditions.ts. */
export type DetailFrame = 'large' | 'compact' | 'fullscreen';
export type DetailKind = 'chart' | 'list-work' | 'text' | 'workspace';
export interface WidgetRegistration extends FeatureDefinition { readonly layer: DashboardLayerId; readonly nameKey: string; readonly coachKey: string; readonly aliasesKey: string }
export interface ResolvedWidgetRegistration extends WidgetRegistration { readonly presetId: ScreenPresetId }
export type WidgetRegistry = readonly ResolvedWidgetRegistration[];
/** API-13 widget modules. React is referenced by type only. */
export interface WidgetHost {
  readonly layer: DashboardLayerId;
  resetPreview(): void;
  openClosing(returnFocusKey: string): boolean;
  openLinked(ref: DetailRef): void;
  /** v4.1: panel action buttons open another widget's detail (any registry widget). */
  openDetail(ref: DetailRef): void;
  notify(n: { readonly kind: 'success' | 'complete' | 'error'; readonly messageKey: string; readonly params?: MessageParams; readonly undoToken?: string }): void;
  acknowledgeBriefing(): void;
  /** The run's arrival-briefing flag as an external store, so an open briefing detail follows an acknowledgement made elsewhere (chat). Absent in previews and tests. */
  readonly briefingAcknowledged?: { subscribe(listener: () => void): () => void; getSnapshot(): boolean };
}
export interface WidgetPanelProps { readonly featureId: FeatureId; readonly condition: QueryCondition; readonly width: CellSpan; readonly height: CellSpan; readonly shape: ContentShape; readonly presetId: ScreenPresetId; readonly editing: boolean; readonly host: WidgetHost }
export interface WidgetDetailProps { readonly featureId: FeatureId; readonly condition: QueryCondition; readonly detailRef: DetailRef; readonly host: WidgetHost }
export interface WidgetModule {
  readonly id: FeatureId;
  readonly Panel: ComponentType<WidgetPanelProps>;
  /** v4.1: null for widgets without a detail (marketing-today). */
  readonly Detail: ComponentType<WidgetDetailProps> | null;
  /** v4.1: when present a panel tap opens this detail instead of the widget's own. */
  readonly useTapTarget?: (args: { readonly featureId: FeatureId; readonly condition: QueryCondition }) => DetailRef | null;
  /** Accessibility key sentence in the current locale and example variant. */
  readonly useSummary: (args: { readonly featureId: FeatureId; readonly condition: QueryCondition }) => string;
}

/** Local API-09 and API-10 contracts. */
export type QueryCondition = { readonly kind:'default' } | { readonly kind:'dateRange'; readonly start:string; readonly end:string } | { readonly kind:'snapshot'; readonly asOf:string };
export interface WidgetQuery { readonly featureId:FeatureId; readonly condition:QueryCondition }
export interface Fact { readonly key:string; readonly value:number|string; readonly unit:string; readonly date?:string; readonly start?:string; readonly end?:string }
export interface WidgetData { readonly featureId:FeatureId; readonly sourceKey:string; readonly condition:QueryCondition; readonly facts:readonly Fact[] }
export type QueryError = { readonly ok:false; readonly code:'UNKNOWN_FEATURE'|'UNSUPPORTED_CONDITION'|'INVALID_CONDITION'|'DATA_UNAVAILABLE' };
export type QueryResult = { readonly ok:true; readonly value:WidgetData } | QueryError;
export type NormalizeResult = { readonly ok:true; readonly value:{readonly featureId:FeatureId;readonly sourceKey:string;readonly condition:QueryCondition} } | QueryError;
export interface WidgetDataSource { read(query:WidgetQuery):Promise<QueryResult> }
export interface WidgetDataService extends WidgetDataSource { normalize(query:WidgetQuery):NormalizeResult }
export interface PanelSpec { readonly featureId:FeatureId; readonly width:CellSpan; readonly height:CellSpan; readonly condition:QueryCondition }
export type InterpretResult = { readonly ok:true; readonly specs:readonly PanelSpec[] } | { readonly ok:false; readonly code:'UNRECOGNIZED'|'INVALID_SPEC'; readonly examples:readonly string[] };
export interface PanelInterpreter { interpret(text:string):Promise<InterpretResult> }
export interface ItemResult { readonly spec:PanelSpec; readonly status:'added'|'duplicate'|'no-capacity'|'invalid'; readonly reason?:string; readonly data?:WidgetData }
export interface BatchResult { readonly status:'committed'|'unchanged'|'cancelled'|'stale'|'error'; readonly items:readonly ItemResult[]; readonly examples?:readonly string[] }
