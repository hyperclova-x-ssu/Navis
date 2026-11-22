# Customer calendar and staff HTTP contract

The calendar owns direct events, to-dos, closure dates, and calendar visibility. Staff and shifts are canonical for calendar, CCTV hourly comparisons, and briefing. The calendar retains dated references to records that other widgets own.

## Owner routes

Public prefix `/api/v1/stores/{storeId}`. Customer prefix `/internal/v1/customer/stores/{storeId}`. The gateway checks the current owner membership and sends the customer workload token, owner/store IDs, and store timezone. Protected responses use `Cache-Control: no-store`.

| Method and path | Request and result |
| --- | --- |
| `GET /staff` · `GET /staff/:id` | Page or one `{staffId,name,archivedAt,revision}`. Active rows have `archivedAt:null`. |
| `POST /staff` · `PATCH /staff/:id` | `{name}`. Patch also requires `expectedRevision`. |
| `DELETE /staff/:id` | `{expectedRevision,expectedScheduleRevision,cascadeSchedules:true,confirmed:true}`. Uses the current `/shifts` page `sourceRevision` for `expectedScheduleRevision`. Archives staff and all active shifts in one reversible command. |
| `GET /shifts` · `GET /shifts/:id` | Page or one `{scheduleId,staffId,date,kind,start,end,breakMinutes,revision}`. List accepts `staffId`. |
| `GET /shifts/history` | Page of `{changeId,at,entityId,operation,before,after}`. List accepts `staffId` and matches date filters against either shift snapshot. Profile history is available without the date filter. |
| `POST /shifts` · `PATCH /shifts/:id` | `{staffId,date,kind,start?,end?,breakMinutes?}`. Patch also requires `expectedRevision`. Work uses `HH:mm`, `start < end`, and an integer break shorter than the shift. Off rows have null times and zero break. |
| `DELETE /shifts/:id` | `{expectedRevision,confirmed:true}`. |
| `POST /shifts/handoff` | `{date,fromTime,toTime,expectedRevision}`. Uses `/shifts` `sourceRevision` and returns `scheduleIds`. Moves every matching incoming and outgoing boundary together. |
| `GET /calendar/events` · `GET /calendar/events/:id` | Page or one `{eventId,kind,categoryId,title,date,time,memo,storeClosure,revision}`. List supports `closuresOnly=true` and selects a closure overlapping the requested period. `title` and `memo` are raw strings and `memo` may be null. |
| `POST /calendar/events` | `{kind,title,date?,time?,memo?,categoryId?,storeClosure?,dateIntent?,confirmDuplicate?}`. Event date is required. To-dos default to the current store date. `storeClosure` is null or `{kind:'regular'|'temporary',endDate}` and applies only to a direct `store-operations` event. |
| `PATCH /calendar/events/:id` | Event change fields and `expectedRevision`. `storeClosure:null` clears the closure marker. The detail read provides the current closure revision for linked notice drafts. |
| `DELETE /calendar/events/:id` | `{expectedRevision,confirmed:true}`. |
| `GET /calendar/preferences` · `PATCH /calendar/preferences` | Read `{sourceVisibility,categoryVisibility,revision}`. Patch `{expectedRevision,source,visible}` or `{expectedRevision,categoryId,visible}`. Start at revision 0, with reservation hidden and other sources and categories visible. |
| `GET /calendar/projections` | Page of `{source,sourceId,sourceRevision,featureId,categoryId,visibility,date,endDate,time,title}`. Read-only links to the owning record. Display titles are fixed Korean labels for the source kind. |
| `GET /calendar/exports?startDate=…&endDate=…` | `text/calendar; charset=utf-8` attachment `navis-calendar.ics`. Includes visible direct events, to-dos, staff shifts, and source projections for the period. Closure end dates are inclusive in Navis and export as exclusive ICS end dates. Timed entries use the store timezone and export in UTC. |
| `POST /calendar/receipts/:id/undo` · `POST /staff/receipts/:id/undo` | `{}`. Same store and owner, one inverse write per receipt, with the original six-second `undoUntil`. Refuses changed or incompatible rows. History includes the inverse. |

