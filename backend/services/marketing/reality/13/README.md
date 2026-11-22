# R1-B13 marketing local and community HTTP contract

Browser prefix is `/api/v1/stores/:storeId/marketing`. The same suffixes mount privately at
`/internal/v1/marketing/stores/:storeId`. All routes require current owner/workload authorization.
POST requires the separate trusted card-command credential and `Idempotency-Key` (8–128 ASCII
letters, digits, underscores, colons or hyphens). The UI and Navis use the same commands.
Dates are ISO calendar dates, timestamps are ISO UTC and identifiers are UUIDs unless specified.

## Reads

Every local changes or offer page has `{items,nextCursor,asOf,sourceRevision}`.
`limit` is optional (default 50, 1–200). Send the returned UUID `nextCursor` with the same filters.
`sourceRevision` is a store-scoped integer, initially 0. Explicitly send `from` and `to`
for time-series or local-change reads. Dates are inclusive and their difference is at most 366 days.

| GET suffix | Query | Response |
| --- | --- | --- |
| `/local-changes` | `{from,to,limit?,cursor?}` | Page plus `period:{from,to}`, `unreadCount:number` across the full period, and `coverage:{region,referenceDate,kinds}\|null`. Items are `{id,revision,kind,title,region,authority,sourceUrl,dateKind,referenceDate,acknowledgedAt,updatedAt}`. |
| `/trade-area` | `{from,to,quarter,weekday}` | `{asOf,period,population,sales}`. Quarter is `YYYY-Q1` through `YYYY-Q4`. Weekday is ISO 1–7. See the series below. |
| `/local-trends` | `{from,to,keyword?}` (trimmed keyword, 1–80 chars) | `{asOf,period,search,links,sales}`. Search is null without a keyword. See the series below. |
| `/offers` | `{limit?,cursor?}` | Page of `{id,revision,senderStoreId,recipientStoreId,title,terms,startsOn,endsOn,respondBy,status,interested,updatedAt,visibility,sharedContact,canRespond}`, sorted by response deadline. `visibility` is `direct`. The status is `pending\|accepted\|declined`. `sharedContact` is a string or null and is shown only on accepted offers. `canRespond` means the current store is the recipient of an open, unexpired offer. Live store participation is checked again on write. |
| `/offers/peers` | none | `{status:'available'\|'unavailable',items:{storeId,displayName}[]}`, up to 200 peer stores with account-approved bilateral visibility. |

Local change `kind` is `food-license\|festival\|owner-record`. The corresponding `dateKind`
is `license-date\|event-date\|recorded-date`. `sourceUrl` and `acknowledgedAt` are nullable.
Coverage lists the official kinds for the supported region and reference date.

- Trade-area `population` is `{status,source:'seoul-living-population',unit:'movement-estimate',quarter,weekday,items}`.
  A band is `{region,quarter,weekday,startHour,endHour,estimate,referenceDate,refreshedAt,sourceUrl}`.
  Hours use a half-open interval. Leave missing bands absent and display a missing-data state.
- Trade-area `sales` is `{status,source:'pos',unit:'quantity',items:{hour,quantity,settlementIds}[]}`.
  POS sales are bucketed by the selected weekday in Asia/Seoul with opaque settlement IDs for ledger navigation.
- Local-trends `search` is `{status,source:'naver-search-interest',unit:'relative-index',query,items:{period,ratio}[]}`.
  `query` is `{startDate,endDate,timeUnit:'date',keywordGroups:[{groupName,keywords}]}`.
  Relative values 0–100 apply within this request window.
- Local-trends `sales` is `{status,source:'pos',unit:'quantity',items:{businessDate,menuId,quantity}[]}`.
- Status is `available\|empty\|unavailable` for these series. Values for movement, quantity,
  and relative interest use separate series.

## Writes

All successful POSTs return HTTP 200 with `{resourceId,revision,receiptId,affectedSources,undoUntil?}`.
The same store, actor, key and normalized command return the identical receipt on retry. Keep
the original `undoUntil` in the receipt/toast. Send an empty object for undo. Local-change receipt
sources are `['local-changes','briefing']`. Offer receipt sources are `['community','calendar','briefing']`.
These use feature IDs, including the `calendar` and `briefing` spellings used by B07.

| POST suffix | Body | Command |
| --- | --- | --- |
| `/local-changes` | `{title,region,referenceDate,sourceUrl?}` | Owner-recorded change. Title ≤160, region ≤100, optional HTTPS URL ≤2048. A linked record remains owner-sourced. |
| `/local-changes/:id/ack` | `{expectedRevision}` | `localChanges.acknowledge({changeId})`. An actual acknowledgement includes `undoUntil` (six seconds). |
| `/local-changes/:id/unack` | `{expectedRevision}` | `localChanges.unacknowledge({changeId})`, a new explicitly approved command. |
| `/local-changes/receipts/:id/undo` | `{}` | Uses the original receipt ID, actor, store, expiry and resulting revision. |
| `/offers` | `{recipientStoreId,title,terms,startsOn,endsOn,respondBy,sharedContact?}` | Create for one approved participating peer. Maximum lengths are 160 for title, 1000 for terms and 160 for opt-in shared contact. |
| `/offers/:id/accept` | `{expectedRevision}` | `community.accept({offerId})`, recipient only. |
| `/offers/:id/decline` | `{expectedRevision,confirmed:true}` | `community.decline({offerId})`, recipient only, extra confirmation. |
| `/offers/:id/interest` | `{expectedRevision}` | `community.sendInterest({offerId})`, recipient only. Remains pending and sets the interest flag. |

Errors contain `{code,reason}` with machine-readable reason tokens.

