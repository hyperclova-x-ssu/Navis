/**
 * Adapter outcomes for the PN-A2 marketing provider ports.
 *
 * The codes describe what Navis knows about the provider effect. They are not provider codes:
 * `providerStatus` and `providerCode` keep the documented provider value where one was returned.
 */
export type AdapterCode =
  | 'NOT_CONFIGURED'        // no binding, credential or injected fake transport for the operation
  | 'LIVE_NOT_APPROVED'     // live W call without the A6 allowance or with a non-official origin
  | 'LIVE_CONTRACT_MISSING' // live P/O call: no authorized partner contract exists (PERSONA_NAVER §3)
  | 'INVALID_INPUT'         // owner/widget input outside the documented operation bounds
  | 'CONFIRMATION_REQUIRED' // delete/cancel/end without the second confirmation (D-323)
  | 'CONTRACT_VIOLATION'    // provider response outside the official or partner-assumed field list
  | 'REJECTED'              // provider answered with a documented refusal
  | 'FORBIDDEN'             // provider refused the credential, account or scope
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'           // read failed; nothing changed
  | 'UNKNOWN_OUTCOME';      // write sent but the result is unknown; keep the attempt pending

export class NaverAdapterError extends Error {
  readonly code: AdapterCode;
  readonly providerStatus: number | undefined;
  readonly providerCode: string | undefined;
  readonly detail: string | undefined;

  constructor(code: AdapterCode, info: { providerStatus?: number; providerCode?: string; detail?: string; message?: string } = {}) {
    super(info.message ?? code);
    this.name = 'NaverAdapterError';
    this.code = code;
    this.providerStatus = info.providerStatus;
    this.providerCode = info.providerCode;
    this.detail = info.detail;
  }
}

export const isAdapterError = (error: unknown, code?: AdapterCode): error is NaverAdapterError =>
  error instanceof NaverAdapterError && (code === undefined || error.code === code);