Lists return `{items,nextCursor,asOf,sourceRevision}`. `limit` defaults to 100 and accepts 1–200. Reuse `nextCursor` with the same filters. Date filters are optional and accept inclusive `YYYY-MM-DD` bounds. A range with both bounds spans at most 366 days. Downloads require both dates and return an error if the period contains over 2,000 entries.

Owner commands require `Idempotency-Key` and return `{resourceId,revision,receiptId,changed,affectedSources,undoUntil?}` plus operation IDs where applicable. A matching actor, store, key, and body returns the stored receipt. A key reused for a different command returns `409 IDEMPOTENCY_MISMATCH`. `409 STALE_REVISION` includes the current `details.revision`. Review the current row and confirm again. A duplicate title on the same date and kind needs `confirmDuplicate:true`. A newly assigned elapsed date or time needs `dateIntent:'historical'`. Overlap errors carry `details.conflicts` with the exact shifts, including work/off collisions. Source rows are read-only in calendar. Deletes require the confirming control before dispatch. Navis uses the same widget commands and their existing approval tiers.

Staff writes invalidate `staff-schedule`, `calendar`, `customer-analysis`, and `briefing`. Calendar event writes invalidate `calendar`, `notice-send`, `ai-response`, and `briefing`. Visibility writes invalidate `calendar`.

## Producer projections

The producer adds `calendarProjection` to the existing source event payload. Use the same UUID for `aggregateId` and `sourceId`, and increment the source revision when moving or withdrawing an entry. Use `entry:null` to remove it. Dates represent the source's store-local schedule, with an optional inclusive `endDate` and optional `HH:mm` `time`.

```ts
{
  calendarProjection: {
    source: 'purchase-order',
    sourceId: 'b6470891-3a53-409e-9983-cce6b7cc0b09',
    revision: 3,
    entry: { date: '2026-11-24', time: '14:00' },
  },
}
```

| Pair | Source and event | Widget reference |
| --- | --- | --- |
| 04 | `purchase-order` · `inventory.purchase_order_changed.v1` | `suppliers`, purchasing |
| 06 | `reservation` · `projectCalendarSource(db, storeId, 'customer', input)` inside the booking write | `voice-booking`, store-operations |
| 08 | `custom-pickup` · `pos.custom_pickup_changed.v1` | `custom-order`, store-operations |
| 11 | `grant-deadline` · `insight.grant_review_changed.v1` | `grants`, store-operations |
| 13 | `community-offer` · `marketing.partnership_changed.v1` | `community`, store-operations |
| 15 | `notice` · `marketing.message_status_changed.v1` for a notice with its own schedule | `notice-send`, store-operations |
| 18 | `tax-due` · `pos.tax_due_changed.v1` | `tax`, tax-admin |

Only IDs, revisions, and scheduling fields are copied. Removal retains a tombstone so an old delivery cannot restore a withdrawn date. Exact duplicates and older revisions preserve the current state. A different entry at the same revision is rejected. A closure-linked notice stores the closure ID and revision and compares against the current calendar revision before acting. A custom pickup uses the order UUID and the `custom-pickup` identity. B06 can apply a booking-side pickup change in the same customer transaction using that identity and the canonical pickup revision agreed with B08.

The migration adds FORCE RLS to the calendar, staff, and projection tables. Commands update their rows and the shared customer outbox atomically. `customer.calendar_changed.v1` and `customer.staff_schedule_changed.v1` carry `{resourceId,revision,sourceRevision,operation,affectedSources}` under the store/producer sequence. `createCalendarProjectionConsumers` provides the inventory, marketing, and insight subscribers. `calendarPosProjectionHandlers` attaches to the existing customer POS subscriber.

## PN11 one-way exports