| HTTP | Code / reason |
| --- | --- |
| 400 | `INVALID_REQUEST`, `CONFIRMATION_REQUIRED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` (including objects hidden by RLS) |
| 409 | `IDEMPOTENCY_CONFLICT`, `STALE_REVISION`, `OFFER_EXPIRED`, `OFFER_CLOSED`, `UNDO_EXPIRED` |
| 413, 415 | `INVALID_REQUEST` |
| 503 | `UNAVAILABLE` |

## Composition registration

- Invoke `registerLocalMarketingRoutes(app,pool,{readToken,commandToken,canOffer,listPeers,searchInterest})`.
  Apply migration `20261122001300_real_local.sql` and allowlist all routes above. Keep the POST credential
  on the server and issue it only for the verified owner-card execution path. Independently enforce
  live account membership and store identity at the gateway.
- Account `canOffer(senderStoreId,recipientStoreId)` must check current approved participating stores.
  `listPeers(storeId)` resolves their approved display names. With these dependencies omitted, the peer
  listing is unavailable and offer creation/response fails closed.
- Wire `localPosHandlers` into the marketing POS stream consumer for `pos.sale_recognized.v1`
  and `pos.sale_corrected.v1`. The handler deduplicates per POS event/allocation and stores only
  menu, settlement, quantity and time references. Reversals use the original sale period.
- Wrap PN-A2 `createSearchPort` via `pn10SearchInterest(portForStore)`. Pass only a store-scoped
  in-process FAKE binding, and keep A6 off. No provider is contacted by the marketing module itself.
- Use `importOfficialLocalSnapshot` with the marketing migrator and reviewed official rows. Automatic
  public-data collection is outside this module. Supported region and kinds come from that snapshot.
- `marketing.local_change_recorded.v1` and `marketing.local_change_acknowledged.v1` carry change ID,
  revision and acknowledgement state where applicable. Re-read unread counts for the requested period.
- `marketing.partnership_offer_changed.v1` carries pending, interest and declined transitions for
  both participating stores. `marketing.partnership_changed.v1` carries accepted transitions with
  the B07 `calendarProjection` payload for both stores, using the offer UUID as `aggregateId`.
  Event payloads use IDs, status, revision and schedule only.


## GAP-MKT Café and search links

- `GET /community/cafe-boards` returns `{items:[{clubid,menuid}]}` from the current owner's approved account grant.
- On the owner card press, POST `/approvals` with `{stage:"press",operation:"cafe.post",
  expectedRevision,command}` under the marketing prefix. The revision comes from the
  Café post list's `sourceRevision`. The command is the exact post body. Repeat the
  same request with `stage:"confirm"` and `approvalId` from the first response.
  Use the returned ID for the write within 60 seconds.
- `POST /community/cafe-posts` takes `{clubid,menuid,subject,text}` with a stable `Idempotency-Key: navis:<approvalId>`.
  The gateway forwards this command using its owner workload credential. Use the returned
  `{id,resourceId,receiptId,revision,state,affectedSources,articleId,articleUrl}` to refresh the community feed.
  States are `published`, `rejected` and `pending-reconciliation`. The latter retains the same attempt and receipt
  without repeating an uncertain post. Published IDs are decimal strings and both article fields are null until confirmed.
  The owner's board grant is resolved before the store transaction opens, so no provider or account lookup holds the
  store lock. A replay of a stored key needs no grant. If the grant lookup fails for a new post, the response is
  503 `PROVIDER_UNAVAILABLE` and nothing is reserved (RV-GAP-B-9).
  A confirmed article is always recorded as `published`. The Café API documents `articleUrl` only as the link address,
  with no scheme or host guarantee. An `https://cafe.naver.com` link is kept as returned. Any other value is replaced by
  the display link `https://cafe.naver.com/ca-fe/cafes/{clubid}/articles/{articleId}`. Only a missing or invalid
  `articleId` leaves the post pending.
- `GET /community/cafe-posts?limit=&cursor=` returns the standard list envelope scoped to the publishing owner.
  Each item has `id,receiptId,revision,state,subject,articleId,articleUrl,updatedAt`. Post text and credentials
  stay out of the ledger, logs and outbox. `marketing.cafe_post_published.v1` contains only post ID and revision
  and is committed with the receipt and the community source revision.
- `GET /local-trends` adds `links:{source:"naver-search",use:"display-only",blog,cafearticle}` when a keyword is supplied.
  The two channels independently return `{status,reason?,items:[{title,url}]}`, up to ten HTTPS result links each.
  `reason` appears only with `unavailable`: `not-connected` (no search binding) or `provider-failed` (the call failed).
  Titles are plain text. The server removes every tag (the API highlights matches with `<b>`), decodes HTML entities
  and collapses whitespace (RV-GAP-B-N1). Render titles as text. Keep links distinct from search-interest ratios and POS sales. No scraped content or
  search-history persistence. `search` remains the existing request-window relative index.

Official references are [Café article creation](https://developers.naver.com/docs/login/cafe-api/cafe-api.md),
[API Hub blog search](https://api.ncloud-docs.com/docs/naver-api-hub-search-blog),
[API Hub Café search](https://api.ncloud-docs.com/docs/naver-api-hub-search-cafearticle)
and [API Hub search trends](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend).

### Registration for GAP-MKT

Add the two read suffixes to the Marketing local gateway allowlist. Route the Café POST
and POST `/approvals` through the owner-authenticated marketing gateway target with the
same workload credential as the notice routes. Mount `local.cafe` with `pn17Cafe()`
using the current owner's synthetic account grant. Bind `local.searchInterest` with `pn10SearchInterest()`
and `local.searchLinks` to PN-A2 `search.search(channel,{query,display:10,signal})`, using a bounded
timeout, a per-store scope and the result's `items`. Apply `20261122002001_real_cafe_post.sql`.
