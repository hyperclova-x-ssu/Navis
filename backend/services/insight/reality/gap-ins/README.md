# GAP-INS · NAVER virtual-server reads in Insight (WIDGET_FUNCTIONS §33 #3, #8, #10)

Insight exposes three owner-only read routes over the PN-A3 adapter (`services/insight/naver`). The NAVER virtual server (`naver-virtual`) answers them from its PostgreSQL. Real NAVER stays off until A6. Nothing here writes, submits or judges eligibility. Nothing sums channels or attributes sales.

Public paths are `/api/v1/stores/{storeId}` plus the path below. The internal prefix is `/internal/v1/insight/stores/{storeId}`. The routes need the owner role and live membership, and the gateway supplies the operating-clock headers. Every response is `Cache-Control: no-store`.

| Route | Widget | Source |
| --- | --- | --- |
| `GET /insight/financial-center/recommendations` | grants (F11, SCR-223, AC-1585/1609) | PN09 `pn09.financial-center.list` |
| `GET /insight/financial-center/recommendations/:ref` | grants detail | PN09 `pn09.financial-center.read` |
| `GET /insight/review-insights?unit=day\|week\|month&to=YYYY-MM-DD` | ai-response `리뷰 AI 통계` tab (F15, SCR-31, AC-1603) | PN03 `pn03.stats.read` + `pn03.reviews.list` (venue average) |
| `GET /insight/channel-reports/search-ads?date=YYYY-MM-DD&unit=day\|week` | marketing-performance channel cards (F19, SCR-37/39, AC-1612) | PN12 `pn12.ads` (signed Search Ads `/stats`) |

Unknown or repeated query keys, invalid dates, dates after the business day and unknown units return 400 `INVALID_REQUEST`. A missing operating clock returns 503 `STORE_CLOCK_UNAVAILABLE`. A store without a linked provider account is `not-connected` and the provider is not called.

## DTOs

### Financial Center (§33 #8)

The list carries the source label so the widget can show it beside the Bizinfo `/insight/grant-notices` list (`source: 'bizinfo'`):

```json
{ "state": "ready", "source": "naver-financial-center",
  "sourceUrl": "https://help.admin.pay.naver.com/faq/content.help?faqId=13148",
  "items": [{ "ref": "recipe-patent-2026", "source": "naver-financial-center",
    "title": "서울 소상공인 레시피 특허 출원 후속지원",
    "officialNoticeUrl": "https://pms.ripc.org/pms/biz/applicant/notice/info.do?bizYear=2026&noticeSeq=4956",
    "startDate": "2026-09-29", "endDate": "2026-10-08", "status": "closed" }],
  "nextCursor": null, "asOf": "2026-11-17T06:45:00.000Z", "sourceRevision": "4053b439bc0af47d" }
```

