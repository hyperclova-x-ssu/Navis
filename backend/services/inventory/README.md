# Inventory catalog handoff for T-305

The gateway receives `GET /api/v1/inventory/catalog?storeId=<UUID>` with the user's access JWT. After verifying it and confirming the current session, store membership and `owner` role with account, call `GET /internal/v1/inventory/catalog?storeId=<UUID>` at `NAVIS_INVENTORY_URL` (`http://inventory:3000` in Compose).

Build these upstream headers from gateway state:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <workload token>` read from `NAVIS_GATEWAY_INVENTORY_TOKEN_FILE` (Compose mounts `/run/secrets/gateway_inventory_token`). |
| `X-Navis-Store-Id` | Store UUID verified by the gateway and account. |
| `X-Navis-Store-Role` | Verified role. Phase ① permits `owner` for the management menu. |
| `X-Request-Id` | The request ID propagated from the edge. |

Strip client-supplied internal scope headers and construct the upstream `Authorization` header with the inventory workload token. Inventory requires the authenticated store UUID to match the query. It returns `Cache-Control: no-store` for all catalog responses and echoes the request ID.

```json
{
  "items": [
    {
      "menuId": "33123a19-6780-4d38-9bca-ce96efcf8561",
      "name": "Synthetic store tea",
      "category": "drink",
      "price": 3100,
      "saleStatus": "sold_out"
    }
  ]
}
```

`menuId` is the DB UUID. Rows are sorted by menu UUID and include active `drink` and `dessert` menus, both `selling` and `sold_out`. Prices are positive integer KRW. A store with zero eligible rows returns `200 { "items": [] }`.

| Internal status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "code": "INVALID_REQUEST" }` | Query requires one `storeId` UUID. |
| `401` | `{ "code": "UNAUTHENTICATED" }` | Missing or invalid workload credential. Treat an upstream credential failure as public `503 SERVICE_UNAVAILABLE`. |
| `403` | `{ "code": "STORE_FORBIDDEN" }` | Missing, invalid or mismatched verified store context, or role other than `owner`. |
| `503` | `{ "code": "SERVICE_UNAVAILABLE" }` | Inventory DB or catalog processing unavailable. |

The gateway handles public `401 UNAUTHENTICATED` and `401 TOKEN_EXPIRED` while validating the user's access JWT and session. Inventory exposes private `/healthz` and `/readyz`. Readiness checks that the runtime role can query the migrated catalog table.

## Local migrate, seed and verify

Run from `backend/` using the local Compose credentials and tools build described in the [backend README](../../README.md).

```sh
docker compose --env-file .env.local -p navis-backend-local run --rm tools npm run migrate -- inventory
docker compose --env-file .env.local -p navis-backend-local run --rm tools npm run seed -- inventory
docker compose --env-file .env.local -p navis-backend-local --profile test up -d --wait test-db
docker compose --env-file .env.local -p navis-backend-local --profile test run --rm tools npm test -- services/inventory/inventory.test.ts
```

The seed uses the SPA manifest for the café (`2026-11-17`) and seeds a second synthetic store with one distinct menu. Account remains authoritative for store access. Inventory's store table keeps only the source store ID, and its inventory-item table holds the IDs needed for same-store retail references. Migrate and seed use the service owner role. Runtime gets `SELECT` on `inventory.menu_item` with forced RLS and a transaction-local `app.store_id`.

For the T-305 synthetic menu mutation smoke, use the inventory migration role in the local inventory DB. On one checked-out client, start a transaction, bind the café UUID via `SELECT set_config('app.store_id', $1, true)` and update `inventory.menu_item` by `store_id` and `menu_id`. Commit before reading through HTTP and restore the original value with a second scoped transaction.

## Phase ② stock and purchase receipts

Inventory stores base and selected-option recipes by version. `saveRecipeVersion` adds a version and advances the current recipe pointer. Current estimates use `readCurrentRecipe`. The stock consumer resolves the versions in the POS event, freezes their ingredient quantities by sale allocation, and deduplicates sales by settlement ID and corrections by correction ID. An eligible cancellation restores the original allocation's quantities. A refund retains them. `stockForItem` calculates opening plus physical movements minus net usage for a store, item, day and channel. It returns integer base quantities as decimal strings.

The seed creates the café's original recipes, the generated cutoff-day opening quantities and a synthetic open milk order line (`33123a19-6780-4d38-9bca-ce96efcf8557`). This fixture consumes newly recognized POS sales during the seeded open day. Historical sales import, day carry and post-close processing require the broader Q5 decisions.

The private receipt route is `POST /internal/v1/inventory/stores/{storeId}/receipts`. Send the inventory workload bearer token, verified owner/store/user headers and `Idempotency-Key`. The body is `{ "polId": "<UUID>", "qty": 3 }`, with `qty` in purchase units. A successful response contains `receiptId` and `qtyRemaining`. An identical retry returns the original receipt and balance. Changed input under the key yields `409 CONFLICT` with reason `IDEMPOTENCY_MISMATCH`.

The receipt command writes the receipt, its base-unit movement and its outbox event in one inventory transaction. The POS worker creates an expense candidate asynchronously using the order-time price and receipt ID. The phase uses positive, integer KRW costs as required by the current POS candidate contract. The stock runner and POS receipt runner use the Phase ② checkpoints and retry behavior from the [Streams handoff](../../relay/README.md).

Run the isolated acceptance from `backend/` after preparing local secrets and the tools image using the backend README.

```sh
node test/compose/phase2-inventory.mjs
```

The acceptance creates and removes its own PostgreSQL and Redis services in `navis-backend-local`. It runs the real relay and consumer handlers with runtime credentials and exercises POS and inventory over private HTTP. Both fixture clocks use `2026-11-17T06:45:00Z`.

To launch the consumers manually against the migrated and seeded local phase ② runtime, build the inventory image, apply the Streams grants, and start Redis and the relay. Run each command in its own terminal. The POS worker uses the POS image and mounts its entrypoint from the workspace.

```sh
docker compose --env-file /dev/null -p navis-backend-local run --rm --no-deps --pull never inventory node services/inventory/stock-worker.ts
docker compose --env-file /dev/null -p navis-backend-local run --rm --no-deps --pull never \
  -v "$PWD/workers/pos-receipts:/app/backend/workers/pos-receipts:ro" pos node workers/pos-receipts/index.ts
```
