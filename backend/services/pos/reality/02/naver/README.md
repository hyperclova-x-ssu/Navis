# POS: NAVER orders, Npay settlement and Smart Store status (GAP-POS)

This module closes WIDGET_FUNCTIONS §33 #15 and the POS part of #13 (PRD §14.2 PN02, PN09 and PN16; AC-1602, AC-1609 and AC-1615; SCREENS SCR-248 and SCR-249). The order status tab lists linked NAVER orders. An owner press on [준비 시작] or [픽업 완료] moves an order forward. The tab also shows Npay settlement lines and Smart Store order status, both read-only. Everything runs against the private NAVER virtual server. NAVER, Npay and Commerce receive no outbound calls until A6.

## Routes

The browser prefix is `/api/v1/stores/{storeId}/pos/naver`. The gateway forwards the same suffix to `/internal/v1/pos/stores/{storeId}/naver`. Every route requires the gateway workload credential, the owner role and a matching store. Only the store bound to this deployment's NAVER account (`NAVIS_NAVER_VIRTUAL_STORE_ID`) has these routes. Any other store gets `404 NAVER_NOT_CONNECTED` before a provider call, so the UI hides the NAVER section. Responses are `no-store`.

| Method and suffix | Request | Result |
| --- | --- | --- |
| `GET /orders` | `status?` (`received`, `preparing`, `picked-up`), `cursor?` (last `orderNumber`), `limit?` 1–50, default 30 | `{ items, nextCursor, asOf, sourceRevision, sourceFingerprint, status }`. `status` is `partial` when the provider list reaches its 5,000-row bound. Items are sorted by `orderNumber`. |
| `GET /orders/:orderNumber` | — | One order item. |
| `POST /orders/:orderNumber/prepare` | Header `Idempotency-Key`. Body `{ expectedRevision, preparationMinutes }`. Minutes are a positive 32-bit integer, as in the provider contract. | Receipt |
| `POST /orders/:orderNumber/pickup` | Header `Idempotency-Key`. Body `{ expectedRevision }`. | Receipt |
| `GET /npay/payments/:paymentId` | `page?` (1-based) | Settlement view by payment ID |
| `GET /npay/pay-histories/:payHistId` | `page?` | Settlement view by payment history ID |
| `POST /smartstore/order-statuses` | `{ productOrderIds: string[] }`, 1–300 distinct digit strings. This is a read. It uses POST only because 300 IDs exceed the gateway query bound. | `{ items: [{ productOrderId, productOrderStatus }], unavailable: string[], asOf }` |

An order item contains only `{ orderNumber, source: "naver", status, preparationMinutes, revision, preparingAt, pickedUpAt, actions: { prepare, pickup } }`. `preparingAt` and `pickedUpAt` are the times Navis confirmed the owner's own presses. Progress made on NAVER's own screen leaves them `null`. `actions.prepare` is true only for `received`, and `actions.pickup` only for `preparing`.

A receipt is `{ resourceId, orderNumber, revision, receiptId, status, preparationMinutes, affectedSources: ["pos.naver-orders"] }`. After it arrives, re-read `/orders`. NAVER's order flow only moves forward, so a receipt has no `undoUntil` and the toast has no undo. Show the plain receipt.

A settlement view is `{ lookup: { by, id }, page, items, totals, asOf }`.

- `page` carries the official counters `responseCount` and `currentPage`, plus `totalCount` and `totalPageCount` when the provider returns them on the first page.
- Each item keeps the official fields `paymentId`, `payHistId`, `settleType`, `payDate`, `settleBasisDate`, `settleExpectDate`, `settleCompleteDate`, `paySettleAmount`, `totalCommissionAmount`, `totalPayCommissionAmount` and `settleExpectAmount`. Dates are `YYYYMMDD` and amounts are integer won.
- Each item adds `kind`: `approval` for `정산`, `cancellation` for `정산 후 취소`, otherwise `other`. A cancellation row carries its original approved payment's `paymentId`.
- Each item adds `status`: `settled` when `settleCompleteDate` is a date on or before today in Seoul, otherwise `scheduled`.
- `totals` sums the returned rows. `settledAmount` counts only settled rows. `complete` is true when the first page is the only page.
- The provider's `merchantPayKey` and `productName` are not returned.
- An approved payment with no settlement row returns empty `items`. Do not show it as deposited (I17).

