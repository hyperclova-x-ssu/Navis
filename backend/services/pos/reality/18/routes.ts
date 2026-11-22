import { uuid } from '../../wire.ts';
import type { PosOwnerRouteWithPreflight } from '../../preflight.ts';
import type { VerifyTaxEvidence } from './evidence-client.ts';
import { createExport, exportDetail, exportFile, listExports, previewExport } from './exports.ts';
import { prepareAttachEvidence, createPayment, deletePayment, detachEvidence, listPayments, markPaid, paymentDetail, updatePayment } from './payments.ts';
import { checkReview, listReviews } from './reviews.ts';
import { undoTax } from './undo.ts';

/** Gateway allowlist for `/api/v1/stores/{storeId}/pos` (clock: all). Kept here so the composition layer can copy it verbatim. */
export const taxGatewayRoutes = [
  ['GET', '/tax-payments'], ['POST', '/tax-payments'], ['GET', '/tax-payments/:id'], ['PATCH', '/tax-payments/:id'],
  ['DELETE', '/tax-payments/:id'], ['POST', '/tax-payments/:id/paid'], ['POST', '/tax-payments/:id/evidence'],
  ['DELETE', '/tax-payments/:id/evidence/:fileId'],
  ['GET', '/tax-reviews'], ['POST', '/tax-reviews/:id/check'],
  ['GET', '/tax-exports/preview'], ['GET', '/tax-exports'], ['POST', '/tax-exports'], ['GET', '/tax-exports/:id'],
  ['GET', '/tax-exports/:id/file'], ['POST', '/tax/receipts/:id/undo'],
] as const;

/** Register on the gateway-owner registrar that requires the operating clock (same as the B09 finance routes). */
export function registerTaxRoutes(owner: PosOwnerRouteWithPreflight, { verifyEvidence }: { verifyEvidence?: VerifyTaxEvidence } = {}) {
  owner('GET', '/tax-payments', 'read', (tx, _params, _body, _key, query) => listPayments(tx, query));
  owner('GET', '/tax-payments/:id', 'read', (tx, { id }) => paymentDetail(tx, uuid(id)));
  owner('POST', '/tax-payments', 'command', (tx, _params, body, key) => createPayment(tx, key, body));
  owner('PATCH', '/tax-payments/:id', 'command', (tx, { id }, body, key) => updatePayment(tx, key, uuid(id), body));
  owner('DELETE', '/tax-payments/:id', 'command', (tx, { id }, body, key) => deletePayment(tx, key, uuid(id), body));
  owner('POST', '/tax-payments/:id/paid', 'command', (tx, { id }, body, key) => markPaid(tx, key, uuid(id), body));
  owner('POST', '/tax-payments/:id/evidence', 'command', {
    prepare: (scope, { id }, body, key) => prepareAttachEvidence(scope, key, uuid(id), body, verifyEvidence),
  });
  owner('DELETE', '/tax-payments/:id/evidence/:fileId', 'command', (tx, params, body, key) =>
    detachEvidence(tx, key, uuid(params.id), uuid((params as { fileId?: string }).fileId), body));
  owner('GET', '/tax-reviews', 'read', (tx, _params, _body, _key, query) => listReviews(tx, query));
  owner('POST', '/tax-reviews/:id/check', 'command', (tx, { id }, body, key) => checkReview(tx, key, uuid(id), body));
  owner('GET', '/tax-exports/preview', 'read', (tx, _params, _body, _key, query) => previewExport(tx, query));
  owner('GET', '/tax-exports', 'read', (tx, _params, _body, _key, query) => listExports(tx, query));
  owner('POST', '/tax-exports', 'command', (tx, _params, body, key) => createExport(tx, key, body));
  owner('GET', '/tax-exports/:id', 'read', (tx, { id }) => exportDetail(tx, uuid(id)));
  owner('GET', '/tax-exports/:id/file', 'read', (tx, { id }, _body, _key, query) => exportFile(tx, uuid(id), query));
  owner('POST', '/tax/receipts/:id/undo', 'command', (tx, { id }, body, key) => undoTax(tx, key, uuid(id), body));
}
