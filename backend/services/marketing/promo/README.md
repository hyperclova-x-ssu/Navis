# Durable promo jobs

T-313 owns the marketing migration, the private promo routes and the stage worker. T-314 can use `inStore(pool, storeId, run, { serialize: true })` and call `appendMarketingEvent(db, storeId, { type, aggregateId, payload })` in the same transaction as its send ledger write. Both event types share the store sequence.

## Private interfaces

| Caller | Interface | Contract |
| --- | --- | --- |
| Insight | POST `/internal/v1/marketing/stores/:storeId/promo/jobs` | Use Insight's dedicated marketing confirmation credential, the confirmed owner/store headers and `Idempotency-Key: navis:<proposalId>`. The body is `{ source: "card", proposalId, snapshotRevision, input }`. A same-key repeat returns the recorded job and its current state. A different payload returns `ACTION_CONFLICT`. A distinct job for the same store while one is active returns `BUSY`. |
| Gateway | GET `/internal/v1/marketing/stores/:storeId/promo/jobs/:jobId` | Use a separate read credential and the verified owner/store headers. A finished job includes the ready account asset ID and the gateway-relative video URL under `/api/v1/stores/:storeId/promo/jobs/:jobId/video.mp4`. |
| Gateway | GET `/internal/v1/marketing/stores/:storeId/promo/jobs/:jobId/video.mp4` | Apply the same owner/store scope. The handler proxies the published T-312 object, supports a single byte range and returns 404 before completion or for a different store. |

Register the routes with `registerPromoRoutes` in `routes.ts`. The resolver supplies a store-specific server catalog, exterior dimensions, and T-312 file bindings for the selected photos and exterior. Only server-resolved file IDs go into job state. Set up the synthetic catalog and register its private inputs before enabling the routes.

## Worker integration

- Apply `20261121000500_promo.sql` first. It creates the scoped marketing outbox and consumer tables. T-316 adds the relay grants and the Redis workload identities. The producer is `marketing` and the consumer group exported as `promoGroup` is `marketing-worker`. The v1 promo event payload contains only `{ jobId }`, matching the UUID aggregate ID.
- Mount `createPromoConsumer` from `workers/marketing-worker/promo/events.ts`. Pass any additional marketing handlers into the same group so one consumer cannot acknowledge an event the other handler needs. The promo handler makes the job claimable in the same transaction as the stream checkpoint. The provider work runs separately.
- Call `createPromoWorker(...).runNext(storeId, signal)` from the worker loop for each configured fixture store. Poll each store even when Redis is idle so expired leases and committed checkpoints can recover. Each call claims and processes one stage. The default lease is 30 seconds, renewed every 10 seconds, with a 5-second delay for unsettled or transient failures. Database transactions bind store scope and hold only database work.
- Use `createArtifactClient` and `createUsageClient` with separate workload credentials to Account and Insight. The worker calls the existing story and static scene checks through `createPipeline`. Supply the existing `runSceneCheck` and `checkVideo` adapters for the sandbox and video checks. The Compose fixture uses prerecorded output, a fake browser-check adapter and deterministic probe/luma fixtures.
- `createFakePromoProvider` routes look to HCX-005 and story/scene planning to HCX-007 Structured Outputs with thinking disabled. Scene HTML defaults to the existing Claude CLI seam with an injected fake process. `NAVIS_PROMO_SCENE_PROVIDER=naver` selects the fake NAVER comparison path. The `claude-api` option is gated at W5. Each fake invocation uses one stable attempt ID. An ambiguous attempt remains pending until the adapter confirms the result or conclusively fences the original attempt as never sent. Known invalid output gets one retry. Insight receives one record per resolved outbound attempt, with absent tokens stored as unknown.

Each validated stage has a private checkpoint reference. A finished job points at exactly one ready asset. Each lease owns its own upload identity, so bytes from a late worker cannot replace the published file. A crash after Account verification and before the final marketing commit can leave an unreferenced ready candidate. Account's abandoned-upload cleanup handles uploads that have yet to become ready. Ready orphan retention is part of the later storage lifecycle decision.

T-316 owns the Compose entrypoint, migration CLI wiring, relay identity/grants and edge routing. The existing local bridge continues to serve the legacy catalog, estimates, retry and gallery paths.

## Acceptance in local Compose

Use the existing `test-db` and cached `tools` image in `navis-backend-local`. Attach a disposable Redis service to the internal `test-data` network. Set `NAVIS_PROMO_TEST_REDIS_URL` to its Compose hostname and run Vitest on `services/marketing/promo/promo.test.ts`. Mount the current backend services/workers and sibling `server` and `shared` directories into the tools image. The acceptance run verifies the real T-311 confirmation and usage APIs, T-312 artifact checks, PostgreSQL RLS and Redis redelivery with fake model and media I/O.
