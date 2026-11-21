# Insight Phase ③ handoff

Insight owns the POS sales read model, CCTV briefing aggregates, confirmed Navis proposal receipts and per-attempt AI usage. These private paths use synthetic data in Mac Compose. The current Insight entry point enables the routes through workload token files. The agent uses a fake provider with the existing native v3 adapter and typed SSE parser.

## Workload contracts

Store paths begin with `/internal/v1/insight/stores/{storeId}`. Include the relevant workload bearer and `X-Navis-Store-Id` matching the path. Gateway calls also include the verified `X-Navis-User-Id` and `X-Navis-Store-Role: owner`. Errors use `{code}` and responses use `Cache-Control: no-store`.

| Method and path | Workload | Request and response |
| --- | --- | --- |
| POST `/navis/chat` | Gateway | Send `X-Navis-Protocol: agent-v1`. A typed `read` with `sourceId: 'pos'` uses the authenticated store's recognized sales and corrections. The bridge returns the existing typed SSE frames through `done`. An empty period yields the agent's missing-data answer. |
| POST `/navis/chat` | Gateway | For a marketing `video.make` proposal, send `{turn,actionSlots}`. `turn` is the existing typed agent request with its slot names and references. `actionSlots` maps the referenced names to the selected menu IDs, photo IDs, moods, concepts and memo. Insight validates both shapes and stores the resolved draft before sending `action_proposal`. The model receives the sanitized turn. A conversational confirmation resolves to hold. |
| POST `/navis/proposals/{proposalId}/confirm` | Gateway | Send `{source:'card', runId, snapshotRevision}` only from the owner card. Insight locks the scoped proposal and uses a stable action key. A successful request or replay returns `202 {jobId}`. Wrong actor, run or store returns `404`. Stale revision and expired unconfirmed cards return `409`. A lost response can be retried with the same card. |
| POST `/ai/usage` | Promo worker | Send one record per actual outbound attempt. The body is `{attemptId,correlationId,stage,model,mode,latencyMs,outcome,inputTokens?,outputTokens?,reasoningTokens?}`. IDs are UUIDs. Modes are `text`, `image`, `function_calling` and `structured_outputs`. Outcomes are `success`, `length`, `rate_limited`, `error`, `timeout`, `cancelled`, `filtered`, `invalid_output` and `unavailable`. The original submission returns `201 {duplicate:false}`. Identical replay returns `200 {duplicate:true}`. A changed attempt body returns `409 IDEMPOTENCY_MISMATCH`. |
| GET `/sales?from=YYYY-MM-DD&to=YYYY-MM-DD` | Forecast cron | Use an inclusive range of at most 28 dates. Returns `{days:[{businessDate,netSales,menu:[{menuId,quantity}]}],hours:[{businessDate,saleHour,netSales}]}`, ordered by day and then menu ID or clock hour. Amounts are integer KRW. Dates without a recognized sale are absent. An observed day corrected to zero still has a row. |
| GET `/briefing/cctv` | Gateway | Returns `{buckets}` with up to 24 recent aggregates ordered by bucket start, newest first, and camera ID. Each bucket includes its versioned zone entries. A measured zero remains numeric and unmeasured counts are null. |

### Domain handoff for T-313

After card confirmation Insight calls `POST /internal/v1/marketing/stores/{storeId}/promo/jobs` with the Insight-to-marketing workload bearer, verified owner and matching store headers, `Idempotency-Key: navis:{proposalId}`, and `{source:'card',proposalId,snapshotRevision,input}`. The domain checks the accepted revision and the store's eligible inputs. It returns `{jobId}` with status 200, 201 or 202, or `409 {code:'STALE_SNAPSHOT'}` for a stale revision. On repeat it looks up the same action key before revalidating the draft, so a retry after a committed job can recover the original ID. The local test supplies a fake HTTP endpoint. T-316 wires the real endpoint.

Allocate a fresh attempt UUID immediately before each actual model call, including retries. Report the provider's input and output counts, including zero. Use null or omit a count when missing. Report eligible reasoning only when the provider measured it in a supported mode. Function calling and the HCX-007 Structured Outputs story plan carry null reasoning. The bridge's quota limiter reserves budget before I/O in a separate in-memory window. Quota reservations are outside the write schema and the usage ledger.

### POS replay for T-315

Use the POS event's effective `businessDate` and the original recognition time's Asia/Seoul clock hour. Both cancellation and refund reduce net sales in the original hour. Cancellation restores the affected menu quantities. A money-only refund leaves the menu quantities attributable to the original sale. The consumer uses T-307's runner as the `insight` group on `navis.pos.0`. The projection, inbox and checkpoint commit in one DB transaction before ACK. Q3 uses the T-307 ordered runner and its default reclaim/retry windows. Q4 uses recognized sales as input. Q5 uses the producer's same-open-day fixture corrections.

### CCTV registration and intake

`POST /internal/v1/insight/cctv/aggregates` uses a registered device bearer. The service derives the store and camera from that credential and validates the registered zone-set revision. See BACKEND_PLATFORM §6 for the snake_case aggregate fields. A closed, matching bucket returns 201 on first intake and 200 on identical replay. Conflicting content at the same camera and bucket returns 409. Raw frames, identity data and unknown fields are rejected. For Q7, provision one synthetic camera and its zone revision with `registerCamera` from `cctv.ts` using the migration pool. Provision the bearer from a fixture secret file.

## T-316 runtime inputs

- Mount separate files through `NAVIS_GATEWAY_INSIGHT_TOKEN_FILE`, `NAVIS_FORECAST_INSIGHT_TOKEN_FILE`, `NAVIS_PROMO_INSIGHT_TOKEN_FILE` and `NAVIS_INSIGHT_MARKETING_TOKEN_FILE`. Point `NAVIS_MARKETING_BASE_URL` at the private marketing workload. Set `NAVIS_INSIGHT_AGENT_MODE=fixture` for local SSE.
- Package `frontend/server/` and `frontend/shared/` in the Insight and tools images. The existing N18 agent contract must include the `video.make` proposal and its slot-based schema. The earlier widget-only schema cannot prepare that card.
- Add Insight to migration tooling. Route user and device traffic separately in the gateway. Forward `X-Navis-Protocol` on typed chat, the verified user/store context on owner paths, and the device credential on aggregate intake.
- Run `20261121000300_inputs.sql` and `20261121000400_pos_consumer.sql` through the standard migration runner. Add `insight` to the POS relay's required groups and grant it checkpoint reads through the relay role. Provision the `insight` Redis consumer ACL and `NAVIS_INSIGHT_REDIS_PASSWORD_FILE`. Use `NAVIS_REDIS_URL` for the private Redis address.
- Enable local device intake with `NAVIS_INSIGHT_CCTV_ENABLED=1`. Use `NAVIS_INSIGHT_FIXTURE_NOW` to pin a fixture clock for device expiry, bucket closure and card expiry. Q9 uses fake adapters. Cloud provider credentials, hosted rollout, and live tests remain gated.

## Local verification

Use the existing Compose tools image with the Insight, existing server and shared source mounted until T-316 packages them. Use the `test-db` profile and set `NAVIS_INSIGHT_TEST_REDIS_URL` to a disposable Redis service on the private test network to exercise replay. The acceptance file is `services/insight/insight.test.ts`.
