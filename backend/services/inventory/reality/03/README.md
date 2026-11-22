# Inventory records

The gateway forwards these routes from `/api/v1/stores/:storeId/inventory` to the inventory service. Requests require the authenticated owner, matching store and a verified workload credential on the internal hop. All writes require `Idempotency-Key`.

| Route | Request and result |
| --- | --- |
| `GET /items` | Filters `kind`, `businessDate`, `limit`, `cursor`. Returns a page with `businessDate` even when empty. |
| `GET /items/:itemId` | Returns an item with current metadata, the requested day's store and online balances, earliest remaining lot expiry and the reference guard. |
| `POST /items` | `{sku,name,unit,stock,threshold,trackRestock?}`. Creates an ingredient and its initial stock record. |
| `PATCH /items/:itemId` | `{expectedRevision,name?,stock?,threshold?,trackRestock?,trackExpiry?}`. A new stock count generates one signed adjustment. |
| `DELETE /items/:itemId` | `{expectedRevision,confirmed:true}`. Archives an ingredient after checking current and archived menu recipes, outstanding purchase lines and lots. |
| `GET /stock-movements` | Filters `itemId`, a single `businessDate` or inclusive `from` and `to` of up to 31 days, `limit`, `cursor`. Returns openings, receipts, sale usage and corrections, adjustments, transfers and waste with source IDs. |
| `GET /stock-batches` | Filters `itemId`, exact `expiresOn`, `limit`, `cursor`. Returns registered quantity, remaining quantity, expiry, registration and discard times, and revision per lot. |
| `POST /stock-batches` | `{itemId,quantity,expiresOn,expectedRevision}`. Designates part of stock already on hand. |
| `POST /stock-batches/:batchId/discard` | `{expectedRevision,confirmed:true}`. Records waste for the lot's remaining quantity in the same transaction. |
| `POST /channel-transfers` | `{itemId,from,to,qty,expectedRevision}`. Transfers whole pieces between two known balances on an existing retail item. |
| `POST /stock/receipts/:receiptId/undo` | `{}`. Applies the inverse of an eligible command for the same owner, day and revision within its original six-second expiry. |
| `GET /forecasts/:targetDate/:modelVersion` | Reads the existing weekday forecast with `ready` or `no_data`. A forecast that predates a B01 catalog change also carries `stale: true`. |

Lists return `{items,nextCursor,asOf,sourceRevision}` and use UUID cursors. Clients sort movement history by timestamps for display. Quantity inputs use the item's display unit. Base quantities in read DTOs are integer strings in g, mL or pcs. The balance fields are `openingQuantityBase`, `usedQuantityBase`, `rawQuantityBase`, `availableQuantityBase` and `deficitQuantityBase`. Missing legacy metadata and a missing stock count are represented as null. Balances carry forward from the most recent opening.

Receipts return `{resourceId,itemId,revision,receiptId,businessDate,changed,affectedSources}` with `undoUntil`, `currentStock` and `adjustmentId` when applicable. Stock edits, channel transfers, item creation and archiving can return undo. Assigning a lot or discarding it is recorded as a distinct command. A conflicting retry returns `409 IDEMPOTENCY_MISMATCH`, and a stale item or lot revision returns `409 STALE_REVISION`. A previously unknown stock count can be established with an explicit measurement.

The POS worker projects sale-time recipes into inventory, consumes lots in expiry order, and restores the original allocated quantities on cancellations. Refunds that keep physical usage leave stock unchanged. Discarded lots remain discarded when a late cancellation restores physical stock. The live catalog and original outbox sequence are read in the same forecast transaction. Forecasts retain their original batch and expose staleness after a later catalog change.

`inventory.stock_changed.v1` commits with a changed stock command or a changed POS usage projection. Its payload is `{storeId,businessDate,sourceId,operation,itemIds}`. Command receipts, settlement IDs and correction IDs identify the corresponding effects. Purchase receipts keep the existing `inventory.receipt_recorded.v1` contract and update the same movement ledger. Their insertion advances the item revision. Forecast generation keeps `inventory.forecast_generated.v1`.

The stock worker runs `node services/inventory/stock-worker.ts` with the dedicated `inventory_wrk` login and the inventory Redis ACL. The database bootstrap must provision `inventory_wrk` before migration `20261122000301_real_stock_worker.sql` and apply the shared checkpoint and inbox grants. The service accepts operating clock headers forwarded by the gateway. On an authorized write it captures that clock for forecasts beyond the latest persisted operating day.
