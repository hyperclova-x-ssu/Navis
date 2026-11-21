# PostgreSQL test SMS ledger

Apply `20261121000600_sens.sql` after the T-313 promo migration. The SMS ledger reuses the marketing store transaction, outbox sequence and stream checkpoint. The ledger stores the request fingerprint, body digest and a keyed routing digest. The approved text and consented number remain with their server-side resolvers.

## T-316 wiring

| Caller | Private interface | Contract |
| --- | --- | --- |
| Authenticated card dispatcher | POST `/internal/v1/marketing/stores/:storeId/sens/attempts` | Send the dedicated confirmation bearer token, verified `X-Navis-Store-Id`, `X-Navis-User-Id`, `X-Navis-Store-Role: owner` and `Idempotency-Key: navis:<proposalId>`. The body is `{ source: "card", proposalId, snapshotRevision, input: { draftId, targetId, body } }`. The dispatcher verifies the owner press and binds the proposal and revision before forwarding. |
| Authenticated gateway | GET `/internal/v1/marketing/stores/:storeId/sens/attempts/:receiptId` | Send the separate read bearer token and the same verified store and owner headers. Only the confirming owner can read the receipt. |

Register `registerSensRoutes(app, pool, { confirmToken, readToken, policy })` with the runtime pool. Both routes return `{ receiptId, state, acceptance, delivery }`. The POST returns 202 while unsettled and 200 once settled. Both receipts begin as null. Acceptance includes `requestId` and `recordedAt`. Delivery begins as `{ status: "pending", recordedAt: null }` and settles independently to `delivered` or `failed`. A repeated POST returns the stored state and a conflicting key returns `409 CONFLICT`. The private response reports fake provider acceptance for Phase ③. The existing browser API-311/312 compatibility belongs at the gateway or development bridge.

Supply `policy.settingsForStore` with the store's server-side, owner-entered enablement, sender and SENS credentials and a registry of opaque aliases mapped to exact numbers and explicit SMS consent. Supply `policy.draftForOwner` with the actor and store's issued draft, session UUID, sample ID, expiry and approved reply lines. Preserve the existing ten-minute draft expiry across worker restarts and use the same authoritative resolvers on the service and worker. The send path reuses the legacy EUC-KR validator from `frontend/server/sens-sms.mjs`. Package that module with the backend at the same relative path.

## Worker

- Register `[messageQueued]: dispatchTestSms` in the existing `createPromoConsumer` handler map. The producer is `marketing` and the consumer group is `marketing-worker`. `marketing.message_queued.v1` carries only `{ receiptId }`, which matches the aggregate UUID. Dispatch and the stream checkpoint commit together before acknowledgement.
- Poll `createSensWorker(pool, { policy, transport }).runNext(storeId)` for each configured store. The worker commits one claimed dispatch identity before fake provider I/O. The local budgets are one open attempt per store, one reservation and one provider call per minute, three of each per rolling day, and one send per sample and draft session. The worker applies a 15-second provider deadline.
- Use `reconcile(storeId, receiptId)` to revisit a pending receipt or a claim whose deadline passed. Unknown stays pending. A definitive no-send must fence the original dispatch identity against late acceptance. It permits one retry after the send budget opens and the worker revalidates registration, consent, routing settings and the draft. A recorded provider request ID prevents a no-send response from enabling retry.
- `createFakeSensTransport()` is an in-process fixture provider with no network I/O. Its instance represents the provider across worker recreation in the acceptance tests. An independent fixture provider can use the `FakeSensTransport` interface for a worker process restart before reconciliation.

## Compose acceptance

Run `npm test -- services/marketing/sens/sens.test.ts` in the local tools image against the separate Compose `test-db` and a disposable Redis on the internal test network. Set `NAVIS_SENS_TEST_REDIS_URL` to that Redis URL and mount the current backend and sibling server/shared sources. The tests exercise the runtime DB role and the shared stream consumer with synthetic drafts and credentials. T-316 owns the private runtime and integrated smoke. Hosted transport, receipt operations and cutover remain gated at W5.
