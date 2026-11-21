export const AGENT_PROTOCOL_HEADER: 'x-navis-protocol';
export const AGENT_PROTOCOL: 'agent-v1';

export type AgentLocale = 'ko' | 'en' | 'zh-Hans' | 'zh-Hant';
export type AgentLayer = 'management' | 'marketing' | 'pos';
export type AgentSourceId = 'pos' | 'demand' | 'promo-estimate' | 'promo-references';
export type AgentCondition =
  | { readonly kind: 'default' }
  | { readonly kind: 'snapshot'; readonly asOf: string }
  | { readonly kind: 'dateRange'; readonly start: string; readonly end: string };
export type AgentSlot = string;
export type AgentMenuCategory = 'drink' | 'dessert';
export type AgentRecordKind =
  | 'menu' | 'stock' | 'purchaseItem'
  | 'member' | 'note' | 'event'
  | 'noticeDraft' | 'staff' | 'shift'
  | 'recipe' | 'supplier' | 'purchaseOrder'
  | 'purchaseOrderLine' | 'expense' | 'candidate'
  | 'taxPayment' | 'taxItem' | 'accountTxn'
  | 'customOrder' | 'customTemplate' | 'reservation'
  | 'manual' | 'manualDraft' | 'grantNotice'
  | 'grantApplication' | 'noticeSent' | 'coupon'
  | 'couponCode' | 'slot' | 'thread'
  | 'offer' | 'customer' | 'promoVideo'
  | 'table' | 'playlist' | 'track'
  | 'localChange'
  | 'localTrend'; // N20 keyword detail handles.
export type AgentReadTool =
  | 'list_widget_ids' | 'get_widget' | 'search_records'
  | 'get_source' | 'get_board' | 'get_ui_state'
  | 'get_closing_state' | 'get_recipe' | 'simulate_menu_price'
  | 'check_booking_capacity' | 'calc_expiry_discount' | 'notice.preview'
  | 'get_cctv_review' // N19
  | 'get_promotion_preflight'; // N18
