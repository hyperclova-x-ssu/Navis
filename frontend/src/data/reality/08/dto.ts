/**
 * REAL-PLAN F08 — wire shapes of the POS custom-order API (B08, `.evidence/real/B08-custom-dto.md`) and their projection into the run.
 * The service returns the existing i7 `CustomTemplate` / `CustomOrderView` / `PickupReservation` names plus a per-row `revision`.
 * Money stays in the POS ledger: the order read carries the service's own `payment` view, which the widget shows as is.
 */
import type { DataTables, Reservation } from '../../db/types';
import type { CustomOrder, CustomOrderPaymentView, CustomTemplate, PickupReservation } from '../../iteration7/custom-orders/types';

export type CustomTemplateDto = CustomTemplate;
export type CustomPickupDto = PickupReservation & { readonly revision: number };
export interface CustomOrderDto extends CustomOrder {
  readonly revision: number;
  readonly paymentId?: string | null;
  readonly pickup?: PickupReservation | null;
  readonly confirmedPickupAt?: string | null;
  readonly payment: CustomOrderPaymentView;
}

/** What an HTTP build keeps beside the `customTemplate` / `customOrder` tables. */
export interface RealCustomSnapshot {
  readonly pickups: readonly PickupReservation[];
  readonly payments: Readonly<Record<string, CustomOrderPaymentView>>;
  readonly paymentIds: Readonly<Record<string, string | null>>;
  readonly asOf: string;
}

export const customTemplateKey = (id: string) => `custom-template:${id}`;
export const customOrderKey = (id: string) => `custom-order:${id}`;
export const customPickupKey = (id: string) => `custom-pickup:${id}`;

export interface CustomPages {
  readonly templates: readonly CustomTemplateDto[];
  readonly orders: readonly CustomOrderDto[];
  readonly pickups: readonly CustomPickupDto[];
  readonly asOf: string;
}

/** The row without the transport fields the service adds (they live in `revisions`, `payments` and `pickups`, not in the table row). */
const withoutKeys = <T extends object>(value: T, keys: readonly string[]): T =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;
const pickupRow = (row: CustomPickupDto): PickupReservation => withoutKeys(row, ['revision']);
const ORDER_VIEW_FIELDS = ['revision', 'paymentId', 'pickup', 'confirmedPickupAt', 'payment'] as const;

/** Rows for the tables and the resource revisions the commands send back as `expectedRevision`. */
export function projectCustom(pages: CustomPages): {
  readonly tables: Pick<DataTables, 'customTemplate' | 'customOrder' | 'realCustom'>;
  readonly revisions: Readonly<Record<string, number>>;
} {
  const revisions: Record<string, number> = {};
  const payments: Record<string, CustomOrderPaymentView> = {};
  const paymentIds: Record<string, string | null> = {};
  const orderRevision = new Map<string, number>();
  const customOrder = pages.orders.map(view => {
    const order = withoutKeys(view, ORDER_VIEW_FIELDS) as unknown as CustomOrder;
    revisions[customOrderKey(order.customOrderId)] = view.revision;
    orderRevision.set(order.customOrderId, view.revision);
    payments[order.customOrderId] = view.payment;
    paymentIds[order.customOrderId] = view.paymentId ?? null;
    return order;
  });
  const embedded = pages.orders.flatMap(order => order.pickup ? [order.pickup] : []);
  const byId = new Map<string, PickupReservation>(embedded.map(row => [row.reservationId, row]));
  for (const row of pages.pickups) {
    byId.set(row.reservationId, pickupRow(row));
    // The pickup's revision is its order's POS revision; the two reads can straddle a commit, so keep the newer.
    revisions[customPickupKey(row.reservationId)] = Math.max(row.revision, orderRevision.get(row.customOrderId) ?? 0);
  }
  for (const row of byId.values()) {
    const key = customPickupKey(row.reservationId);
    if (revisions[key] === undefined && orderRevision.has(row.customOrderId)) revisions[key] = orderRevision.get(row.customOrderId)!;
  }
  for (const template of pages.templates) revisions[customTemplateKey(template.templateId)] = template.revision;
  return {
    tables: {
      customTemplate: pages.templates.filter(template => template.archivedAt === null),
      customOrder,
      realCustom: { pickups: [...byId.values()], payments, paymentIds, asOf: pages.asOf },
    },
    revisions,
  };
}

/** The visit rows stay with the booking domain; HTTP pickups replace every fixture pickup. */
export function withRealPickups(reservations: DataTables['reservation'], real: RealCustomSnapshot | undefined): DataTables['reservation'] {
  if (!real) return reservations;
  const visits = reservations.filter((row): row is Reservation => row.kind !== 'pickup');
  return [...visits, ...real.pickups];
}