`startDate`, `endDate` and `status` appear only when the provider returns them. `status` is only ever `closed`. Its absence does not mean that applications are open. The detail adds `overview`, `eligibility` (the notice's criteria text), `applicationMethod` and the optional `documents`. Show them as read-only notice text with `[공식 공고 열기]` on `officialNoticeUrl`. Never show a "맞는 사업이에요" judgement or an apply button (AC-1585, AC-1609). The owner applies at the institution and can record it through the existing B11 grant-application command. `state: "not-connected"` has empty `items`. A provider failure or Link/selector mismatch returns 503 `NAVER_SOURCE_UNAVAILABLE` (show error and retry). An unknown `ref` returns 404 and an invalid `ref` returns 400.

### Review AI statistics and average rating (§33 #3)

```json
{ "state": "ready", "asOf": "…", "businessDate": "2026-11-17",
  "statistics": { "state": "ready", "source": "naver-review-statistics",
    "sourceUrl": "https://help.naver.com/service/30026/contents/24863?lang=ko",
    "period": { "unit": "week", "from": "2026-11-09", "to": "2026-11-15" },
    "coverage": { "requestedTo": "2026-11-17", "dataThrough": "2026-11-15", "lagDays": 2 },
    "themes": [{ "theme": "메뉴", "positiveCount": 2, "negativeCount": 0 }],
    "topKeywords": { "positive": [{ "keyword": "고소한 라떼", "count": 2, "relatedReviews": [{ "text": "…" }] }], "negative": [] } },
  "averageRating": { "state": "shown", "source": "naver-place-visitor-reviews",
    "sourceUrl": "https://help.naver.com/service/30026/contents/20497?lang=ko", "value": 4.8, "minimumReviewers": 10 } }
```

`period` and `coverage.dataThrough` are what the provider analysed. The provider runs two days behind. Show `이틀 전까지의 자료예요` when `dataThrough < requestedTo` (LOCALES §20). `lagDays` is derived from the two dates. Neutral mentions, sentiment scores and author names are not present. `averageRating.state` is `shown` (value 1–5), `hidden` (the provider withheld it because the display setting is off or fewer than 10 distinct raters) or `unavailable`. Show the average only when `shown`. Per-review stars stay on the B15 `/marketing/reviews` rows. Only the NAVER Place visitor-review source has an official average. Booking reviews have per-review stars only. Each part fails independently (`unavailable`). B15 already exposes the raw `/marketing/review-statistics` and `averageStars` on `/marketing/reviews?view=venue`. This route adds the coverage, the per-source label and the 10-rater state in one read.

### Search Ads card (§33 #10)

The PN12 contract includes Search Ads (`adsFields = impCnt, clkCnt, salesAmt`), so the card is built from it. The envelope and item match marketing `GET /marketing/channel-reports` (`{asOf,businessDate,items:[{channel,state,source,period,cards}]}`), so F19 can append the item to the place/blog/clip items:

```json
{ "asOf": "…", "businessDate": "2026-11-17", "items": [{ "channel": "search-ads", "state": "ready",
  "source": "https://naver.github.io/searchad-apidoc/#/operations/GET/~2Fstats%7B%3Fid,fields,timeRange,datePreset,timeIncrement,breakdown%7D",
  "period": { "startDate": "2026-11-16", "endDate": "2026-11-16" },
  "cards": [{ "metric": "impressions", "value": 105 }, { "metric": "clicks", "value": 11 }, { "metric": "cost", "value": 1150 }] }] }
```

Labels are 노출 수, 클릭 수 and 비용 (광고비). `cost` is Search Ads `salesAmt`, the advertising cost including VAT, and is not sales. `date` defaults to the day before the business day. `unit=week` covers seven days ending at `date`. The server binds the Ads record (campaign) from configuration, and the browser cannot choose it. Absent provider values leave `cards` empty (`아직 알 수 없어요`). States are `ready`, `unavailable` or `not-connected` (no linked store or Ads record). The card has no totals, conversion, inflow or demographic fields and no causal sales wording (D3, AC-1612).

## Official sources

- Financial Center recommendations: [NAVER Pay FAQ 13148](https://help.admin.pay.naver.com/faq/content.help?faqId=13148). The fixture notice is the [institution notice](https://pms.ripc.org/pms/biz/applicant/notice/info.do?bizYear=2026&noticeSeq=4956).
- Review AI statistics and its two-day lag: [SmartPlace help 24863](https://help.naver.com/service/30026/contents/24863?lang=ko). Stars and the 10-rater average: [SmartPlace help 20497](https://help.naver.com/service/30026/contents/20497?lang=ko).
- Search Ads Stat: [searchad-apidoc `/stats`](https://naver.github.io/searchad-apidoc/) and the [`salesAmt` field definition](https://naver.github.io/searchad-apidoc/assets/json/ncc-report.json).

## Composition registration

These files are owned by the composition layer. The hunks below were applied only in the gpu-server proof clone and are not committed on this branch:

1. `services/insight/app.ts`: import `registerNaverInsightReads, type NaverReadOptions` from `./reality/gap-ins/routes.ts`. Add the option `naverReads?: Omit<NaverReadOptions, 'gatewayToken' | 'now'>`. Inside `if (gatewayToken)`, after `registerBriefing(...)`, call `registerNaverInsightReads(routes, { ...naverReads, gatewayToken, now })`.
2. `services/insight/index.ts`: extend the persona bindings, all `GET` and `mode: 'virtual'`. Add `pn03.reviews.list` with `/\/partner-assumed\/v1\/reviews/`, `pn09.financial-center.list` with `/\/partner-assumed\/v1\/financial-center\/recommendations/` and `pn09.financial-center.read` with `…/recommendations\/[A-Za-z0-9_-]{1,64}/`, each at grade `O`. When `NAVIS_INSIGHT_ADS_RECORD` is set, also add `pn12.ads` with `/\/stats/`, grade `W`, `credentialFile: $NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR/nvirtual_ads_key` and `authorize: (_, key) => searchAdsAuthorization(read(nvirtual_ads_customer), read(nvirtual_ads_id), at ? () => at : undefined)(key)`. Reject an invalid record or a missing credentials dir at startup. Pass `naverReads: naver && storeId ? { naver, linkedStores: [storeId], adsRecord } : undefined` to `createInsightApp`.
3. `gateway/records.ts` `insightRecordRoutes`: add `GET` for `/insight/financial-center/recommendations`, `/insight/financial-center/recommendations/:ref`, `/insight/review-insights` and `/insight/channel-reports/search-ads`. The list is exported as `naverInsightRoutes`.
4. `compose.yaml` `insight.environment`: add `NAVIS_INSIGHT_ADS_RECORD: cmp-a001-01-000000000000001`. Helm `insight.yaml` and NKS `base/insight.yaml` already mount `nvirtual_ads_*` into the credentials dir. They need only the same env value (R9).

Notes:

- The persona grant for `insight` in `compose.yaml` already lists these operations and the `pn12.ads` credentials.
- The Ads signature is time-checked (±5 min) against the persona clock. Keep Insight and persona on the same clock: real in hosted runtime (D-346), or pin Insight with `NAVIS_INSIGHT_FIXTURE_NOW` in a fixed-clock local proof. Otherwise the card reads `unavailable`.
- The gateway insight selector `/^[a-z0-9-][a-z0-9.-]{0,79}$/i` rejects `_`, which persona refs allow. The seeded ref has none.

## Verification

- `npx vitest run services/insight/reality/gap-ins --maxWorkers=2` runs through the real PN-A3 adapter and `createNaverTransport` in `fakeOnly` mode, with no sockets.
- Compose proof (one stack, internal network, pinned PostgreSQL 17/Redis images, `ubuntu:22.04` with a mounted Linux Node 22 binary). Set the `GAPINS_*` paths, then run:

  ```sh
  docker compose -f compose.proof.yaml up -d --wait test-db test-redis naver-virtual insight
  docker compose -f compose.proof.yaml --profile proof run --rm proof verify
  docker compose -f compose.proof.yaml restart naver-virtual insight
  docker compose -f compose.proof.yaml --profile proof run --rm proof reread
  docker compose -f compose.proof.yaml --profile proof --profile tests down -v
  ```

  The proof migrates and seeds the real `naver-virtual` entrypoint and runs the real `services/insight/index.ts` with the hunks above. Requests enter the real gateway code with ES256 owner sessions and reach Insight over HTTP. The proof compares each value with the persona DB rows and checks that the B12 briefing `reviewStatistics` equals the weekly statistics. It also checks 401, 403, 404 on POST and the not-connected state for another store. A new session re-reads the same values, the persona `effect_journal` is unchanged (0 writes), and a re-read after restarting both services equals the snapshot. With a fresh `test-db`, `--profile tests run --rm tests --configLoader=runner services/insight` runs the DB-backed Insight suites.
