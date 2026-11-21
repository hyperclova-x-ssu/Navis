import type { BusinessType, TableLayout } from '../../contracts';
import type { BaseUnit, CalendarCategory, ClosingScenario, GrantApplication, MemberGrade, TaxPayment } from '../db/management-types';
import type { ManualCategory, UnitCode } from '../db/types';
import type { PosMenuPhotoSelection, PosOptionGroup } from '../../contracts/pos';
export interface MenuPatch { readonly name?: string; readonly category?: 'drink' | 'dessert'; readonly price?: number; readonly memo?: string | null }
export interface PurchasePatch { readonly supplierId?: string; readonly minimumQty?: number; readonly unitPrice?: number; readonly orderStep?: number; readonly leadDays?: number }
export interface SupplierPatch { readonly name?: string; readonly contact?: string; readonly phone?: string; readonly memo?: string | null }
export interface BookingInput { readonly memberId?: string; readonly guest?: { readonly name: string; readonly phone?: string }; readonly date: string; readonly time: string; readonly partySize: number; readonly request?: string | null; readonly tableChoice: 'auto' | { readonly tableId: string } }
export interface ManualInput { readonly section: 'handover' | 'store-info'; readonly title: string; readonly category: ManualCategory; readonly steps?: readonly (string | { readonly body: string; readonly photoKey?: string })[]; readonly cautions?: string }
export type SettingsCommand = { readonly type: 'onboarding.setAnswers' | 'shop.updateSettings'; readonly businessType: BusinessType | null; readonly paymentStyle: 'prepaid' | 'postpaid'; readonly cctvPosLinks?: readonly import('../../contracts/session').CctvPosLink[]; readonly tableLayout?: TableLayout | null; readonly baseRevision?: number };
export type ManagementCommand =
  | { readonly type: 'menu.create'; readonly name: string; readonly category: 'drink' | 'dessert'; readonly price: number; readonly memo?: string; readonly idempotencyKey: string }
  | { readonly type: 'menu.update'; readonly menuId: string; readonly patch: MenuPatch }
  | { readonly type: 'menu.delete'; readonly menuId: string }
  | { readonly type: 'menu.setOptions'; readonly menuId: string; readonly groups: readonly PosOptionGroup[] }
  | { readonly type: 'menu.setSaleStatus'; readonly menuId: string; readonly status: 'selling' | 'sold_out' }
  | ({ readonly type: 'menu.setPhoto'; readonly menuId: string } & PosMenuPhotoSelection)
  | { readonly type: 'menu.setRecipe'; readonly menuId: string; readonly lines: readonly { readonly recipeLineId?: string; readonly itemId: string; readonly quantity: number; readonly unit: BaseUnit }[] }
  | { readonly type: 'inventory.createItem'; readonly sku: string; readonly name: string; readonly unit: UnitCode; readonly stock: number; readonly threshold: number; readonly trackRestock?: boolean; readonly idempotencyKey: string }
  | { readonly type: 'inventory.deleteItem'; readonly itemId: string }
  | { readonly type: 'inventory.setTracking'; readonly itemId: string; readonly trackRestock?: boolean; readonly trackExpiry?: boolean }
  | { readonly type: 'suppliers.updatePurchaseItem'; readonly purchaseItemId: string; readonly patch: PurchasePatch }
  | { readonly type: 'suppliers.createPurchaseItem'; readonly itemId: string; readonly supplierId: string; readonly minimumQty: number; readonly unitPrice: number; readonly orderStep: number; readonly leadDays: number; readonly idempotencyKey: string }
  | { readonly type: 'suppliers.deletePurchaseItem'; readonly purchaseItemId: string }
  | { readonly type: 'suppliers.createSupplier'; readonly name: string; readonly contact: string; readonly phone: string; readonly memo?: string; readonly idempotencyKey: string }
  | { readonly type: 'suppliers.updateSupplier'; readonly supplierId: string; readonly patch: SupplierPatch }
  | { readonly type: 'suppliers.deleteSupplier'; readonly supplierId: string }
  | { readonly type: 'suppliers.createOrder'; readonly purchaseItemId: string; readonly qty: number; readonly dueDate?: string; readonly suggestionItemId?: string; readonly idempotencyKey: string; readonly confirmDuplicate?: boolean }
  | { readonly type: 'suppliers.cancelOrder'; readonly poId: string }
  | { readonly type: 'members.create'; readonly name: string; readonly phone: string; readonly idempotencyKey: string }
  | { readonly type: 'members.update'; readonly memberId: string; readonly name?: string; readonly phone?: string }
  | { readonly type: 'members.delete'; readonly memberId: string }
  | { readonly type: 'members.setGrade'; readonly memberId: string; readonly grade: MemberGrade | null }
  | { readonly type: 'members.addNote'; readonly memberId: string; readonly body: string }
  | { readonly type: 'members.updateNote'; readonly memberId: string; readonly noteId: string; readonly body: string }
  | { readonly type: 'members.deleteNote'; readonly memberId: string; readonly noteId: string }
  | ({ readonly type: 'booking.create'; readonly idempotencyKey: string; readonly confirmDuplicate?: boolean } & BookingInput)
  | { readonly type: 'booking.update'; readonly reservationId: string; readonly patch: Partial<BookingInput>; readonly confirmDuplicate?: boolean }
  | { readonly type: 'booking.cancel'; readonly reservationId: string }
  | { readonly type: 'booking.markCompleted'; readonly reservationId: string }
  | { readonly type: 'tax.createPayment'; readonly taxType: string; readonly amount: number; readonly dueOn: string; readonly idempotencyKey: string; readonly confirmDuplicate?: boolean }
  | { readonly type: 'tax.updatePayment'; readonly taxPaymentId: string; readonly patch: { readonly type?: string; readonly amount?: number; readonly dueOn?: string; readonly paidOn?: string | null; readonly status?: TaxPayment['status'] } }
  | { readonly type: 'tax.deletePayment'; readonly taxPaymentId: string }
  | { readonly type: 'tax.markPaid'; readonly taxPaymentId: string }
  | { readonly type: 'tax.setEvidence'; readonly taxPaymentId: string; readonly evidence: TaxPayment['evidence'] }
  | { readonly type: 'calendar.setCategoryVisible'; readonly categoryId: CalendarCategory; readonly visible: boolean }
  | { readonly type: 'grants.apply'; readonly noticeId: string; readonly idempotencyKey: string }
  | { readonly type: 'grants.updateApplication'; readonly applicationId: string; readonly status?: GrantApplication['status']; readonly resultMemo?: string | null }
  | { readonly type: 'grants.deleteApplication'; readonly applicationId: string }
  | ({ readonly type: 'manuals.create'; readonly idempotencyKey: string; readonly confirmDuplicate?: boolean } & ManualInput)
  | { readonly type: 'manuals.update'; readonly manualId: string; readonly patch: Partial<ManualInput> }
  | { readonly type: 'manuals.delete'; readonly manualId: string }
  | { readonly type: 'closing.closeDay'; readonly date: string; readonly idempotencyKey: string; readonly scenario: ClosingScenario; readonly expectedGeneration: number }
  | { readonly type: 'closing.undoDay'; readonly date: string; readonly scenario: ClosingScenario; readonly closingId: string; readonly idempotencyKey: string }
  | SettingsCommand;