export type AgentCommand =
  | 'menu.create' | 'menu.update' | 'menu.setSaleStatus'
  | 'menu.delete' | 'menu.setRecipe' | 'menu.setOptions'
  | 'inventory.createItem' | 'inventory.updateItem' | 'inventory.moveChannel'
  | 'inventory.deleteItem' | 'inventory.setTracking' | 'booking.create'
  | 'booking.update' | 'booking.confirm' | 'booking.propose'
  | 'booking.cancel' | 'booking.markCompleted' | 'booking.markNoShow'
  // N09 supplier commands.
  | 'suppliers.createPurchaseItem' | 'suppliers.updatePurchaseItem' | 'suppliers.deletePurchaseItem'
  | 'suppliers.createSupplier' | 'suppliers.updateSupplier' | 'suppliers.deleteSupplier'
  | 'suppliers.changeDueDate' | 'suppliers.cancelOrder' | 'suppliers.recordReceipt' | 'suppliers.createOrder'
  // End N09 supplier commands.
  | 'calendar.addEvent' | 'calendar.updateEvent' | 'calendar.addTodo'
  | 'calendar.deleteEvent' | 'calendar.setCategoryVisible' | 'calendar.setSourceVisible'
  | 'staff.create' | 'staff.update' | 'staff.delete'
  | 'staff.saveSchedule' | 'staff.deleteSchedule' | 'staff.moveHandoff'
  | 'ledger.recordExpense' | 'ledger.confirmCandidate' | 'ledger.updateExpense' | 'tax.createPayment'
  | 'tax.updatePayment' | 'tax.deletePayment' | 'tax.setEvidence'
  | 'tax.markChecked' | 'members.create' | 'members.update'
  | 'members.setGrade' | 'members.addNote' | 'members.updateNote'
  | 'members.deleteNote' | 'members.delete' | 'customOrder.create'
  | 'customOrder.update' | 'customOrder.quote' | 'customOrder.recordDecision'
  | 'customOrder.setStage' | 'customOrder.receive' | 'customOrder.cancel' | 'pickup.reschedule'
  | 'pickup.cancel' | 'customTemplate.generate' | 'customTemplate.save'
  | 'customTemplate.delete' | 'manuals.create' | 'manuals.update'
  | 'manuals.delete' | 'manuals.setPublished' | 'manuals.toggleStep' | 'manuals.createDraftFromMemo'
  | 'manuals.saveDraft' | 'manuals.discardDraft' | 'grants.apply'
  | 'grants.updateApplication' | 'grants.deleteApplication' | 'grants.markReviewed'
  | 'notice.saveDraft' | 'notice.importClosure' | 'notice.deleteDraft' | 'notice.send'
  | 'coupon.pause' | 'coupon.resume' | 'coupon.extend' // N16
  | 'coupon.createExpiry' | 'coupon.update' | 'coupon.endEarly' | 'coupon.unpublish' // D-326
  | 'coupon.sendSlot' | 'coupon.notifyEnding' | 'coupon.markPosted' // N16
  | 'reply.draft' | 'inquiry.saveDraft' | 'inquiry.send' | 'inquiry.post' // N17
  | 'community.accept' | 'community.decline' | 'community.sendInterest' // N17
  | 'promo.draft.set' | 'video.make' | 'video.markPosted' | 'coupon.sendReachOut' // N18
  | 'video.retry' // D-328
  | 'environment.setPlaying' | 'environment.skipTrack'
  | 'environment.selectPlaylist' | 'environment.selectTrack' | 'environment.setVolume'
  | 'cctv.markPeakForReview' | 'localChanges.acknowledge' | 'localChanges.unacknowledge'
  | 'layout.add_widget' | 'layout.remove_widget' | 'layout.move_widget'
  | 'layout.resize_widget' | 'layout.move_to_page' | 'layout.add_page'
  | 'layout.add_widgets' | 'layout.remove_widgets' | 'layout.swap_widgets' | 'layout.set_condition'
  | 'layout.start_with_three' | 'layout.start_with_preset' | 'settings.set_theme'
  | 'settings.set_text_scale' | 'settings.set_locale' | 'settings.set_preview_family'
  | 'settings.set_preview_variant' | 'settings.reset_widget_preview' | 'settings.set_closing_preview'
  | 'settings.set_pos_preview' | 'settings.set_detail_fullscreen' | 'ui.openDetail'
  | 'ui.switch_layer' | 'ui.go_to_page' | 'ui.show_panel'
  | 'ui.go_back' | 'ui.open_drawer' | 'ui.close_overlay'
  | 'ui.open_settings' | 'ui.open_widget_help' | 'ui.close_chat'
  | 'ui.skip_coaches' | 'ui.enter_layout_edit' | 'ui.exit_layout_edit'
  | 'ui.set_pos_tab' | 'ui.open_closing' | 'ui.setCctvMode'
  | 'ui.acknowledgeBriefing' | 'ui.replayBriefing';
export type AgentWidgetCommand =
  | 'tax.markPaid'
  | 'customOrder.openPayment' | 'customOrder.openRefund' // N13
  | 'ui.openSettlement' | 'ui.setDraftField'
  | 'supplier.sendOrder' | 'closing.closeDay' | 'closing.undoDay'
  | 'pos.payment' | 'pos.refund' | 'pos.drawerMovement'
  | 'memberships.useOnce' | 'memberships.cancelUse' | 'members.setConsent'
  | 'members.review' | 'memberships.sale' // N12 selected member widget entries.
  | 'tax.export' | 'shop.updateSettings' | 'menu.setPhoto';

export type AgentKnownCommand = AgentCommand | AgentWidgetCommand;
export type AgentToolName = AgentReadTool | 'propose_action';
export type AgentExtraReadTool = Exclude<AgentReadTool, 'list_widget_ids' | 'get_widget' | 'search_records' | 'get_source'>;
export type AgentMissingStatus = 'missing' | 'unavailable' | 'unsupported_period';
export type AgentSlotRef = { readonly slot: AgentSlot };
export type AgentHandleRef = { readonly handle: string };
export type AgentWireValue = string | boolean | number | null | AgentSlotRef | AgentHandleRef | AgentWireArgs
  | readonly AgentWireValue[]; // N07 atomic layout arrays
export interface AgentWireArgs { readonly [field: string]: AgentWireValue | undefined }