| Status | `reason` | Meaning and client action |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_PREPARATION_TIME` | Fix the input. |
| 404 | `NAVER_NOT_CONNECTED`, `NOT_FOUND`, `ORDER_NOT_FOUND` | Hide the NAVER section, or drop the row. |
| 409 | `STALE_REVISION` (`details.revision`) | Re-read and ask for a fresh press. |
| 409 | `ORDER_TRANSITION` (`details.status`) | The order is no longer in the state for that button. |
| 409 | `ORDER_PROVIDER_PENDING` | Another press on this order is waiting for reconciliation. Retry later. |
| 409 | `ORDER_PROVIDER_RETRY` | The pending press was superseded or expired. Re-read and press again with a new key. |
| 409 | `ORDER_PROVIDER_REFUSED` | NAVER refused the press. Retrying the same key returns the same refusal. |
| 409 | `IDEMPOTENCY_MISMATCH` | The same key was used with a different body or by a different owner. |
| 503 | `NAVER_ORDERS_UNAVAILABLE`, `NPAY_SETTLEMENT_UNAVAILABLE`, `SMARTSTORE_UNAVAILABLE` | Show the error with [다시 시도]. |
| 503 | `ORDER_PROVIDER_OUTCOME_UNKNOWN` | Keep the button pending. Retry with the **same** `Idempotency-Key`. The server re-reads NAVER and settles or resends the same provider key. |

Errors use the POS envelope `{ ok: false, code, reason, messageKey, details? }`.

## Safety and data

- **Writes.** The only writes are prepare and pickup. Each requires the owner's press with a durable `Idempotency-Key` and the order `revision` that the owner saw. Navis chat has no NAVER order command, so typed or spoken text cannot reach these writes. Npay approve and cancel are not bound for this workload, and every Npay and Commerce read is read-only. Top-up, receivable and membership payments stay on the store terminal or cash with a transaction reference (I17).
- **Journal.** Migration `20261122000203_real_naver_order_commands.sql` adds `pos.naver_order_command` with FORCE RLS on `app.store_id`. The journal row is committed before the provider call. Its key is `pos-naver-order:{receiptId}`, so a retry reconciles an uncertain outcome instead of repeating the write. A session advisory lock serializes presses per order across processes. No provider call runs inside a database transaction.
- **Rollback.** The down migration refuses to drop the table while receipts exist. Roll back the application instead.
- **Events.** None. No consumer projects NAVER orders today. Briefing and Navis facts still read only POS bills and orders.

## Composition (composition registration)

- `services/pos/app.ts`: add the option `naverOrders?: PosNaverOptions`. In operating mode, call `registerNaverOrderRoutes(app, pool, { ...naverOrders, gatewayToken, now })`.
- `services/pos/index.ts`: pass `naverOrders: posNaverFromEnv(process.env)` from `./reality/02/naver/runtime.ts`. It returns `undefined` when no NAVER account is configured.
- `gateway/records.ts`: add the seven suffixes above to `posRoutes`.
- `compose.yaml` `pos` environment: set `NAVIS_NAVER_VIRTUAL_ACCOUNT_ID=ansungjalbu-cafe` and `NAVIS_NAVER_VIRTUAL_STORE_ID=c05409a6-f082-5964-a787-c1ed3184988b`. Compose already mounts the virtual-server token, the `nvirtual_pay_{id,secret,chain}` and `nvirtual_pos_commerce_{id,salt}` files and `NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR`. Compose also already grants the virtual-server operations.
- `Dockerfile` target `pos`: copy `services/account/naver/{wire,commerce}.ts` and `packages/naver/`, as the `customer` target does. Without these files the POS image cannot load the PN-A1 POS adapter at all.
- Helm/kustomize (R9): apply the same `pos` environment and secret files.

The runtime binds only `pn02.orders.{list,read,prepare,pickup}`, `pn09.pay.settlement` and `pn16.commerce.{token,orders.detail}`. Credential files are read at send time.

- **Npay settlement** uses the official merchant headers `X-Naver-Client-Id`, `X-Naver-Client-Secret` and `X-NaverPay-Chain-Id`.
- **Commerce orders** use a seller token. The token is issued with `client_secret_sign = base64(bcrypt(clientId_timestamp, clientSecret))` and type `SELF`, cached per store and renewed 30 minutes before its 10,800-second expiry.
- **bcrypt.** The backend has no bcrypt dependency, so `bcrypt.ts` implements the published algorithm. `bcrypt.test.ts` checks it against published vectors and PostgreSQL pgcrypto `crypt()`. An Architect-approved library can replace it behind the same `sign` function. The inventory Commerce adapter needs the same signer.

## Official sources

- Linked-POS orders, preparation and pickup: [payNPos](https://new.smartplace.naver.com/introduction/solution-market/payNPos)
- Per-order preparation time: [SmartPlace help 20628](https://help.naver.com/service/30026/contents/20628?lang=ko&osType=COMMONOS)
- Npay settlement by case and its field table: [settle-by-case](https://docs.pay.naver.com/docs/settlement/settlement-api/settle-by-case/)
- Npay authentication headers: [authentication](https://docs.pay.naver.com/docs/common/authentication)
- Commerce seller order detail: [seller-get-product-orders-pay-order-seller](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller)
- Commerce token: [exchange-sellers-auth](https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth)
- Commerce signature: [auth](https://apicenter.commerce.naver.com/docs/auth)

## Local proof

The proof runs from `backend` on one Compose project with the proof override. Export a unique `NAVIS_LOCAL_VOLUME_SUFFIX` so the database volume is not shared with another project. The override runs the virtual server with the real clock, as deployed. Bring up the db service. Migrate account, inventory and pos. Run `naver-virtual-tools` and then its `seed.ts`. Start `naver-virtual`, `account`, `inventory`, `pos` and `api-gateway` with `--no-deps`. Then run `compose-test.mjs write` in `tools`, restart `pos`, and run `compose-test.mjs reread`. Both proof phases need `NAVIS_GAP_POS_RUN` (12 hex), `NAVIS_GAP_POS_PASSWORD` and `NAVIS_GAP_POS_PRODUCT_ORDER_IDS` from the virtual-server seed.

```sh
docker compose -p navis-gap-pos -f compose.yaml -f services/pos/reality/02/naver/compose.proof.yaml up -d --no-deps --wait naver-virtual account inventory pos api-gateway
```
