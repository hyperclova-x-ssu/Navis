# B19 · Customer groups, performance and today's actions (marketing)

REAL-PLAN pair 19 (D-344, D-347). Marketing owns a read model of B05 member contact state and POS recognized sales, fed by the customer and POS outboxes. It reads B14/B15/B16 through ports and PN12 owner reports through PN-A3's `channelReport`. Every route is an owner-only **read** (`cache-control: no-store`). B19 adds no write command. The reach-out send stays `coupon.sendReachOut` → B14 issuance (R2 SENS). FAKE providers only. B19 makes no outbound calls.

## Routes (public prefix `/api/v1/stores/{storeId}/marketing`, internal `/internal/v1/marketing/stores/{storeId}`)

Errors are `{code, reason, field?, details?}` with `VALIDATION` 400, `UNAUTHENTICATED` 401, `STORE_FORBIDDEN` 403 and `CONFLICT` 409. The business date comes from the gateway clock headers (`x-navis-store-timezone`, `x-navis-business-day-start`) and is returned as `businessDate`.

| Route | Query/body | Response |
| --- | --- | --- |
| `GET /groups` | – | `{asOf, sourceRevision, businessDate, state: ready\|empty, rule, counts:{churn-risk, first-visit, regular}, preview:{<group>: GroupCustomer[≤3]}, reachOut:{groupId:'churn-risk', recipientIds, blockedIds, count}, coverage:{activeMembers, visitedMembers, ungroupedMembers, pendingMembers}}` |
| `GET /groups/:groupId/customers` | `cursor?`, `limit?` 1–200 (50) | `{groupId, count, items: GroupCustomer[], nextCursor, asOf, sourceRevision, businessDate}`. churn-risk lists the oldest last visit first. The other groups list the newest first. Ties sort by member ID. |
| `POST /groups/churn-risk/reach-out-check` | `{recipientIds: uuid[1..200], expectedSourceRevision?}` | `{groupId, eligibleIds, blocked:[{memberId, reason: NOT_IN_GROUP\|NO_MARKETING_CONSENT}], sourceRevision, asOf}`. A stale revision returns 409 `STALE_REVISION` `{details:{sourceRevision}}`. Only `churn-risk` is accepted, matching the Navis policy. |
| `GET /performance` | `period=this-month\|last-month` or `from&to` (≤ 92 days, ≤ today) | `{asOf, sourceRevision, businessDate, period:{from,to,kind}, state: ready\|empty\|partial, missing:['coupons']?, coupons\|null, comparison\|null, rateDelta\|null, basis}` |
| `GET /channel-reports` | `date?` (default yesterday), `unit=day\|week` (Place only) | `{asOf, businessDate, items:[{channel: place\|blog\|clip, state: ready\|unavailable, source, period\|null, cards:[{metric, value, changeRate?, period?}]}]}`. Responses have no totals and no causal or referrer fields. |
| `GET /recommendations` | – | `{asOf, businessDate, state: ready\|empty\|partial, missing: ('coupons'\|'replies'\|'assets')[], cells, folded, tapTarget\|null}` |

`GroupCustomer` is `{memberId, customerId(=memberId), displayName ('김○○' \| null), groupId, visitCount, recentVisits, firstVisitOn, lastVisitOn, daysSinceLast, usualCycleDays|null, contactAllowed, marketingAllowed, selectable, blockedReason}`.

`coupons` contains `{issued, used, rate, payment:{paidAmount, discount, cost|null, knownCost, profit|null, costIncomplete, settlements, pendingSettlements}, repeat:{windowDays:30, matured, returned, immature, unlinked, rate|null}, routes:[{route, issued, used, rate, lines:[{codeId, couponId, name, status, issued, used}]}], byCoupon:[{couponId, name, status, issued, used, rate, paidAmount}]}`. `comparison` is last month for `this-month` only. `rateDelta` is in percentage points with one decimal.

Each cell has the frontend `TodayCell` shape:

- `now`: `quiet-hours {params:{regulars}, quietSlot:{slotId,date,weekday,startHour,endHour}, ref:{featureId:'slot-coupon', view:'send', itemId}}`, or `expiry {params:{count,itemName}, ref:{featureId:'expiry-coupon', itemId}}`.
- `today`: `replies {params:{count, drafted}, ref:{featureId:'ai-response', itemId?}}`.
- `week`: `video {params:{photos}, ref:{featureId:'promo-video', view:'create'}}`.

