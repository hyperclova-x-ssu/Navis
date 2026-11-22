# PN10 Search, Search Trend and Maps

API HUB publishes the search and trend request and response fields. The fixture uses the Developer Center's documented RSS shape and WGS84 integer coordinate examples for the JSON and XML search projections. API HUB confirms XML support and WGS84; the exact cross-product representation is a fixture approximation. [API HUB Local](https://api.ncloud-docs.com/docs/naver-api-hub-search-local) · [Search RSS](https://developers.naver.com/docs/serviceapi/search/local/local.md) · [Coordinate change and example](https://developers.naver.com/notice/article/12567)

The trend fixture returns dates with observations. The official trend guide defines the period and normalized ratio; empty fixture periods are omitted and represent unavailable observations. Date window validation checks valid dates and ordering. [Search Trend](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend)