// N08 presentation proposal arguments.
export interface AgentSettingsArgs {
  readonly 'settings.set_theme': { readonly theme: 'light' | 'dark' };
  readonly 'settings.set_text_scale': { readonly scale: 100 | 125 };
  readonly 'settings.set_locale': { readonly locale: AgentLocale };
  readonly 'settings.set_preview_family': { readonly family: 'normal' | 'empty' | 'error' | 'special' };
  readonly 'settings.set_preview_variant': { readonly featureId: string; readonly variant: string | null };
  readonly 'settings.reset_widget_preview': { readonly featureId: string };
  readonly 'settings.set_closing_preview': { readonly scenario: 'normal' | 'no-payments' | 'error' | null };
  readonly 'settings.set_pos_preview': { readonly scenario: 'normal' | 'empty' | 'error' | 'payment-failure' | null };
  readonly 'settings.set_detail_fullscreen': { readonly fullscreen: boolean };
}
export const AGENT_SETTINGS_COMMANDS: readonly (keyof AgentSettingsArgs)[];
// End N08 presentation proposals.

// N02 conversation controls contain no continuation values or undo tokens.
export type AgentConversationIntent = { readonly kind: 'conversation' } & (
  | { readonly action: 'confirm'; readonly pendingId: string; readonly target?: string }
  | { readonly action: 'confirm_extra'; readonly pendingId: string; readonly challengeId: string }
  | { readonly action: 'cancel' | 'edit' | 'continue'; readonly pendingId: string }
  | { readonly action: 'undo'; readonly pendingId?: string; readonly featureId?: string; readonly previous?: boolean }
  | { readonly action: 'refer'; readonly ordinal?: 1 | 2 | 3 | 4 | 5; readonly recordKind?: AgentRecordKind; readonly featureId?: string }
  | { readonly action: 'repeat_read'; readonly period?: 'yesterday' | 'previous_month' }
  | { readonly action: 'repeat_read'; readonly period: 'month'; readonly month: number }
  | { readonly action: 'repeat_command' | 'hold' }
);
export type AgentConversationChoice =
  | { readonly type: 'record'; readonly recordKind: AgentRecordKind; readonly querySlot: AgentSlot; readonly handle: string }
  | { readonly type: 'widget'; readonly featureId: string }
  | { readonly type: 'undo'; readonly receiptId: string; readonly target: 'data' | 'layout' };
export type AgentConversationResolution =
  | AgentConversationChoice
  | { readonly type: 'confirm' | 'cancel' | 'edit'; readonly pendingId: string }
  | { readonly type: 'continue'; readonly pendingId: string; readonly field: string }
  | { readonly type: 'extra_confirm'; readonly pendingId: string; readonly challengeId: string }
  | { readonly type: 'reprepare'; readonly pendingId?: string; readonly command: AgentKnownCommand }
  | { readonly type: 'choose'; readonly choices: readonly AgentConversationChoice[] }
  | { readonly type: 'hold' }
  | { readonly type: 'unavailable'; readonly reason: 'pending_missing' | 'target_required' | 'reference_missing'
      | 'undo_expired' | 'undo_unavailable'; readonly featureId?: string };
// End N02 conversation controls.
export type AgentIntent =
  | AgentConversationIntent
  | { readonly kind: 'menu.create'; readonly category: AgentMenuCategory }
  | { readonly kind: 'command'; readonly command: AgentKnownCommand; readonly args?: AgentWireArgs; readonly querySlot?: AgentSlot }
  | { readonly kind: 'read'; readonly featureId?: string; readonly sourceId?: AgentSourceId; readonly condition?: AgentCondition;
      readonly recordKind?: AgentRecordKind; readonly querySlot?: AgentSlot; readonly tool?: AgentExtraReadTool }
  | { readonly kind: 'help' | 'layout' | 'unsupported' };

export interface AgentCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly layer: AgentLayer;
  readonly description?: string;
  readonly conditions: readonly AgentCondition[];
}
export interface AgentFact {
  readonly key: string;
  readonly value: string | number;
  readonly unit: string;
  readonly label: string;
  readonly display: string;
  readonly date?: string;
  readonly start?: string;
  readonly end?: string;
  readonly text?: string;
  readonly source?: string;
}
type AgentProjectionContent =
  | { readonly facts: readonly AgentFact[] }
  | { readonly status: AgentMissingStatus };
