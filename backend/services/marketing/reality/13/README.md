# R1-B13 marketing local and community HTTP contract

Browser prefix is `/api/v1/stores/:storeId/marketing`. The same suffixes mount privately at
`/internal/v1/marketing/stores/:storeId`. All routes require current owner/workload authorization.
Mutations require the separate trusted card-command credential and `Idempotency-Key` (8–128 ASCII
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
| `/local-trends` | `{from,to,keyword?}` (trimmed keyword, 1–80 chars) | Without a keyword, returns the candidate list, its `sourceRevision` and the daily `ranking`. The older single-keyword read returns the `search` time series. |
| `/local-trends/candidates` | none | `{items,nextCursor:null,asOf,sourceRevision}` with up to 25 `{id,keyword,suggested}` items. |
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

## W20 search growth (D-425)

The first owner read initializes ten candidates once. It combines up to three matching menu terms
with dictionary recommendations and fills any remaining places with the season rule. Saved lists
retain the owner's selections, including an empty list. Removals persist.
`POST /local-trends/candidates` accepts `{keyword}`. `DELETE /local-trends/candidates/:id`
accepts `{expectedRevision,confirmed:true}` and follows the second owner press. Both use
`Idempotency-Key`, return the standard receipt with `affectedSources:['local-trends']` and emit
`marketing.local_trend_candidates_changed.v1` with candidate ID, operation and revision.
Candidate text is normalized, limited to 80 characters and deduplicated without case sensitivity.
Duplicates return `TREND_CANDIDATE_EXISTS` and a full list returns `TREND_CANDIDATE_LIMIT`.
Migration `20261122113200_real_local_search_candidates.sql` creates the scoped list, candidates
and daily cache. `POST /local-trends/preview` accepts `{keywords}` and returns the same measurement
without mutating the candidate list or emitting an event. With an empty `keywords` array and
`useDefaults: true`, the preview also returns `initialKeywords`. The example UI persists its own
starter list and later edits in the browser.

Operating and preview both include `recommendations:{version,source,items}`. The versioned
dictionary includes evergreen and monthly tagged terms. The current month's terms come first in the
rule fallback. The tray excludes tracked terms. The model receives eligible
dictionary entries, menu names, the month and the count of official Dongjak festival records over
the next 14 days where covered. It can select up to eight eligible IDs. HCX-007 uses Structured
Outputs. Set `NAVIS_TREND_HCX_MODEL=HCX-005` for the text JSON path. The service validates both
against the eligible set and returns dictionary entries. An owner press
adds a recommendation through the existing add command. Configure the marketing process with
`NAVIS_TREND_HCX_MODE=live`, `NAVIS_TREND_HCX_STORE_ID` and `NAVIS_TREND_HCX_KEY_FILE` for an
approved store and a mounted CLOVA Studio key. With HCX disabled, unavailable or invalid, the
rules select the suggestions. [CLOVA Studio Structured Outputs](https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3-so)

From the repo root, run the monthly command with the target `YYYY-MM`, then review the dictionary diff.

```sh
node backend/services/marketing/reality/13/data/refresh-trend-dictionary.mjs 2026-12
```

DataLab receives the fixed `아메리카노`, `카페라떼`, `카페` anchor as its first group, plus up to four
candidates per batch. Each batch requests the most recent 35 complete Seoul dates and 57 complete
Monday-start weeks. A chart point is `100 × candidate ratio / anchor ratio` for the corresponding
bucket in that response. Missing buckets and weak anchors are excluded. The change compares the
latest seven dates with the preceding 28. The annual comparison uses the latest four complete weeks
and their equivalents 52 weeks earlier. Complete terms are ranked by the four-week percentage.
Terms within their trailing eight-week variability stay visible with a usual-range label. The seasonal
rise label requires positive recent and year-over-year values plus a comparable rise last year.
The operating cache uses the store,
Seoul day, candidate set, algorithm version and provider mode. Example preview reuses matching caches.

Ranking rows retain `{id,keyword,rank,changePercent,isMenu,menuName,points}` and add `classification`,
`changePoints`, `anchorLevel`, `sameWeekChangePercent` and `noisePoints`. Menu matching ignores
spaces and can use a catalog category for generic terms such as `커피`. The detail shows nationwide
relative trend data and links directly to NAVER search. No search result payload or POS sales is
used in Widget 20. [NAVER Search Trend API](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend)

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


## GAP-MKT Café

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

[Café article creation](https://developers.naver.com/docs/login/cafe-api/cafe-api.md)

### Registration for GAP-MKT

Add the two read suffixes to the Marketing local gateway allowlist. Route the Café POST
and POST `/approvals` through the owner-authenticated marketing gateway target with the
same workload credential as the notice routes. Mount `local.cafe` with `pn17Cafe()`
using the current owner's synthetic account grant. Apply `20261122002001_real_cafe_post.sql`.

## NCP API Hub and Maps (D-377)

Marketing keeps the same owner-authenticated browser routes and widget commands. These reads add
no migration, outbox event or database write. Official changes, Seoul living-population bands and
POS sales still come from their PostgreSQL records.

- **W18** `/local-changes?from=&to=&limit=1&includeNews=1` can return `newsReferences` on the
  first page. `region` comes from the existing coverage record. Publication dates are filtered
  to the requested period in Asia/Seoul. The references are display-only and stay outside
  `items`, `unreadCount`, the widget snapshot and Navis facts.
- **W19** `/trade-area` can return `location:{source:"naver-maps",status,items}` for one
  configured public storefront address. A unique result has `{address,longitude,latitude}`.
  Unavailable or ambiguous results leave the address empty. Location stays separate from
  `population` and `sales`.

Marketing caches up to 128 in-memory results per provider family and coalesces concurrent
identical reads. Search results expire after five minutes, DataLab results after 15 minutes
and coordinates after one hour. Failures use the existing unavailable copy. HTTP 429 also
pauses new reads for that provider family for one minute. Reads never retry automatically.

### Owner setup

1. In the NCP console, select the intended region and platform. Open **All Services → Application
   Services → NAVER API HUB → Application → Application 등록**. Choose **검색 API** and
   **검색어 트렌드**. Select **다음**, name the application and select **완료**. Open that
   application’s authentication information and save its Client ID and Client Secret as
   `NCP_APIHUB_CLIENT_ID` and `NCP_APIHUB_CLIENT_SECRET` under `~/.navis-ncp/secrets/`.
   [API Hub registration](https://api.ncloud-docs.com/docs/naver-api-hub-overview)
2. On **VPC**, open **All Services → Application Services → Maps → Application → Application 등록**.
   Accept the Maps terms if prompted, name the application and select **Geocoding**. Select
   **등록**, then open **인증 정보** for that application. Save its Client ID and Client Secret
   as `NCP_MAPS_CLIENT_ID` and `NCP_MAPS_CLIENT_SECRET` in the same directory.
   [VPC Maps registration](https://guide.ncloud-docs.com/docs/application-maps-app-vpc)
3. For Helm, provision Secret `navis-ncp-apihub` or `navis-ncp-maps` in the `navis` namespace
   with the corresponding two files, using the exact filenames as Secret keys. Confirm
   `config.navisNcpSearchStoreId` and `config.navisNcpMapsStoreAddress` for the approved store.
   Set `config.navisNcpApiHubProvider=live` or `config.navisNcpMapsProvider=live` independently
   during an approved rollout. The chart defaults both to `off`. A service started while
   enabled credentials were missing must be restarted after its complete pair is mounted.
4. For an approved local Compose run, add `compose.ncp-apihub-live.yaml` or
   `compose.ncp-maps-live.yaml` to the base `compose.yaml`. Each override mounts its two files
   read-only. Only the selected Marketing process uses those credentials. Local QA can
   explicitly choose `NAVIS_NCP_APIHUB_PROVIDER=fake` for the existing private fixture ports.

The transport uses the documented HTTPS origins `naverapihub.apigw.ntruss.com` and
`maps.apigw.ntruss.com` with their respective keys, rejects redirects, and never follows
result URLs. Helm adds port 443 and DNS rules for exactly the enabled NCP hostnames.
[API Hub Search](https://api.ncloud-docs.com/docs/naver-api-hub-search-blog) ·
[DataLab](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend) ·
[Maps Geocoding](https://api.ncloud-docs.com/docs/application-maps-geocoding)

After approval, the following command runs at most one call for the selected operation from
`backend`. Replace `trend` with `blog`, `cafearticle`, `local`, `news`, or `geocode`
to check one of those operations. Output contains the HTTP `status` and returned `count`.
`status:0` indicates that no HTTP response was received, including when a credential file is missing.

```sh
node --experimental-transform-types --disable-warning=ExperimentalWarning services/marketing/reality/13/ncp-search-smoke.ts --approve-live trend
```
