# Daily briefing handoff for F12 and composition

Use the existing briefing entry points and the existing owner confirmation
command (`ui.acknowledgeBriefing`). Dashboard arrival remains once per business day under D-327 and
manual revisit opens the alerts tab. Loading the dashboard or briefing does
not acknowledge anything.

## HTTP

- `GET /api/v1/stores/{storeId}/insight/briefings` returns
  `{businessDay,arrivalDay,asOf,acknowledgement,sources}`. The source business
  day uses the Account operating clock and matches POS. `arrivalDay` uses
  weekday opening minus two hours when the authoritative weekly opening
  schedule is supplied, otherwise it is null. Keep the existing D-327
  arrival gate until that schedule is wired. `acknowledgement` is null or
  `{acknowledgedAt,receiptId}`.
- `POST /api/v1/stores/{storeId}/insight/briefings/{businessDay}/ack` takes an
  empty JSON object and `Idempotency-Key` with 1–128 ASCII letters, digits or
  `_.:-`. Send only from the owner-confirmed command. The result is
  `{businessDay,acknowledgedAt,receiptId,resourceId,revision,affectedSources}`.
  The first acknowledgement emits `insight.briefing_acknowledged.v1`.
  Concurrent acknowledgements and retries share the first receipt. A new
  command targeting a previous day returns 409 `BRIEFING_DAY_CHANGED`. A
  key already used for a different day returns 409 `IDEMPOTENCY_MISMATCH`.

Each source is `{origin,state,period,data,asOf?,sourceRevision?}`. A period is
`{from,to}`, inclusive ISO dates, or null for current state without fixed date
bounds. States are `ready`, `partial` (the bounded page has more records),
`unavailable` (the read failed) and `not-connected` (no reader is configured).
The last two carry null data. Empty ready results are valid records.

| Source | Data |
| --- | --- |
| sales | `{projectedNetSales,hours}` from the Insight POS event projection. Each hour has `businessDate,saleHour,netSales`. The projection can lag POS. |
| finance | `{netSales,deposits,expenses,knownCost,unknownCostCount,profit,orderCount,realPaymentCount}` from the POS ledger. Use this net sales figure as authoritative. |
| closing | `{businessDate,status,closingId,closedAt,revision,pendingBillCount}` from POS closing. Link to the existing POS close view. |
| calendar, shifts, calendarProjections | Scoped event, shift and calendar projection lists from Customer. Keep source IDs and revisions. |
| stock, purchasing | Inventory lot IDs, expiry and remaining quantity, plus PO IDs, due date, status and line quantities. Current bounded pages include historical and inactive records. |
| pickups | POS pickup IDs, linked order IDs, times and statuses. Keep pickups separate from reservation party counts. |
| reservations | Customer local reservation rows for the current business day and the next date. Each row has `reservationId,date,time,status,partySize,revision`. Keep all six statuses for the caller to filter. Count seats only from a known `partySize` on a counted visit. The reader follows at most three pages and reports `partial` if a cursor remains or the revision changes. |
| environment | The B10 environment summary fields `current,limits,alerts`, with its observation timestamp. |
| cctv | Camera registration, measurement status, revision and last observation, and nullable current aggregate `{observedUntil,bucketStart,bucketMinutes,avgInStore,maxInStore}`. No live player connectivity claim follows from registration. |
| manualsGrants | B11 `openingChecked,openingSteps,upcomingGrantDeadlines`. Checklist progress is for the business day. The grant count spans that day through the next seven dates. |
| smartCall | PN-A3 SmartCall daily aggregates and channels with the provider's returned period. |
| reviewStatistics | PN-A3 review aggregate themes and keywords with the provider's returned period. |
| local | Marketing Local Changes `items,unreadCount,coverage` for the same Monday–Sunday store-local calendar week as the widget. `unreadCount` covers the full period even when the items page is partial. |
| reviews | Marketing inquiry `items,waitingCount` for persisted inquiries and replies. Drafts expose their source. Replies expose `recorded` for owner attestation, `saved` for provider read-back and `accepted` for provider acknowledgement. |
| notices | Marketing notice `items,waitingCount` for current notice records. Each row includes its status, channel, date range, closure ID and revision when linked, and nullable result state (`recorded`, `saved` or `accepted`). |
| tax | POS `GET /tax-payments?limit=50` returns `{items,next,summary}` in the briefing. The unfiltered page includes owner-recorded paid and unpaid rows. Use `summary.dueSoonCount` and `next` for the alert, even when the page is partial. The paid state records the owner's attestation. Evidence is a status only. Period is null. |
| channels | Marketing `GET /channel-reports` returns `{items}` with owner-visible Place, Blog and Clip cards and their source links. Each channel and card retains its own period. The envelope period is null. Some unavailable channels make the source partial. If all are unavailable the source is unavailable. Cards express reported channel metrics, with no sales attribution. |
| marketingToday | Marketing `GET /recommendations` returns `{cells,missing,folded,tapTarget}` for the business day. The widget's missing-input state makes the source partial. Cells refer to eligible or pending actions and do not confirm any external effects. |
| coupons | Marketing `GET /coupons?status=active&limit=100` returns a bounded array of active Navis coupon records ordered by expiry. Use `endsOn,daysLeft,endingSoon` and the coupon ID and revision. Period is null. NAVER coupons, public-code publication attestations, code strings and recipients are outside this read. |

For future readers, retain the originating IDs, revisions and source periods.
Keep provider-confirmed effects distinct from Navis drafts and owner-entered
records. Fixtures must never represent externally completed effects.

## Composition registration

Apply Insight migration `20261122001200_real_briefing.sql`. The tables use forced
store RLS. Relay the acknowledgement event from the existing Insight outbox.

Register `registerBriefing(routes,pool,{gatewayToken,now,readers,readOpenings})`
within the authenticated Insight route plugin. Build `readers` from
`recordSources({customer,inventory,pos,marketing})` with private service URLs and
workload tokens. The Customer read credential also permits `GET /reservations`.
Marketing uses `NAVIS_INSIGHT_MARKETING_URL` and a distinct
`NAVIS_INSIGHT_MARKETING_READ_TOKEN_FILE` for `/local-changes`, `/inquiries`
and `/notices`. Extend that existing read credential's method/path allowlist
with GET `/channel-reports`, `/recommendations` and `/coupons`. Extend the
existing POS briefing credential's allowlist with GET `/tax-payments`. No
new private URLs or credentials are needed. Bind B19's recommendation
ports and its FAKE PN12 report port. The readers use the verified store and
actor scope and fetch fresh source data on every briefing request. Briefing
can refresh after the B18 `pos.tax-payments` and B14 `coupon-status` receipt
invalidations. B18 still publishes `pos.tax_due_changed.v1` for the calendar
projection. Briefing reads POS directly and requires no new consumer or
migration. B06 and B13 receipts and B15
notice receipts already invalidate the briefing through `affectedSources`.
Bind `personaSources(fakeInsightNaver)` only with the private FAKE PN-A3
adapter. The optional opening schedule reader must return seven
`HH:mm` opening times from Sunday through Saturday.

In the gateway use `briefingRoutes` with an empty prefix and `clock: 'all'`.
The exported routes already include `/insight`. Use the operating Insight
record target independently of the phase-3 fixture flag.