export type AgentSnapshotEntry = (
  | { readonly featureId: string }
  | { readonly sourceId: AgentSourceId; readonly candidateAllowed?: false }
) & { readonly condition: AgentCondition } & (
  | AgentProjectionContent
  | { readonly unavailable: true }
);
export interface AgentRecordMatch {
  readonly handle: string;
  readonly match: 'exact' | 'similar';
  readonly label?: string;
  readonly category?: AgentMenuCategory;
  readonly price?: number;
  /** Registry-defined distinguishing fields, including N14 checklist step numbers. */
  readonly fields?: Readonly<Record<string, string | number | boolean | readonly number[]>>;
}
// N10 calendar and staff preflight projections.
export type AgentCalendarRecordFields = Readonly<{
  date?: string;
  source?: 'pickup' | 'delivery' | 'reservation' | 'shift' | 'deadline' | 'direct';
  time?: string;
  kind?: 'event' | 'todo';
  categoryId?: 'store-operations' | 'purchasing' | 'tax-admin';
  closure?: boolean;
  linkedDraftCount?: number;
}>;
export type AgentStaffRecordFields = Readonly<{ scheduleCount?: number }>;
export type AgentShiftRecordFields = Readonly<{
  date?: string;
  kind?: 'work' | 'off';
  start?: string;
  end?: string;
  breakMinutes?: number;
}>;
// End N10 calendar and staff preflight projections.
// N05 inventory record projection.
export type AgentInventoryRecordFields = Readonly<{
  kind?: 'ingredient' | 'retail';
  unit?: 'pcs' | 'L' | 'mL' | 'kg' | 'g';
  sku?: string;
  referenced?: boolean;
  store?: number;
  online?: number;
}>;
// End N05 inventory record projection.
// N06 reservation record projection.
export type AgentBookingRecordFields = Readonly<{
  kind?: 'visit' | 'pickup';
  date?: string;
  time?: string;
  partySize?: number;
  status?: 'needs-check' | 'confirmed' | 'proposed' | 'canceled' | 'completed' | 'no-show';
  source?: 'phone_ai' | 'direct';
  allocationWarning?: 'NO_MATCHING_TABLE' | 'SEAT_LIMIT';
  visitStarted?: boolean;
}>;
// End N06 reservation record projection.
// N12 member and note validation evidence.
export type AgentMemberRecordFields = Readonly<{
  grade?: 'regular' | 'frequent' | 'occasional' | 'inactive';
  deleteBlocked?: boolean;
}>;
export type AgentMemberNoteRecordFields = Readonly<{
  date?: string;
  ownerHandle?: string;
}>;
// End N12 member and note validation evidence.
// N09 supplier record projection.
type AgentSupplierOrderStatus = 'scheduled' | 'partial' | 'complete' | 'canceled';
export type AgentPurchaseItemRecordFields = Readonly<{
  unit?: 'pcs' | 'L' | 'mL' | 'kg' | 'g';
  minimumQty?: number;
  unitPrice?: number;
  orderStep?: number;
  leadDays?: number;
  referenced?: boolean;
  suggested?: boolean;
}>;
export type AgentSupplierRecordFields = Readonly<{ referenced?: boolean }>;
export type AgentPurchaseOrderRecordFields = Readonly<{ date?: string; status?: AgentSupplierOrderStatus; open?: boolean }>;
export type AgentPurchaseOrderLineRecordFields = Readonly<{
  unit?: 'pcs' | 'L' | 'mL' | 'kg' | 'g';
  status?: AgentSupplierOrderStatus;
  open?: boolean;
  remaining?: number;
  unitPrice?: number;
}>;
// End N09 supplier record projection.
// N11 ledger and tax record projection.
export type AgentExpenseRecordFields = Readonly<{ date?: string; amount?: number; status?: 'candidate' | 'confirmed' | 'canceled' }>;
export type AgentTaxPaymentRecordFields = Readonly<{
  date?: string; amount?: number; status?: 'paid' | 'unpaid'; paidOn?: string; evidence?: 'example' | 'none';
}>;
export type AgentTaxItemRecordFields = Readonly<{ date?: string; amount?: number; status?: 'needs-check' | 'checked' }>;
// End N11 ledger and tax record projection.
export interface AgentSearchArgs {
  readonly kind: AgentRecordKind;
  readonly querySlot: AgentSlot;
  readonly cursor?: string;
}
export interface AgentSearchProjection extends AgentSearchArgs {
  readonly matches: readonly AgentRecordMatch[];
  readonly nextCursor?: string;
  readonly status?: AgentMissingStatus;
}
export interface AgentReadArgs {
  list_widget_ids: { readonly layer?: AgentLayer };
  get_widget: { readonly featureId: string; readonly condition: AgentCondition };
  search_records: AgentSearchArgs;
  get_source: { readonly sourceId: AgentSourceId; readonly condition: AgentCondition };
  get_board: { readonly layer: AgentLayer; readonly page?: number };
  get_ui_state: { readonly section?: 'display' | 'preview' | 'shop' | 'pos' };
  get_closing_state: { readonly tab?: 'sales' | 'drawer' | 'history'; readonly date?: string };
  get_recipe: { readonly menuId: AgentHandleRef };
  simulate_menu_price: { readonly menu: AgentHandleRef; readonly price?: AgentSlotRef; readonly cost?: AgentSlotRef };
  check_booking_capacity: { readonly date: AgentSlotRef; readonly time: AgentSlotRef; readonly partySize: AgentSlotRef;
    readonly tableChoice?: 'auto' | AgentHandleRef };
  calc_expiry_discount: { readonly itemId: AgentHandleRef; readonly rate: AgentSlotRef; readonly withSet?: boolean };
  get_promotion_preflight: { readonly action: 'make' | 'reach-out' }; // N18
  get_cctv_review: { readonly date: AgentSlotRef; readonly hour: AgentSlotRef }; // N19
  'notice.preview': { readonly noticeId: AgentHandleRef; readonly draftRevision: AgentSlotRef } | { readonly draft: AgentWireArgs };
}
export type AgentReadProjection = { [Name in AgentExtraReadTool]:
  { readonly tool: Name; readonly args: AgentReadArgs[Name] } & AgentProjectionContent
}[AgentExtraReadTool];

