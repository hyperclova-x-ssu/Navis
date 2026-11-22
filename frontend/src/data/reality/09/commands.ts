/**
 * REAL-PLAN F09 — widget-only drawer and cash-movement commands of the closing overlay. They exist only over HTTP (the
 * fixture store keeps the POS drawer commands of the run); the Navis command policy does not list them.
 * `expectedRevision` is optional: the port fills the revision of the last read of that day when the overlay leaves it out.
 */
export type MoneyRealCommand =
  | { readonly type: 'closing.setDrawer'; readonly date: string; readonly opening?: number; readonly actual?: number | null; readonly memo?: string; readonly expectedRevision?: number }
  | { readonly type: 'closing.addMovement'; readonly date: string; readonly kind: 'in' | 'out'; readonly amount: number; readonly memo?: string; readonly expectedRevision?: number }
  | { readonly type: 'closing.removeMovement'; readonly date: string; readonly movementId: string; readonly confirmed: true; readonly expectedRevision?: number };
