# Daily inventory forecast

Run `node workers/forecast-cron/index.ts` once per configured store. Local Compose invokes the worker on demand. Set `NAVIS_FORECAST_FIXTURE_NOW` to the pinned café instant in ISO 8601 for a reproducible run. Inventory resolves that instant using the store's effective business-day start and end.

| Variable | Use |
| --- | --- |
| `NAVIS_FORECAST_STORE_ID` | Store UUID for this run |
| `NAVIS_INSIGHT_BASE_URL` | Private Insight service origin |
| `NAVIS_INVENTORY_BASE_URL` | Private inventory service origin |
| `NAVIS_FORECAST_INSIGHT_TOKEN_FILE` | Workload token mount used by the worker and Insight |
| `NAVIS_FORECAST_INVENTORY_TOKEN_FILE` | Distinct workload token mount used by the worker and inventory |
| `NAVIS_FORECAST_FIXTURE_NOW` | Optional fixed instant for the local fixture |

The `weekday-4w-v1` model averages net recognized menu quantities from the previous four matching weekdays. Insight replay accounts for eligible cancellations. Prepared-goods refunds preserve quantities. A fully canceled observed day contributes zero. An absent comparable day yields `no_data` (자료 없음) and leaves the key available for a later run.

Inventory projects currently selling menus and multiplies their estimates by their current base recipes, then sums the quantities per ingredient. Insight's sales read aggregates by menu, so it supplies no option mix. This model uses daily quantities and no weather or event adjustments. Ingredient forecasts are expected usage in the item's base unit. Stock and receipts continue to determine availability through the stock projection, which uses sale-time recipe versions for recognized usage.

## Private HTTP and event contract

Every request includes a bearer credential for its destination and the matching `x-navis-store-id`. Inventory's private paths start at `/internal/v1/inventory/stores/:storeId`.

- `GET /forecast-business-day?at=<UTC ISO timestamp>` is workload-only and returns `{ targetDate }`, with `null` for a missing calendar entry.
- `PUT /forecasts/:targetDate/:modelVersion` is workload-only. Its body is `{ menus: [{ menuId, fourWeekQuantity }] }`. Send the exact sum for each menu as a decimal integer string. Inventory divides by four, calculates ingredient usage, and writes the result rows and outbox events together. The resource key handles identical concurrent or sequential retries. A different baseline for an existing key returns `409 IDEMPOTENCY_MISMATCH`.
- `GET /forecasts/:targetDate/:modelVersion` accepts the forecast workload or verified gateway owner context. It returns `{ targetDate, modelVersion, status, results }`. Each ready result has `scope` (`store`, `menu` or `ingredient`), `targetId` (`null` for the store total), and `expected` (a decimal string). A missing result has `status: "no_data"` and an empty list.
- `inventory.forecast_generated.v1` carries `{ storeId, targetDate, modelVersion, scope, targetId }`. Its aggregate ID identifies one persisted forecast row.

## Local verification

With the existing local tools image and synthetic test credentials provisioned, run `node workers/forecast-cron/compose-test.mjs` from `backend/`. The harness starts a disposable test-only PostgreSQL instance and Redis on an internal Compose network, and removes those test containers on exit. Append `typecheck` or `suite` to run the backend checks with the same source mounts.