[Calendar API](https://developers.naver.com/docs/login/calendar-api/calendar-api.md) ·
[NAVER Login](https://developers.naver.com/docs/login/api/api.md) ·
[WORKS Calendar API](https://developers.worksmobile.com/kr/docs/calendar)

Routes use the existing owner-authenticated store prefix. DTOs are in `naver-wire.ts`.
Every write uses an existing server-approved card UUID as both `approvalId` and
`Idempotency-Key`. The server matches the exact operation, destination, resource, and
source revisions. The delete card additionally requires a verified second confirmation.

| Method and route | Body or query | Result |
| --- | --- | --- |
| POST `/calendar/events/:id/naver` | `CalendarPushRequest`, operation `calendar.add` | `CalendarPushReceipt` |
| GET `/calendar/events/:id/naver` | — | `{ receipt: CalendarPushReceipt \| null }` |
| GET `/shifts/naver-works` | `fromDateTime`, `untilDateTime` in RFC 3339 seconds, positive offsets encoded as `%2B`, at most 31 days | `WorksList` |
| POST `/shifts/:id/naver-works` | `WorksPushRequest`, operation `works.create` | `WorksPushReceipt` |
| PATCH `/shifts/:id/naver-works` | `WorksPushRequest`, operation `works.update` | `WorksPushReceipt` |
| DELETE `/shifts/:id/naver-works` | `CalendarPushRequest`, operation `works.delete` | `WorksPushReceipt` |

The Calendar card sends one direct event as one VEVENT with a stable UID. The success result
accepts PN-FIX `create` and `modify`. The WORKS card sends the canonical local shift using
a stable event ID. List returns this owner's exported shifts from the selected team calendar.
Each item includes the source `revision` and ISO `sentAt` from its latest export receipt.
If WORKS may have saved a create after a timeout, the next export card checks the original
date window for the stable event ID. Once found, Navis records the original revision and
allows an update or delete using a fresh card. A create card for an already adopted event
returns `WORKS_ALREADY_EXPORTED`. When the provider cannot confirm the event, the prior
attempt stays pending with `NAVER_OUTCOME_PENDING`.
Deleting a remote shift export retains its audit receipt and leaves the local shift intact.
A deleted WORKS event ID stays retired. ICS download remains available. Export receipts
are stored in the customer database and emit no outbox events because canonical records
and their dependent widget projections are unaffected.

### Server-issued approval

On the authenticated owner card press, POST `/calendar/naver-approvals` with
`{stage:"press",operation,resourceId,expectedRevision,expectedStaffRevision?}`.
Operations are `calendar.add`, `works.create`, `works.update`, and `works.delete`.
Supply the staff revision only for WORKS create/update. The response is
`{approvalId,expiresAt,requiresConfirmation}` with a 60-second expiry. For WORKS delete,
repeat with `stage:"confirm"` and the returned `approvalId`. Execution uses that ID
as the existing request field and `Idempotency-Key`. Retries replay the original
receipt without a provider write.

The shared `POST /approvals` path takes `targetRef` for the same event/shift ID and
`command: {expectedStaffRevision?}` for the operation-specific fields. It shares the
same approvals and receipts as the widget route.

### Composition registration

- In `backend/gateway/records.ts`, add the six method/path pairs and both POST approval routes to
  `calendarStaffRoutes`. No gateway app changes are needed.
- In `backend/services/customer/app.ts`, accept an optional `naver: NaverCalendarOptions`
  and pass it as `registerCalendarStaffRoutes(app, pool, gatewayToken, { now, naver })`.
  In customer `index.ts`, supply account's current scoped
  synthetic grant lookup, team target resolver, and bounded FAKE or persona bindings.
  Unconfigured customer instances omit the PN11 routes.
- Bind grade W `pn11.calendar.create` to POST `/calendar/createSchedule.json` and
  `pn11.works.{list,create,update,delete}` to GET, POST, PUT and DELETE on the canonical
  linked member/calendar event collection or event detail. Keep the same provider account
  across a store's WORKS operations and the configured persona workload token. Bind the
  scoped WORKS Calendar bearer through the transport's file-mounted provider credential.
  For Calendar, preserve the owner OAuth Authorization header. The team resolver must derive the permitted
  member and calendar from the authenticated owner linkage, never from the browser.
- Apply customer migrations `20261122000803_real_pn11_calendar_export.sql` and
  `20261122000804_real_card_approval.sql`, and `20261122000805_real_pn11_calendar_pending.sql`. The approval registry binds the exact
  provider destination, staff revision where applicable, source revision, store
  and actor. Approval consumption and the launch intent commit together before any provider call.
