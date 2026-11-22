/** Widget-only operations. The existing Navis tax commands keep their original arguments. */
export type TaxRealCommand =
  | { readonly type: 'tax.attachEvidence'; readonly taxPaymentId: string; readonly fileId: string; readonly expectedRevision: number }
  | { readonly type: 'tax.detachEvidence'; readonly taxPaymentId: string; readonly fileId: string; readonly expectedRevision: number };
