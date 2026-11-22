# R1 B10 Insight HTTP contract

The public prefix is `/api/v1/stores/{storeId}/insight`. The internal prefix is `/internal/v1/insight/stores/{storeId}/insight`. Every route requires a current owner session through the gateway. The Insight service independently checks the workload token and matching store and actor headers.

## Reads

| GET route | Item fields |
| --- | --- |
| `/cameras` | `cameraId, zoneSetRevision, lastObservedAt, measurementStatus, deviceStatus`. Measurement status is `ok\|partial\|none` for the current zone set within 15 minutes, and device status is `registered\|unavailable`. A registered device may have no measurement. |
| `/zones?cameraId=` | `zoneId, zoneVersionId, cameraId, zoneSetRevision, label, polygon, linkRevision`. Legacy device zones have null labels and polygons. The stable zone ID persists across edits; historical buckets retain their immutable version IDs. |
| `/table-links?cameraId=` | `zoneId, zoneVersionId, cameraId, zoneSetRevision, tableId, revision, tableState`. Table IDs are B02 POS UUIDs. The currently enabled account profile controls visibility. A POS archive clears the link when its event is applied. |
| `/cctv-buckets?cameraId=&from=&to=` | `cameraId, bucketStart, bucketMinutes, zoneSetRevision, observedUntil, status, avgInStore, maxInStore, entries`. Entries carry `zoneId, zoneVersionId, occupiedSeconds, finishedSessions, finishedSecondsSum, toClearEvents`. Each measurement has its own camera, version and time window. |
| `/environment-readings?from=&to=` | `readingId, measuredAt, temperatureC, humidityPct, source:'manual'`. |
| `/cctv-reviews?date=YYYY-MM-DD` | `reviewId, hour, revision, markedAt`, limited to 24 results ordered by hour. |

Lists return `{items,nextCursor,asOf,sourceRevision}`. Send an opaque `cursor` with the same filters and keep the same explicit period across pages. Lists support `limit` from 1 to 100 (default 50) except for reviews, which always return the full date. Period timestamps require a UTC or explicit offset and a range up to 31 days. The default period is the previous 24 hours. Buckets use `[from,to)` and manual readings include both endpoints. `sourceRevision` advances with committed Insight outbox events.

`GET /environment-limits` returns `{revision,temperatureRange,humidityRange}` with initial inclusive default ranges of 18–25°C and 40–60%. `GET /environment-summary` returns `{current,limits,alerts,asOf,sourceRevision}`; `current` is the latest owner reading or null. Alert fields are `{metric,direction,value,range,readingId}` with direction `below\|above`. The environment widget and briefing should read this same summary.

For CCTV staffing, join scoped B07 `GET /shifts?startDate=&endDate=` with the bucket window in the account store timezone. Count distinct staff IDs for work shifts covering the hour. B07 exposes break minutes without a break placement; avoid assigning a break to a specific hour. Associate POS state using B02 `GET /pos/tables` and the live link. Seat-wait or clearing labels require reliable continuous observations and a known POS state; missing inputs remain unmeasured. Never sum camera population counts without deduplication.

## Commands

Every write uses `Idempotency-Key` and returns `{resourceId,revision,receiptId,affectedSources,undoUntil?}`. The same key and body return the same receipt for this actor/store. A different command or body under the same key returns `409 IDEMPOTENCY_MISMATCH`. Stale optimistic revisions return `409 STALE_REVISION`.

| Method and path | Body |
| --- | --- |
| `POST /environment-readings` | `{measuredAt,temperatureC,humidityPct}`. Timestamp cannot be in the future; accepted ranges are −50 to 80°C and 0 to 100%. |
| `PATCH /environment-limits` | `{expectedRevision,temperatureRange:[min,max],humidityRange:[min,max]}`. |
| `PATCH /cameras/:id/zones` | `{expectedRevision,zones:[{zoneId?,label,polygon:[{x,y}]}],confirmed?}`. Full set replacement on a registered camera. Coordinates are normalized to [0,1]. Include existing stable IDs when editing. Omission of an existing zone requires `confirmed:true`. The updated configuration gets new immutable zone version IDs. |
| `PATCH /zones/:id/table-link` | `{expectedRevision,tableId,confirmed?}`. Use the zone's `linkRevision`, initially 0. A null table ID unlinks with separate confirmation `confirmed:true`. An occupied endpoint returns `LINK_IN_USE`. A POS table absent from the active projection returns `TABLE_UNAVAILABLE`. Disabled table mode returns `TABLE_LINK_DISABLED`. |
| `POST /cctv-reviews` | `{date,hour}`, the existing `cctv.markPeakForReview` arguments. A current business day and a measured hour are required. Use an owner card press for Navis action execution. |
| `POST /receipts/:id/undo` | Empty JSON or omitted body. Reverts only the actor's active CCTV review within the original receipt deadline. |

The authorized device path retains its aggregate schema and token. On a region update, apply the new zone set revision and version IDs in the authorized device configuration before collecting new buckets. The service reports the new set as unmeasured until matching data arrives. Cameras, zone polygons and anonymous aggregates carry no footage, face identities or member references. Sensors and player control remain capability-gated.

## Composition registration

- Inside the Insight app's existing gateway-token owner plugin, call `registerB10Routes(routes, pool, gatewayToken, now)` from `reality/10/routes.ts`. Configure the gateway workload credential and target independently of the Phase 3 fixture flag and retain the distinct device intake path.
- Add an Insight record target with all public routes above as explicit allowlist entries. Forward the `/insight` segment on both hops and preserve owner-only, same-origin, idempotency and body limits. Supply the trusted account operating clock on write paths. For the table links GET and PATCH, set `x-navis-pos-tables-enabled` from the current authenticated account profile (postpaid, supported business type, configured layout, table view enabled). Never trust a browser value for this header.
- Add `'pos.table_changed.v1': posTableChanged` from `reality/10/projection.ts` to the existing Insight POS consumer's handler map. Use one consumer group/checkpoint over the POS producer stream. Rebuild/replay the POS stream as required to populate tables whose events were checkpointed before this handler existed.
- Migration `20261122001000_real_store_observations.sql` owns the shared Insight `outbox` and `outbox_scope`. B11 can append to this pair. Provision Insight relay SELECT/UPDATE policies and table grants, Redis Insight producer keys, and Insight relay group topology for dependent consumers as they land. The stable event names are `insight.zone_changed.v1`, `insight.cctv_bucket_recorded.v1`, `insight.cctv_review_changed.v1`, `insight.environment_reading_recorded.v1` and `insight.environment_limits_changed.v1`. Apply migration before rolling the new aggregate handler.
