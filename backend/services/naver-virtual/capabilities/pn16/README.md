# PN16 Object Storage and Commerce

These Grade W routes emulate public NAVER protocols for the fictional 안숭잘부 카페. The café uses synthetic Commerce records, and the routes run on the private Persona NAVER service. NAVER Commerce wire shapes were checked against the official v2.91.0 OpenAPI payloads served with the referenced operation pages. Those pages publish their schema in the [search](https://apicenter.commerce.naver.com/docs/assets/js/f4cf4821.5ef4bc6f.js), [stock](https://apicenter.commerce.naver.com/docs/assets/js/f8af1945.f5959126.js), [order](https://apicenter.commerce.naver.com/docs/assets/js/0a885a18.ac922661.js) and [token](https://apicenter.commerce.naver.com/docs/assets/js/4b0c401d.d5665274.js) assets. The Commerce error envelope carries `code`, `message`, `timestamp` and `invalidInputs`; 401 uses `UNAUTHORIZED` and 415 uses `UNSUPPORTED_MEDIA_TYPE`. [Official 415 sample](https://apicenter.commerce.naver.com/llms/faq/1665.md)

| Endpoint | Selected wire behavior | Official source |
| --- | --- | --- |
| `PUT /{bucket}/{key}` | SigV4 in `kr-standard`, raw body, private ACL, content headers and user metadata. Optional `Content-MD5` is checked. Success is 200 with a quoted MD5 ETag and an empty body. | [PutObject](https://api.ncloud-docs.com/docs/storage-objectstorage-putobject) · [Metadata](https://guide.ncloud-docs.com/docs/objectstorage-use-file#메타-데이터-변경) |
| `GET /{bucket}/{key}` | Signed byte read, content type and length, ETag, last modification time and stored metadata. Supports a single byte range and documented conditional headers. | [GetObject](https://api.ncloud-docs.com/docs/storage-objectstorage-getobject) |
| `DELETE /{bucket}/{key}` | Signed, scoped delete with idempotent 204. | [DeleteObject](https://api.ncloud-docs.com/docs/storage-objectstorage-deleteobject) |
| `POST /external/v1/oauth2/token` | Form-encoded client credentials and a bcrypt signature. A token is valid for 10,800 seconds. Issuing within 30 minutes of expiry creates a replacement while the previous token remains usable until its expiry. | [Token issue](https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth) · [Signature](https://apicenter.commerce.naver.com/docs/auth) · [Form encoding](https://apicenter.commerce.naver.com/llms/faq/1665.md) |
| `POST /external/v1/products/search` | Bearer scoped to one seller. Supports origin number, channel number, seller code and product status filters with one-based `page` and `size` up to 500. Returns the official paged product and channel shape for the selected fields. | [Product search](https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product) |
| `GET /external/v2/products/origin-products/{originProductNo}` | Returns the seller-scoped origin product including current option stock, price and usability. | [Origin-product read](https://apicenter.commerce.naver.com/docs/commerce-api/current/read-origin-product-product) |
| `PUT /external/v1/products/origin-products/{originProductNo}/option-stock` | Bearer scoped to one seller. Updates existing combination options atomically. The page describes the operation as "상품 옵션의 재고, 가격, 할인가를 변경합니다", so a public request applies the sent `stockQuantity`, `price` and `usable` as given. Its documented responses are 200/308/400/401/403/404/500 and include no 409 (RV-GAP-B-4). An omitted `price` or `usable` takes the parser defaults (0 and true). The 409 for a private Navis request with an idempotency key is the labeled private guard described below the table, not official behavior. The official success body returns the identifiers and `originProduct.detailAttribute.optionInfo.optionCombinations`. | [Option stock](https://apicenter.commerce.naver.com/docs/commerce-api/current/update-options-product) |
| `POST /external/v1/pay-order/seller/product-orders/query` | Bearer scoped to one seller. Accepts up to 300 product-order IDs and returns the scoped matches in `data` with the official `timestamp` and `traceId`. The unreturned IDs can represent missing or unauthorized records. | [Seller order detail](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller) |

For private Navis requests carrying an idempotency key, the virtual adapter returns 409 if the approved price or usability has changed. Public option-stock requests use the supplied values as updates. The official API does not document the private revision guard.

Path-style Storage handles bounded objects up to 16 MiB, matching the largest current Navis artifact. It keeps the supported binary bytes and metadata in PostgreSQL and returns errors as S3 XML. The Commerce fixture covers a SmartStore product with two combination options and two synthetic order statuses. Product group, period and sort selectors, standard options, and product price or discount policy changes are outside this fixture. [Storage common headers and errors](https://api.ncloud-docs.com/docs/storage-objectstorage) · [SigV4](https://api.ncloud-docs.com/docs/common-objectstorageapi-objectstorageapi)

## Provider registration and grants

The foundation discovers the `personaCapability` export from `index.ts`. It applies migration `pn16:001_storage_and_commerce` and calls the seed with the shared deployment instant. Provision `pgcrypto` in the `naver_virtual` database before migrations. The schema can be `naver_virtual` or `public` with role usage. The extension verifies the published bcrypt signature without a new npm dependency.

| Internal callers | Operations | File-mounted grant fields |
| --- | --- | --- |
| Account and marketing worker | `pn16.object.put`, `pn16.object.get`, `pn16.object.delete` | `bucket`, `keyPrefix` (ending in `/`), `accessKeyId`, `secretAccessKey` |
| Inventory and POS | `pn16.commerce.token` | `sellerId` (`ansungjalbu-smartstore`), `clientId`, `clientSecret` (synthetic bcrypt `$2a$` salt) |
| Inventory | `pn16.commerce.products.search`, `pn16.commerce.options.update` | Matching `sellerId` and `clientId` |
| POS | `pn16.commerce.orders.detail` | Matching `sellerId` and `clientId` |

Use separate caller credentials and a bucket or prefix scoped to each workload. The foundation authenticates the private Navis workload and account first. The provider then requires the advertised SigV4 or Commerce credentials and scopes DB access to that account. Commerce tokens are also scoped to the workload, application and seller. Configure the provider through internal DNS with no gateway registration.

The owning Navis adapter keeps card approval, second confirmation for deletion, idempotency and receipt handling at the widget command boundary. It sends the documented provider request after authorization, keeps private bytes server-side, and treats a stock update as acknowledged only when the returned option ID and value match the request. Use seller order detail for the relevant authorized status and omit unused fields from widget and chat facts.

## Verification

Run these commands from the repository root. The isolated proof uses the existing local Node 24 tools image and PostgreSQL 18.6, the only containers on its internal network. It exercises real HTTP and the production registrar, RLS, migration and seed through an independent local Compose project.

```sh
docker compose -p navis-pn16-proof -f backend/services/naver-virtual/capabilities/pn16/compose.test.yaml up --abort-on-container-exit --exit-code-from proof
docker compose -p navis-pn16-proof -f backend/services/naver-virtual/capabilities/pn16/compose.test.yaml down --volumes
```

The proof checks exact 2,200,001-byte storage transfer, metadata, ranges and denial, cross-account isolation, Commerce token scope and expiry, the stock acknowledgement and read-back, bounded order-detail fields, service restart, and D-346 same-generation retry and next-generation refresh.
