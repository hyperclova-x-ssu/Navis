import type { ShopSettings as ContractShopSettings } from '../../contracts';
import type { DataText } from './types';

export type BaseUnit = 'g' | 'kg' | 'mL' | 'L' | 'pcs';
export type MemberGrade = 'regular' | 'frequent' | 'occasional' | 'inactive';
export type CalendarCategory = 'store-operations' | 'purchasing' | 'tax-admin';
export interface RecipeLine { readonly recipeLineId: string; readonly menuId: string; readonly itemId: string; readonly quantity: number; readonly unit: BaseUnit }
export interface StockOpening { readonly itemId: string; readonly businessDate: string; readonly quantityBase: number; readonly sourceReceiptId?: string }
export interface StockAdjustment { readonly adjustmentId: string; readonly itemId: string; readonly at: string; readonly deltaBase: number; readonly reason: 'initial' | 'cell-edit'; readonly seq: number }
export interface PurchaseItem { readonly purchaseUnit?: BaseUnit; readonly basePerUnit?: number; readonly purchaseItemId: string; readonly itemId: string; readonly supplierId: string; readonly minimumQty: number; readonly unitPrice: number; readonly orderStep: number; readonly leadDays: number }
export interface ShopSettings extends ContractShopSettings { readonly layoutActivated: boolean }
export interface MemberProfile { readonly memberCode?: string; readonly dbMemberId?: string; readonly memberId: string; readonly customerId: string; readonly joinedOn: string; readonly gradeOverride: MemberGrade | null }
export interface MemberNote { readonly noteId: string; readonly memberId: string; readonly body: DataText; readonly updatedAt: string }
export interface ReservationChange { readonly changeId: string; readonly reservationId: string; readonly at: string; readonly kind: 'created' | 'updated' | 'canceled' | 'status'; readonly before: unknown; readonly after: unknown }
export type PaymentMethod = 'card' | 'easy_pay' | 'cash';
export interface Payment { readonly methodSplits?: readonly { readonly method: PaymentMethod; readonly amount: number }[]; readonly seq?: number; readonly paymentId: string; readonly businessDate: string; readonly time: string; readonly method: PaymentMethod; readonly kind: 'payment' | 'refund' | 'cancel'; readonly refundOf?: string; readonly gross: number; readonly discount: number; readonly refundAmount: number; readonly summary: DataText;
  readonly status?: 'paid' | 'partially_canceled' | 'canceled' | 'partially_refunded' | 'refunded'; readonly originalAmount?: number; readonly restockRetail?: boolean;
  readonly cashReceipt?: import('../../contracts/pos').PosCashReceipt | null;
  readonly billId?: string; readonly transactionNo?: string; readonly approvalNo?: string; readonly orderNos?: readonly number[];
}
export interface PaymentLine { readonly grossAmount?: number; readonly discountAmount?: number; readonly refundAmount?: number; readonly paymentLineId: string; readonly paymentId: string; readonly menuId: string; readonly qty: number; readonly unitPriceAtSale: number; readonly unitCostAtSale: number | null }
export interface SalesSnapshot { readonly gross: number; readonly discount: number; readonly refund: number; readonly net: number; readonly byMethod: Readonly<Record<PaymentMethod, number>>; readonly methodCounts: Readonly<Record<PaymentMethod, number>>; readonly paymentCount: number; readonly refundCount: number }
export type ClosingScenario = 'normal' | 'empty';
export interface DayClosing { readonly closingId: string; readonly businessDate: string; readonly generation: number; readonly scenario: ClosingScenario; readonly status: 'closed' | 'reopened'; readonly closedAt: string; readonly reopenedAt?: string; readonly accountingSnapshot?: import('../iteration7/accounting/types').AccountingDay; readonly salesSnapshot: SalesSnapshot; readonly paymentRevision: number; readonly drawerSnapshot?: import('../../contracts/pos').PosDrawerSnapshot; readonly posTotalsSnapshot?: import('../../contracts/pos').PosDayTotals }
export interface TaxPayment { readonly taxPaymentId: string; readonly type: DataText; readonly amount: number; readonly dueOn: string; readonly paidOn: string | null; readonly status: 'unpaid' | 'paid'; readonly evidence: 'example' | 'none';
  readonly real?: { readonly revision: number; readonly overdue: boolean; readonly evidenceFiles: readonly import('../reality/18/dto').TaxEvidenceFile[] } }
export interface GrantApplication { readonly applicationId: string; readonly noticeId: string; readonly appliedOn: string; readonly status: 'applied' | 'reviewing' | 'selected' | 'rejected' | 'completed'; readonly resultMemo: DataText | null }
export interface CctvCamera { readonly cameraId: string; readonly name: DataText; readonly connection: 'connected' | 'disconnected'; readonly operation: 'recording' | 'stopped'; readonly lastCheckedAt: string; readonly stillImageKey: string }
export interface CommandLedgerEntry { readonly fingerprint: string; readonly result: unknown; readonly status: 'applied' | 'undone'; readonly closingId?: string }
export interface ManagementTables {
  readonly recipeLine: readonly RecipeLine[];
  readonly stockOpening: readonly StockOpening[];
  readonly stockAdjustment: readonly StockAdjustment[];
  readonly purchaseItem: readonly PurchaseItem[];
  readonly shopSettings: ShopSettings;
  readonly memberProfile: readonly MemberProfile[];
  readonly memberNote: readonly MemberNote[];
  readonly reservationChange: readonly ReservationChange[];
  readonly payment: readonly Payment[];
  readonly paymentLine: readonly PaymentLine[];
  readonly dayClosing: readonly DayClosing[];
  readonly taxPayment: readonly TaxPayment[];
  readonly grantApplication: readonly GrantApplication[];
  readonly cctvCamera: readonly CctvCamera[];
  readonly categoryVisibility: Readonly<Record<CalendarCategory, boolean>>;
  readonly commandLedger: Readonly<Record<string, CommandLedgerEntry>>;
}