All refs carry `focus:'action'`. `tapTarget` is the first cell's `{featureId, view?}`.

## Rules and invariants

- **Groups (F-52, AC-302–304).** A visit is one active member's recognized POS settlement per business day. A settlement whose correction set `memberVisitVoided` is excluded. The rule checks first visit (1 visit), then regular (≥ 4 visits in the last 28 days), then may leave (days since the last visit > round(span ÷ (visits − 1)) + 14). The groups do not overlap. The café numbers apply to every business type (PRD 2.4.10 default). The groups never use CCTV, NAVER subscribers (I04/I13) or reservation contacts.
- **Consent.** `selectable` = `contactAllowed && marketingAllowed`, taken from the latest member revision. B05 contact-state events use the revision guard, so a stale revision changes nothing. The issuing command must recheck at commit with `assertReachOutRecipients(db, storeId, ids, at, clock)`, which returns 409 `RECIPIENT_NOT_ELIGIBLE` with `details.blocked`. Live consent at send time remains with the R2 send path.
- **Performance (F-53, D-347 D3, AC-305/1592/1593).** The rate is the used count over the issued count of the same codes, which are the codes whose counting started in the period. Used counts unreversed redemptions up to the period end. `paidAmount` is the POS recognized amount of those settlements net of discount and all corrections. `profit` = `paidAmount − cost` and is null when any sale-time cost is unknown or a settlement has not reached marketing yet. The discount is shown but never subtracted twice. Repeat visits count only uses at least 30 days old with a member ID, and their denominator is shown. A missing ledger yields `coupons:null` and `missing:['coupons']`. No numbers are invented, and the response has no "sales from promotion" field.
- **Channel cards (PN12).** A card is kept only when its report source equals the official owner-screen link for its channel and its metric is in the contract list. Each card keeps its own period and change rate as given. Failure, timeout or a source mismatch marks that channel `unavailable`. Blog/Clip linked-video exclusion copy is F19's.
- **Today (F-47, D-347 #9).** The order is a quiet slot (consented regulars first), else a lot that must sell today, then waiting replies (`drafted` counts real drafts only), then a video when eligible owner photos exist and none was posted this week. A handled candidate is folded. Each port call runs in a savepoint, and a failing or unconfigured source is listed in `missing` (`state:'partial'`).
- Store isolation uses `inStore` (`app.store_id`) with FORCE RLS on all four `r19_*` tables. Without a store context, the runtime role reads nothing. Events carry IDs, amounts and booleans only. A one-letter `nameInitial` is the only name fragment marketing would store.

## Migration `20261122001900_real_groups_performance.sql`

The migration adds `r19_member` (revisioned contact state and an optional one-letter initial), `r19_sale` (one row per settlement: business date, member, paid amount, cost, incomplete flag), `r19_sale_correction` (signed deltas, kind, `member_visit_voided`) and `r19_projection_state` (per-store `sourceRevision`). Every table is store-scoped with FORCE RLS for `marketing_mig` and `marketing_run`, and `marketing_run` has only SELECT, INSERT and the listed UPDATE columns. The down migration drops these tables only.

## Events consumed (consumer group `marketing`)

| Producer | Event | Effect |
| --- | --- | --- |
| customer | `customer.contact_state_changed.v1`, and `customer.member_changed.v1` when it carries `active/contactAllowed/marketingAllowed` | Upsert by `member_revision` (newer only). Optional `nameInitial` (one letter). Note-only and membership changes are ignored. |
| pos | `pos.sale_recognized.v1` | Insert per settlement. A replay is a no-op, and a conflicting replay is a permanent `R19_SALE_MISMATCH`. |
| pos | `pos.sale_corrected.v1` | Insert per correction (`amountDelta ≤ 0`, `costDelta ≤ 0` or null, `memberVisitVoided`). |

Invalid payloads are permanent `INVALID_R19_EVENT` (DLQ). Each applied change bumps `r19_projection_state.revision`.

## Ports (`ports.ts`) — owners implement, the composition layer injects

| Port | Owner | Contract |
| --- | --- | --- |
| `CouponLedger.codes(db, storeId, {from,to})` | B14 | Codes whose counting started in the period, as `{codeId, couponId, couponName, route, issued, activatedOn, status}`. Public codes count their attested cap from attestation. |
| `CouponLedger.redemptions(db, storeId, codeIds, until)` | B14 | `{redemptionId, codeId, couponId, settlementId (POS), memberId\|null, businessDate, discount, reversed}` up to `until`, reversed rows included. |
| `TodaySources.quietSlots / expiringLots` | B14 | `{slotId, date, startHour, endHour, regulars, handled}`, where B14 can use `slotRegulars(db, storeId, {day, weekday, startHour, endHour})` for `regulars`; and `{lotId, itemName, quantity, expiresOn, handled}` from B03 lots. |
| `TodaySources.replies` | B15 | `{waiting, withDraft, firstWaitingId, firstDraftId}` from actual inquiries/reviews and saved drafts. |
| `TodaySources.assets` | B16 | `{eligiblePhotos, postedVideos, firstAssetId}` from owner-uploaded rights-approved photos and this week's posted videos. |
| `ChannelReportPort.channelReport(storeId, channel, {date?, unit?})` | PN-A3 | The `createChannelReads(readJson(transport)).channelReport` shape. Use a FAKE transport until A6. |

Same-DB ports run inside B19's store-scoped read transaction.

## Composition registration

The proof used the temporary hunks in `.evidence/r1-b19/registration.patch` (logs at `/home/<user>/storesaas/logs/r1-b19/`). They were reverted before commit.

1. `gateway/records.ts`: `marketingGroupRoutes` = GET `/groups`, GET `/groups/:groupId/customers`, POST `/groups/:groupId/reach-out-check`, GET `/performance`, GET `/channel-reports`, GET `/recommendations`.
2. `gateway/app.ts`: an option `marketingRecords?: {url, token}` and a record target `{service:'marketing', prefix:'/marketing', routes: marketingGroupRoutes, clock:'all'}` that does not depend on `NAVIS_PHASE3_FIXTURES`. `gateway/index.ts` needs a marketing URL and a gateway→marketing token file for it.
3. `services/marketing/app.ts`: `registerGroupsPerformanceRoutes(app, database, {gatewayToken, coupons, channels, today})` independent of the phase-3 fixture options. `index.ts` injects the B14/B15/B16 ports and PN-A3 `channelReport` (pn12.place/blog/clip bindings, `fakeOnly` in A-3) as they land.
4. `services/marketing/index.ts`: when `NAVIS_REDIS_URL` is set, start `createMarketingStreamConsumers(pool, redis, name, {pos: localPosHandlers /* B13 */})`. This is one consumer per producer in group `marketing`. `mergeStreamHandlers` runs B13 and B19 handlers for the same event type in one transaction.
5. `relay/index.mjs`, `packages/streams/relay.ts`: publish the **customer** producer (`customer: ['marketing']`) and add `marketing` to the `pos` groups. Recovery reads use a marketing relay pool.
6. `infra/local-secrets.sh` (Redis ACL): give a marketing consumer identity `xreadgroup/xautoclaim/xack/xpending` on `navis.pos.0`, `navis.customer.0` and their `.epoch` keys, plus `xadd ~navis.dlq.marketing`. The relay needs `~navis.customer.0 ~navis.customer.0.epoch`. Add a `marketing_redis_password` secret and mount it in `compose.yaml` with `NAVIS_REDIS_URL`.
7. `infra/postgres/30-phase3-access.sh`: a `stream_relay_checkpoint` policy for `marketing_rly` covering `consumer_group = 'marketing' AND producer IN ('pos','customer')`.
8. Seeded demo stores need a stream rebuild after the new group is added, so the read model backfills from the retained outboxes. A seed that writes POS/customer rows without outbox events leaves groups empty.
9. Helm/NetworkPolicy (R9): marketing → Redis, and gateway → marketing for the record target.

## Verification (2026-11-21, gpu-server)

- `services/marketing` vitest with Redis: 23 passed (B19 9, promo, SENS). Backend `npm run typecheck`: exit 0.
- Migration down/up on the test DB: passed. The four tables were restored with FORCE RLS.
- Loopback proof with real account, inventory, POS, customer, marketing and the gateway on PostgreSQL, plus the real `OutboxRelay` → Redis → `StreamConsumer` path. The proof created a menu, a member and marketing consent, then a member cash payment through the UI routes. The member appeared in `first-visit` with the same consent and visit count as `/customers`. A new session re-read the identical DTO, and another store's route was refused. The POS cancellation voided the visit and netted the coupon payment to 0. Consent revocation made the row unselectable. The B14 ledger and PN12 report used in-process FAKEs.
- Filtered A-3 FAKE: 85 IDs and 263 variants. 12 IDs and 49 variants passed, with 0 unauthorized writes. All 79 IDs with a baseline kept their status.