export interface AgentRequest {
  readonly conversation?: true;
  readonly runId: string;
  readonly snapshotRevision: number;
  readonly locale?: AgentLocale;
  readonly layer: AgentLayer;
  readonly page?: number;
  readonly businessDate: string;
  readonly intent: AgentIntent;
  readonly slots: readonly AgentSlot[];
  readonly catalog: readonly AgentCatalogEntry[];
  readonly snapshot: readonly AgentSnapshotEntry[];
  readonly searches: readonly AgentSearchProjection[];
  readonly readings?: readonly AgentReadProjection[];
  readonly references?: readonly { readonly featureId: string; readonly condition: AgentCondition }[];
}

export interface AgentMenuProposalArgs {
  readonly name: { readonly slot: 'name' };
  readonly category: AgentMenuCategory;
  readonly price: { readonly slot: 'price' };
  readonly memo?: { readonly slot: 'memo' };
}
export type AgentConfirmation = 'normal' | 'extra-confirm';
export type AgentRisk = 'local' | 'destructive' | 'external' | 'irreversible' | 'accounting' | 'personal-data' | 'payment' | 'cost';
export interface AgentCommandPolicy {
  readonly featureId: string | null;
  readonly confirmation: AgentConfirmation;
  readonly risk: AgentRisk;
  readonly policy: 'propose' | 'widget-only' | 'handoff';
  readonly required: readonly string[];
  readonly optional: readonly string[];
}
interface AgentProposalBinding {
  readonly proposalId: string;
  readonly runId: string;
  readonly layer: AgentLayer;
  readonly page?: number;
  readonly tier: AgentConfirmation;
}
export type AgentActionProposal = { readonly snapshotRevision: number } & (
  | { readonly command: 'menu.create'; readonly args: AgentMenuProposalArgs } & Partial<AgentProposalBinding>
  | { readonly command: Exclude<AgentCommand, 'menu.create'>; readonly args: AgentWireArgs } & AgentProposalBinding
);
export type AgentToolArgs = AgentReadArgs & { propose_action: Pick<AgentActionProposal, 'command' | 'args'> };
export const AGENT_COMMANDS: readonly AgentCommand[];
export const AGENT_COMMAND_SCHEMAS: Readonly<Record<AgentKnownCommand, object>>;
export const AGENT_COMMAND_CATALOG: Readonly<Record<AgentKnownCommand, AgentCommandPolicy>>;
export const AGENT_RECORD_KINDS: readonly AgentRecordKind[];
export const AGENT_READ_TOOLS: readonly AgentReadTool[];
export const AGENT_EXTRA_READ_TOOLS: readonly AgentExtraReadTool[];
interface AgentTool<Name extends AgentToolName> {
  readonly type: 'function';
  readonly function: { readonly name: Name; readonly description: string; readonly parameters: object };
}
export const AGENT_TOOLS: { readonly [Name in AgentToolName]: AgentTool<Name> };
export function agentProposalTool(command: string): AgentTool<'propose_action'> | undefined;
export function validateAgentToolArgs<Name extends AgentToolName>(name: Name, args: unknown): args is AgentToolArgs[Name];
export function validateAgentToolArgs(name: string, args: unknown): boolean;
export function validateAgentCommandArgs(command: 'menu.create', args: unknown): args is {
  readonly name: string; readonly category: AgentMenuCategory; readonly price: number; readonly memo?: string;
};
export function validateAgentCommandArgs(command: string, args: unknown): boolean;
export function agentDraftSchema(command: string): object | undefined;
export function validateAgentDraft(command: string, args: unknown): args is AgentWireArgs;
export function agentCommandPolicy(command: AgentKnownCommand, args?: object): AgentCommandPolicy;
export function agentCommandPolicy(command: string, args?: object): AgentCommandPolicy | undefined;
export function agentMissingField(command: string, args: AgentWireArgs, slots: readonly AgentSlot[]): string | undefined;
export function agentFieldChoices(command: string, field: string): readonly (string | number | boolean)[];
export type AgentArgumentRef = AgentSlotRef | (AgentHandleRef & { readonly kinds?: readonly (AgentRecordKind | '*')[] });
export function agentArgumentRefs(args: unknown): AgentArgumentRef[];
export function agentCommandRefs(command: string, args: unknown): AgentArgumentRef[];
export function agentToolRefs(name: string, args: unknown): AgentArgumentRef[];
export function validateAgentRequest(value: unknown): value is AgentRequest;

