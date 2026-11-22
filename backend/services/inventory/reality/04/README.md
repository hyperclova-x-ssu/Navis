# Purchasing HTTP contract

The authenticated owner uses `/api/v1/stores/{storeId}/inventory`. The gateway forwards the bounded owner routes to the Inventory service and supplies the store operating clock. All writes accept `Idempotency-Key`. Reads and receipts use `Cache-Control: no-store`.

| Route | Write body or read behavior |
| --- | --- |
| `GET /suppliers` · `GET /suppliers/:supplierId` | Supplier references, including archived suppliers used to label historical orders. |
| `POST /suppliers` | `{name,contact?,phone?,memo?}`. |
| `PATCH /suppliers/:supplierId` | Changed fields and `expectedRevision`. Empty or null values clear contact, phone, and memo. |
| `DELETE /suppliers/:supplierId` | `{expectedRevision,confirmed:true}`. Active terms or outstanding orders prevent archive. |
| `GET /purchase-items` · `GET /purchase-items/:purchaseItemId` | Current terms for active purchase references. |
| `POST /purchase-items` | `{itemId,supplierId,minimumQty,unitPrice,orderStep,leadDays}`. The ingredient's display unit and exact base factor determine the purchase unit. |
| `PATCH /purchase-items/:purchaseItemId` | Changed `{supplierId,minimumQty,unitPrice,orderStep,leadDays}` fields and `expectedRevision`. |
| `DELETE /purchase-items/:purchaseItemId` | `{expectedRevision,confirmed:true}`. A live recipe reference prevents archive. |
| `GET /purchase-orders` · `GET /purchase-orders/:poId` | Orders and their lines. List accepts optional `from` and `to` on `orderedOn`, with inclusive bounds and a maximum span of 366 days. |
| `POST /purchase-orders` | `{purchaseItemId,qty,dueDate?,suggestionItemId?,confirmDuplicate?,expectedRevision}`. The revision belongs to the purchase item. Default due date is the current business day plus lead days. |
| `PATCH /purchase-orders/:poId` | `{dueDate,expectedRevision}`. |
| `POST /purchase-orders/:poId/cancel` | `{expectedRevision,confirmed:true}`. Canceling a partial order preserves received quantities and their expense candidates. |
| `GET /purchasing/receipts` · `GET /purchase-orders/:poId/receipts` | Paged receiving history. `voidedAt` marks compensated entries. |
| `POST /purchase-orders/:poId/receipts` | `{polId,qty,expectedRevision}`. The revision belongs to the parent order. Quantity is in the immutable purchase unit. |
| `POST /purchasing/receipts/:receiptId/undo` | `{}` within the original six-second window. The same owner, store, and revision are required. The stock revision and effective business day are also checked for receipt undo. |

Lists return `{items,nextCursor,asOf,sourceRevision}`. `limit` is 1–200 and defaults to 100. Reuse the UUID `nextCursor` with the same filters. Supplier contact details belong to owner reads. Use `phoneMask` in preview facts. Orders snapshot the item name, purchase unit and conversion, and unit price at scheduling. Current terms supply today's menu costs. Historical sale and order costs use their stored snapshots.

The following objects show the fields and types returned by the lists. A legacy supplier can have null contact and phone. A legacy order line can have a null item name.

```json
{
  "supplier": {"supplierId":"b6470891-3a53-409e-9983-cce6b7cc0b09","name":"우유 공급사","contact":"담당자","phone":"010-1234-9876","phoneMask":"***-****-9876","memo":null,"archivedAt":null,"deletedAt":null,"revision":1},
  "purchaseItem": {"purchaseItemId":"a642c06a-fd11-4d5b-bce3-289f9c813a8a","itemId":"f80fae3a-a441-41f4-9db4-f94f4176dbb7","supplierId":"b6470891-3a53-409e-9983-cce6b7cc0b09","purchaseUnit":"L","basePerUnit":1000,"minimumQty":1,"orderStep":0.5,"unitPrice":2400,"leadDays":2,"archivedAt":null,"revision":1},
  "purchaseOrder": {"poId":"b7eee625-5fa6-432d-80ae-07d709492571","supplierId":"b6470891-3a53-409e-9983-cce6b7cc0b09","orderedOn":"2026-11-21","dueDate":"2026-11-23","expectedTime":null,"canceledAt":null,"status":"partial","revision":2,"lines":[{"polId":"25fa221f-182f-4f24-8be7-10cae7fc22d2","poId":"b7eee625-5fa6-432d-80ae-07d709492571","itemId":"f80fae3a-a441-41f4-9db4-f94f4176dbb7","itemNameSnapshot":"우유","unitSnapshot":"L","basePerUnit":1000,"unitPrice":2400,"qtyOrdered":3.5,"received":1.5,"remaining":2}]},
  "receipt": {"receiptId":"436ec76c-2f6b-4c54-84c2-6f0ebf3e5a71","poId":"b7eee625-5fa6-432d-80ae-07d709492571","polId":"25fa221f-182f-4f24-8be7-10cae7fc22d2","qty":1.5,"qtyRemaining":2,"receivedAt":"2026-11-21T02:45:00.000Z","voidedAt":null,"businessDate":"2026-11-21","amount":3600}
}
```

Writes return `{resourceId,revision,receiptId,changed,affectedSources,undoUntil?}` and the operation's resource IDs. Order creation adds `poId`, `polId`, `total` and `dueDate`. A partial receipt adds `poId`, `polId`, `qtyRemaining`, `businessDate` and `expenseCandidateReceiptId`. This last field matches the source `receiptId` used to find the POS projection. An exact retry returns the stored receipt. `409 IDEMPOTENCY_MISMATCH` means the key was already committed with different arguments. `409 STALE_REVISION` includes `details.revision`. `409 LIKELY_DUPLICATE_ORDER` allows a separately confirmed retry using `confirmDuplicate:true`. Suggestion orders also recheck current stock, forecast, and absence of outstanding lines inside the inventory transaction.

Inventory commits its original receipt, signed stock movement, order revision, and outbox together. It publishes `inventory.supplier_changed.v1`, `inventory.purchase_order_changed.v1` with `calendarProjection`, and `inventory.receipt_recorded.v1` with `{receiptId,supplierId,businessDate,amount,undoUntil?}`. Order calendar projections preserve the order ID as revisions advance and withdraw completed or canceled orders. Receipt undo records `inventory.receipt_voided.v1` with `{receiptId}`, a compensating stock entry, and the updated order projection.

The POS expense candidate worker deduplicates by `(storeId,receiptId)`. A candidate is available after the Inventory stream is consumed. Booking requires a separate owner action and an active response from the private POS-authenticated `GET /internal/v1/inventory/stores/:storeId/purchase-receipt-status/:receiptId`. Its statuses are `pending`, `active`, and `voided`. The private read shares Inventory's transaction lock with receipt undo. Local scheduling records the order for the owner.
