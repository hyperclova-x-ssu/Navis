# GAP-SEED · Reviewed Seoul public data for the café area (D-347 D1, WIDGET_FUNCTIONS §33 #16)

`sangdo-official.json` is the reviewed official snapshot loaded by `../seed.ts` (`seedOfficialLocal`) through
B13's `importOfficialLocalSnapshot` with the marketing migrator. It feeds `/marketing/trade-area` (population bands)
and `/marketing/local-changes` (coverage plus official rows) for the café store `c05409a6-f082-5964-a787-c1ed3184988b`.
There is no runtime collection. The app never calls a public-data portal, and the rows keep their real dates
(they are not shifted to the demo clock).

## Snapshot at a glance

| Field | Value |
| --- | --- |
| Region label | `서울 동작구 상도동` (the café's own address is 서울 동작구 상도동 999-12, at the 숭실대 정문) |
| Coverage 기준일 | `2026-11-19` (latest 데이터갱신일자 in the license files; event list retrieved 2026-11-21) |
| Population bands | 2026-Q3 (2026-07-01 – 2026-09-30, 92 days) and 2026-Q4 (2026-10-01 – 2026-11-17, 48 days), 7 weekdays × 24 hours each, 기준일 = last day used |
| Official rows | 30 food licenses (2026-07-10 – 2026-10-22), 5 events (start 2026-07-29 – 2026-11-04) |
| Retrieved | 2026-11-21 14:42–14:44 UTC. File names, sizes and SHA-256 are in `meta.*.files` |

## Sources, terms and attribution

| Use | Official dataset | Portal page | Provider | Terms |
| --- | --- | --- | --- | --- |
| Trade area · 이동량(추정) | **OA-23016 [내국인] 행정동별 서울 생활인구(250m)**. Monthly files `250_LOCAL_RESD_ADMDONG_2026{07..10}.zip`, plus the dataset's CSV download (recent two months) filtered by 행정동코드 for 2026-11-01 – 11-17 | https://data.seoul.go.kr/dataList/OA-23016/S/1/datasetView.do | 서울특별시 디지털도시국 데이터전략과 (서울특별시·KT 공동 개발) | 별도 이용조건. Statistics and indicators derived by analysis may be used commercially **with the attribution "출처: 서울특별시·KT, 서울시 통신데이터"**. Redistributing or selling all or a substantial part of the raw data, as is or simply converted, is forbidden. Any attempt to identify individuals is forbidden. |
| 행정동 code check | OA-22172 서울시 상권분석서비스(점포-행정동), 2025 file: 11590530 상도1동, 11590540 상도2동, 11590550 상도3동, 11590560 상도4동 | https://data.seoul.go.kr/dataList/OA-22172/S/1/datasetView.do | 서울특별시 | Used only to confirm the code-to-name mapping |
| Local changes · 음식점 인허가 | **OA-18671 서울시 동작구 일반음식점 인허가 정보** and **OA-18696 서울시 동작구 휴게음식점 인허가 정보** (cafés are 휴게음식점) | https://data.seoul.go.kr/dataList/OA-18671/S/1/datasetView.do, https://data.seoul.go.kr/dataList/OA-18696/S/1/datasetView.do | 서울특별시 동작구 (보건소), original system 공공데이터포털 지방행정 인허가정보 | 이용허락범위 제한 없음 |
| Local changes · 행사 | **OA-15486 서울시 문화행사 정보** (Seoul culture portal; each row links its culture.seoul.go.kr page) | https://data.seoul.go.kr/dataList/OA-15486/S/1/datasetView.do | 서울특별시 | 이용허락범위 제한 없음 |

Only derived values are committed: hourly averages for one region and the selected public license and event rows.
The raw files stay outside the repository (see refresh). The required living-population attribution is in
`meta.attribution`. The owner-facing label `서울 공개 자료 · {기준일}` (LOCALES §20) does not contain it. See open question 1.

## How rows are selected

- **Population.** For each date and hour, add the four 상도 행정동 (상도1·2·3·4동), and only when all four are present.
  Average the sums over all dates in the same quarter and ISO weekday, then round to an integer (`estimate`).
  A band is the half-open hour `[startHour, startHour+1)`. Its `referenceDate` is the quarter's last date used.
  `refreshedAt` is the retrieval time. The monthly files and the CSV download agree on all 4,416 overlapping rows
  (`sheetMismatchRows: 0`). This is a living-population estimate (people present in the area at that hour, including
  residents), so values peak overnight in this residential area. It is not a pedestrian or visitor count.
- **Food licenses.** Dongjak-gu rows whose 지번주소 is in 법정동 상도동 or 상도1동, with 인허가일자 on or after 2026-07-01
  and 영업상태 `영업/정상`. Title is `{사업장명} · {일반|휴게}음식점({업태}) · {도로명}`. Phone numbers, areas, staff and
  coordinates are not copied. The authority is `서울특별시 동작구`. The source link is the dataset page.
- **Events.** Dongjak-gu rows from OA-15486 with a start date on or after 2026-07-01 and a venue containing 상도 or 숭실
  (172 Dongjak rows → 5). `referenceDate` is the event start date (`event-date`). The title is `[{분류}] {행사명} · {장소}`.
  The source is the row's culture.seoul.go.kr page.
- IDs are name-based UUIDv5 values from the license 관리번호 or the event cultcode, so a refreshed snapshot updates the
  same rows. Rows whose text contains characters the portal could not encode are skipped (`skippedGarbledRows`, 0 now).

The region uses one label because B13 stores one region per store, and trade-area bands join on that region.
The café's lot number is fictional, so its exact 행정동 cannot be derived. The four 상도 행정동 together are the
상도동 area named by the store address.

## Refresh (manual, reviewed)

```sh
# from backend/services/marketing/reality/13/data, with RAW outside the repository
./fetch-official.sh "$RAW" 202607 202608 202609 202610   # official file and CSV downloads, no login or key
node build-snapshot.mjs "$RAW" sangdo-official.json       # derive and review the diff before committing
```

`fetch-official.sh` posts the same form the portal's file and `CSV 내려받기` buttons submit. It records each file's
`Content-Disposition`, size, SHA-256 and retrieval time in `$RAW/manifest.tsv`. If a portal starts to require an
authentication key, stop and request the key. Do not work around it. In a new quarter, add that quarter's months
so the widget's current quarter has bands. Until then the trade area shows `자료가 없어요` for that quarter.

## Seed hook

`seedOfficialLocal(pool, storeId = café)` runs from the marketing service seed (`services/marketing/seed.ts`,
owned by the composition layer). The hook is in the GAP-SEED report. `npm run seed -- marketing` and `seed-hosted-demo`
both load the same snapshot. Reruns change nothing when the file has not changed.