// N04 menu preview validation after private slot expansion.
export type AgentMenuEditCommand = 'menu.update' | 'menu.setSaleStatus' | 'menu.delete' | 'menu.setRecipe' | 'menu.setOptions';
export const AGENT_MENU_EDIT_COMMANDS: readonly AgentMenuEditCommand[];
export function validateAgentMenuEditArgs(command: string, args: unknown): boolean;
// End N04 menu preview validation.

export type AgentPriceChoice = { readonly id: 'manual' } | { readonly id: string; readonly value: number };
/** The menu price anchor is consumed by the existing price control. */
export interface AgentClarification {
  readonly field: 'price';
  readonly promptKey: 'menu.price';
  readonly choices: readonly AgentPriceChoice[];
}
export interface AgentSlotClarification {
  readonly field: string;
  readonly promptKey: string;
  readonly command: AgentKnownCommand;
  readonly choices: readonly ({ readonly id: 'manual' } | { readonly id: string; readonly value: string | number | boolean })[];
}
export interface AgentAmbiguity {
  readonly field: string;
  readonly promptKey: string;
  readonly recordKind: AgentRecordKind;
  readonly querySlot: AgentSlot;
  readonly nextCursor?: string;
  readonly choices: readonly (AgentHandleRef & {
    readonly id: string; readonly label?: string; readonly category?: AgentMenuCategory; readonly price?: number;
  })[];
}
export interface AgentHandoff {
  readonly featureId: string;
  readonly command: AgentKnownCommand;
  readonly draft: AgentWireArgs;
  readonly runId?: string;
  readonly snapshotRevision?: number;
}
export interface AgentRefusal {
  readonly reason: 'widget_only' | 'unsupported' | 'unavailable' | 'duplicate' | 'invalid_target' | 'out_of_scope';
  readonly alternative?: AgentHandoff | { readonly featureId: string };
}
export const AGENT_PRICE_CLARIFICATION: AgentClarification;
export function isAgentPriceClarification(value: unknown): value is AgentClarification;
export type AgentModelReply =
  | { readonly outcome: 'clarify'; readonly field: string }
  | { readonly outcome: 'reply'; readonly text?: string; readonly facts?: readonly string[] }
  | { readonly outcome: 'refused' };
export function validateAgentModelReply(value: unknown): value is AgentModelReply;

