import type { BusinessType, DetailRef, FeatureId, Panel } from './index';
import type { PosState, PosUiState } from './pos';

/** API-279: one run-local preference shared by ordinary detail windows. */
export interface DetailDialogPresentation { readonly detailDialogFullscreen: boolean }
export interface DetailDialogPresentationActions { setDetailDialogFullscreen(fullscreen: boolean): void }

/** API-212. Table coordinates are independent of the dashboard grid. */
export type PaymentStyle = 'prepaid' | 'postpaid';
export interface StoreTable {
  readonly tableId: string;
  readonly number: number;
  readonly seats: number;
  readonly column: number;
  readonly row: number;
}
export interface TableLayout {
  readonly layoutId: string;
  readonly columns: 9;
  readonly rows: 6;
  readonly tables: readonly StoreTable[];
  readonly revision: number;
}
export interface CctvPosLink { readonly zoneId: string; readonly tableId: string }
export interface ShopSettings {
  readonly cctvPosLinks?: readonly CctvPosLink[];
  readonly businessType: BusinessType | null;
  readonly paymentStyle: PaymentStyle | null;
  readonly tableLayout: TableLayout | null;
  readonly revision: number;
  readonly posPreferences?: PosPreferences;
}
export type PosTab = 'order' | 'status' | 'tables';
export interface PosPreferences {
  readonly startTab: PosTab; readonly userChoseStart: boolean;
  readonly showStatus: boolean; readonly showTables: boolean;
}
export type ManagementTemplateId = 'A' | 'B' | 'C';
export interface ManagementTemplate {
  readonly id: ManagementTemplateId;
  readonly paymentStyle: PaymentStyle;
  readonly nameKey: string;
  readonly descriptionKey: string;
  readonly recommended: boolean;
  readonly panels: readonly Panel[];
  readonly tourOrder: readonly FeatureId[];
}
export interface OnboardingDraft {
  readonly businessType: BusinessType | null;
  readonly paymentStyle: PaymentStyle | null;
  readonly tableLayout: TableLayout | null;
}
export interface OnboardingState {
  readonly step: 'business' | 'payment' | 'tables' | 'start' | 'applying' | 'done';
  readonly draft: OnboardingDraft;
  readonly selectedTemplateId: ManagementTemplateId | null;
  readonly applyToken: string | null;
}
export interface TemplateTour {
  readonly status: 'waiting' | 'active' | 'completed';
  readonly runId: string;
  readonly applyToken: string;
  readonly targets: readonly FeatureId[];
  readonly index: number;
  readonly readyAt: number;
}
export interface DetailReturnState {
  readonly ref: DetailRef;
  readonly tab: string;
  readonly query: string;
  readonly sort: { readonly columnId: string; readonly direction: 'asc' | 'desc' } | null;
  readonly filters: Readonly<Record<string, string>>;
  readonly expandedRowIds: readonly string[];
  readonly selectedRowId: string | null;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly focusKey: string;
}
export interface ChangedValueSlot {
  readonly slotId: string;
  readonly featureId: FeatureId;
  readonly scope: 'editor' | 'detail' | 'dashboard';
  readonly semanticValue: string | number | boolean | null;
  readonly visible: boolean;
}

/** A ticket identifies a prepared snapshot retained privately by its store. */
export interface SessionTransaction {
  readonly transactionId: string;
  readonly runId: string;
  readonly expectedDataRevision: number;
  readonly expectedRunRevision: number;
  readonly transitionToken: string;
}
export interface SessionGate {
  readonly phase: 'idle' | 'preparing' | 'publishing' | 'flushing';
  readonly transactionId: string | null;
}
export interface PreparedChange {
  readonly store: 'run' | 'data';
  readonly transactionId: string;
  readonly ticket: string;
}
export type PrepareResult = { readonly ok: true; readonly change: PreparedChange }
  | { readonly ok: false; readonly code: 'VALIDATION' | 'CONFLICT'; readonly reason: string; readonly messageKey: string };
export interface SessionTransactionPort<Input> {
  readonly prepare: (tx: SessionTransaction, input: Input) => PrepareResult;
  readonly isCurrent: (change: PreparedChange) => boolean;
  readonly publish: (change: PreparedChange) => void;
  readonly flush: (transactionId: string) => void;
  readonly abort: (change: PreparedChange) => void;
}

/** Run-side intents contain no data-store snapshot or React state. */
export type RunSessionInput =
  | { readonly type: 'complete-onboarding'; readonly templateId: ManagementTemplateId | null }
  | { readonly type: 'update-settings'; readonly settings: ShopSettings }
  | { readonly type: 'pos.commit'; readonly expectedPosRevision: number; readonly nextPos: PosState; readonly nextUi: PosUiState; readonly nextSettings?: ShopSettings };
