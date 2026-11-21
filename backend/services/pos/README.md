# POS Phase ② fixture

T-306 migrates the POS database and seeds the generated café's active menu on its configured 05:00 Asia/Seoul business-day boundary. The synthetic cutoff is 2026-11-17T06:45:00Z. The sequence starts at 153 to match the existing café fixture. POS owns the frozen orders, settlement allocations, payments, corrections, and signed sales-recognition entries. The retained outbox uses one increasing bigint sequence per store. The append-only money records link compensations to their original recognition and payment.

## Local private HTTP

The service registers owner routes when `NAVIS_GATEWAY_POS_TOKEN_FILE` points to the scoped credential file. It registers the customer claim routes when `NAVIS_CUSTOMER_POS_TOKEN_FILE` points to a distinct scoped credential file. Either credential requires a fixed `NAVIS_POS_FIXTURE_NOW` timestamp. With neither credential configured, the service exposes health and readiness. The existing Compose service and gateway need the T-307 workload wiring. The fixture's payment adapter is in-process.

All paths are relative to `/internal/v1/pos/stores/{storeId}`. Use the matching `X-Navis-Store-Id` and the calling workload's bearer token. Owner routes additionally require `X-Navis-Store-Role: owner` and `X-Navis-User-Id` from the verified gateway context. These paths are private workload interfaces.

| Method and path | Request and result |
| --- | --- |
| POST `/bills` | `{type,lines:[{menuId,qty,optionIds?}],discount?}`. Returns an open prepaid bill and current quote in `value`. |
| POST `/approvals` | `{billId,quoteRevision,splits:[{method,amount}]}`. Returns the pending attempt and its fingerprint. |
| POST `/approvals/{attemptId}/finish` | `{expectedQuoteFingerprint}`. Use the approval's command key. Returns the original completion on identical replay. If pricing changed, use the returned fresh quote and a new approval key. |
| GET `/payments/{paymentId}/receipt` | Original amounts and payment splits plus current reversal balance and ordered corrections. |
| POST `/payments/{paymentId}/reversal-quote` | `{kind,lines?,amount?,methodAmounts?}`. Returns preparation eligibility and an opaque quote token. A line is `{orderLineId,qty}`. |
| POST `/corrections` | `{quoteToken,confirmed:true}`. Commits one append-only correction and its outbox event. |
| POST `/orders/{orderId}/preparation` | `{status:'preparing'|'completed'}`. Updates the original order's preparation for reversal eligibility. |
| POST `/claims` | Customer credential. `{claimId,commandKey,kind,sourceId,sourceVersion}` binds the versioned claim to a POS approval key. The supported kinds are `reservation_first_order` and `membership_use`. |
| GET `/outcomes/{commandKey}` | Customer credential. Returns `{status,result}`; `missing` and `pending` keep the claim held. |
| POST `/outcomes/{commandKey}/abort` | Customer credential. `{claimId}` must identify the exact bound claim. Returns its durable terminal result or records an abort that fences late approval. |

Send an `Idempotency-Key` for owner writes other than a reversal quote. Keys scope to store and command type. Changed input for an already used key yields `IDEMPOTENCY_MISMATCH`. Accepted approval and correction echoes retain their original IDs and amounts even when the live receipt later shows a corrected balance.

## Handoff

- **T-307 / Q3** owns relay grants and RLS policy, scoped workload credentials, runtime packaging, Redis, and consumer checkpoint/replay. POS writes `pos.outbox` with UUID event IDs, integer `schema_version`, and a store-scoped decimal bigint sequence. Read `store_seq` without rounding when building the shared event envelope. Backend and DevOps still need to confirm retry thresholds, required groups, replay ownership and repair, retention/trim, Redis durability, and DB restore targets. Cross-producer ordering requires PM confirmation. Production costs and retention scope go through W5.
- **T-308** receives the contracts in `packages/contracts/events.ts`. Deduplicate usage by original `settlementId` and adjustments by `correctionId`. Sale and cancellation lines carry the original menu, option and recipe-version IDs and the recognized or restored quantity respectively. Refunds carry zero physical quantity. The fixture versions are SHA-256 fingerprints of the generated `recipeBase` and `extraRecipe` arrays, with object keys sorted and array order preserved. POS's `recordReceiptExpenseCandidate` accepts an inventory receipt event and a transaction client with store scope set. Commit with consumer dedupe and checkpoint. A change to an existing receipt's amount, supplier, or date raises an error for the consumer to handle.
- **T-309 / Q4** owns reservation and member claim acquisition, the linked-order and benefit writes, reconciliation and one-time benefit restoration. An attached claim key stops at `CLAIM_INTEGRATION_PENDING` until that integration is implemented. Pending conflict presentation, failure/release authority, archived-table treatment and actor attribution remain open. Owner decisions cover manual overrides and recovery authority.
- **Q5** accepts local corrections on the original open day. Confirm production cost/discount and unknown-cost handling, close revisions, stock carry/projection and effective boundary history before extending. The owner decides whether a post-close correction needs audited reopening or uses the next open day. The current fixture covers prepaid, positive-money, non-member café sales, one order per bill, and a direct whole-bill discount. Public gateway route schemas and lifecycle policy for later phases need architecture documentation. Receipt reads show the paid snapshot and correction history; cash-receipt issuing, separate member/account axes, and closing/reopen commands belong to later slices.