export const AGENT_STATUS_STEPS: readonly ['accepted', 'read_started', 'target_checked', 'assembling'];
export const AGENT_ERROR_CODES: readonly ['INVALID_OUTPUT', 'TIMEOUT', 'UNAVAILABLE', 'CANCELLED', 'OUT_OF_SCOPE'];
export interface AgentPanel {
  readonly featureId: string;
  readonly condition: AgentCondition;
  readonly reason: string;
  readonly size: { readonly width: 1 | 2 | 3 | 4; readonly height: 1 | 2 | 3 | 4 };
}
// N03 navigation routes are request-scoped browser actions.
export type AgentNavigationCommand =
  | 'ui.openDetail' | 'ui.switch_layer' | 'ui.go_to_page' | 'ui.show_panel'
  | 'ui.go_back' | 'ui.open_drawer' | 'ui.close_overlay' | 'ui.open_settings'
  | 'ui.open_widget_help' | 'ui.close_chat' | 'ui.skip_coaches'
  | 'ui.enter_layout_edit' | 'ui.exit_layout_edit' | 'ui.set_pos_tab' | 'ui.open_closing';
export interface AgentDetailRef {
  readonly featureId: string;
  readonly view?: string;
  readonly tab?: string;
  readonly itemId?: string;
  readonly focus?: 'action';
  readonly date?: string;
  readonly time?: string;
  readonly hour?: number;
  readonly condition?: AgentCondition;
  readonly filter?: 'praise' | { readonly grade: 'regular' | 'frequent' | 'occasional' | 'inactive' };
  readonly prefill?: Readonly<Record<string, unknown>>;
}
export interface AgentNavigationAction {
  readonly command: AgentNavigationCommand;
  readonly args: AgentWireArgs;
  readonly runId: string;
  readonly snapshotRevision: number;
  readonly layer: AgentLayer;
  readonly page?: number;
}
export const AGENT_NAVIGATION_COMMANDS: readonly AgentNavigationCommand[];
export function isAgentNavigationCommand(command: unknown): command is AgentNavigationCommand;
export function agentNavigationIssue(command: string, args: unknown, wire?: boolean): string | undefined;
export function validateAgentDetailRef(ref: unknown): ref is AgentDetailRef;
export function validateAgentNavigationArgs(command: string, args: unknown): boolean;
export function validateAgentNavigationWireArgs(command: string, args: unknown): args is AgentWireArgs;
export function validateAgentPrefill(featureId: string, value: unknown): value is Readonly<Record<string, unknown>>;
export function agentNavigationRefs(command: AgentNavigationCommand, args: AgentWireArgs, field: string): AgentArgumentRef[];
export function agentNavigationItemKinds(ref: unknown): readonly AgentRecordKind[];
export function agentNavigationHandoffIssue(command: string, draft: object, wire?: boolean): string | undefined;
export function agentHandoffFields(command: string, draft: AgentWireArgs): AgentWireArgs;
// End N03 navigation routes.

export type AgentDone =
  | { readonly outcome: 'reply' | 'proposal' }
  | { readonly outcome: 'refused'; readonly refusal?: AgentRefusal }
  | { readonly outcome: 'clarify'; readonly clarification: AgentClarification | AgentSlotClarification; readonly pendingId?: string }
  | { readonly outcome: 'ambiguous'; readonly clarification: AgentAmbiguity; readonly pendingId?: string }
  | { readonly outcome: 'handoff'; readonly handoff: AgentHandoff }
  | { readonly outcome: 'navigate'; readonly navigation: AgentNavigationAction } // N03
  | { readonly outcome: 'conversation'; readonly resolution: AgentConversationResolution };
export interface AgentActionResult {
  readonly proposalId: string;
  readonly outcome: 'applied' | 'unchanged' | 'invalid' | 'busy' | 'conflict' | 'cancelled';
  readonly revision?: number;
  readonly messageKey?: string;
}
export interface AgentFrameData {
  status: { readonly step: typeof AGENT_STATUS_STEPS[number]; readonly featureId?: string };
  text_delta: { readonly delta: string };
  panels: { readonly panels: readonly AgentPanel[] };
  action_proposal: AgentActionProposal;
  done: AgentDone;
  error: { readonly code: typeof AGENT_ERROR_CODES[number] };
  /** Produced locally by the browser after confirmation. */
  action_result: AgentActionResult;
}
export type AgentFrameName = keyof AgentFrameData;
export type AgentFrame = { [Name in AgentFrameName]: { readonly event: Name; readonly data: AgentFrameData[Name] } }[AgentFrameName];
export function validateAgentFrame<Name extends AgentFrameName>(event: Name, data: unknown): data is AgentFrameData[Name];
export function validateAgentFrame(event: string, data: unknown): boolean;
