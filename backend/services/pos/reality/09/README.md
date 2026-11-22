# POS finance API

The owner uses `/api/v1/stores/{storeId}/pos`. The gateway resolves the authenticated store and operating clock. POS reads and writes its own database under store-scoped row-level security. The same read DTOs serve the ledger and margin widgets, the tax review, the closing overlay, and the departure briefing.

## Reads

Pass `businessDate=YYYY-MM-DD` for one day or inclusive `from` and `to` for a period. The maximum gap is 92 days. Reads default to the current operating day. Closing history defaults to all dates. Lists accept `limit` 1–50 and the returned `nextCursor` with the same query. All reads include `asOf` and a numeric `sourceRevision`. An empty list or an empty `days` array means the database read found no matching records. Amounts are integer won.

| Route | Result |
| --- | --- |
| `GET /ledger` | `{from,to,totals,days,hours,asOf,sourceRevision}`. Each daily row includes `businessDate` and the same totals as the full period. Each hourly row includes `businessDate,hour,sales`, with the hour in the store timezone. |
| `GET /deposits` | Original tender and positive return rows. `depositId` identifies the row, `paymentId` identifies the original, `correctionId` identifies a return, and `settlementId` links the settlement. Fields include `businessDate,at,kind,purpose,amount,splits,transactionNo`. Filter via `status=sale\|charge_topup\|receivable_collection\|membership_sale\|custom_order`. Source details reopen through the original POS receipt or the member funding resource. |
| `GET /margins` | Paged `items` plus the period `totals`. Each row has `marginId,kind,menuId,name,recipeVersion,options,unitPrice,unitCost,unitMargin,quantity,sales,discount,refund,cost,knownCost,unknownCostCount,contribution,sourceId,settlementId`. Grouped menu rows preserve sale-time price, option and recipe versions. The two source IDs come from the same representative recognition. For a pickup, `sourceId` is the custom order ID and `menuId` is null. |
| `GET /expenses`, `GET /expenses/:expenseId` | An expense includes `expenseId,businessDate,category,amount,evidence,memo,supplierId,receiptId,status,revision`. The list defaults to confirmed, with `status=canceled` for audit. The optional receipt ID is the original Inventory receipt. |
| `GET /expense-candidates` | The same expense fields plus `undoUntil` from Inventory. The list defaults to pending `candidate` rows, and supports `status=confirmed` or `status=canceled`. A candidate becomes a booked expense only through confirmation. |
| `GET /closings/:businessDate` | `{businessDate,status,revision,totals,drawer,pendingBills,writable,closingId,closedAt,reopenedAt,asOf,sourceRevision}`. `pendingBills` contains open POS bill IDs. A closed day serves its frozen totals and drawer. |
| `GET /closings` | Paged frozen closing entries, including the original snapshot where the day was later reopened. Check `reopenedAt` before treating a snapshot as the currently active close. |

### Shared totals

- `sales = {gross,discount,refund,total,bySource:{menu,customPickup}}`. Menu and redemption sales come from `pos.sales_recognition`; the separate pickup source is recognized on receipt. Prepared-goods refunds reduce revenue and preserve cost. Cancellations use the persisted signed sale-time cost and restore the reported quantity.
- `sales.byMethod = {cash,card,easy_pay,charge,receivable,mixed}` gives net integer won for recognized sales. Ledger exposes it in period `totals` and daily `days[]`. Margin exposes it in period `totals`, including one-day periods. Closing detail and history include it in new snapshots. Snapshots archived before this field was introduced may omit it.
- Each recorded tender portion contributes to its own method, including portions of a mixed sale. `mixed` is the net subtotal for sales originally settled with two or more positive methods, including returns from those sales. It overlaps the method amounts. Returns use the recorded correction splits and member reversals on their recognition business date. Custom pickup contributes only to the pickup sales source. Its tender remains in deposits. If a legacy recognition has missing or partial tender evidence, the five method amounts can sum to less than the recognized sales. Funding, repayment and pass purchases remain in deposits.
- `deposits = {gross,returned,total,byMethod,byMethodGross,byMethodReturned,byPurpose}`. Each method map has `card,easy_pay,cash`. Purpose totals use the settlement purpose. Members' top-ups, repayments and pass purchases are actual tender. Noncash settlements without a payment row still have their recognized revenue. Tenderless corrections stay out of deposits.
- `profit = sales.total - expenses` follows API-278. `cost` and `contribution` are null when any included recognition has unknown cost. `knownCost,unknownCostCount,unknownCostSales` describe coverage. `realPaymentCount` counts original tender rows once, including split-method payments. `orderCount` counts recognized order or pickup IDs.
- `settlementActivity` reports `chargeUsed,receivableCreated,receivableCollected,chargeReversal,receivableReversal` from the member account ledger. The reversal fields are signed changes to their respective balances.
- A closing drawer has `opening,actual,memo,expected,difference,in,out,cashApproved,cashReturned,movements`. Expected cash is opening plus actual cash received, minus cash returned, plus net movements. An uncounted drawer reports null actual and difference.

Tax should use the ledger for recognized sales and the confirmed expenses for evidence rows. The evidence field is the owner-recorded classification. Use the Account attachment API for evidence managed by the tax workflow. Briefing should use the same ledger totals or the frozen closing totals when closed. A refresh after a sale, correction, member funding, expense, or pickup should re-read the affected finance dates. The finance receipts identify `pos.expenses`, `pos.ledger`, `pos.closings`, and `pos.finance`. The F09 port should also subscribe to the POS sale, receipt, correction and relevant purchase and pickup sources.

## Commands

Supply `Idempotency-Key` per logical attempt. Successful writes return `{resourceId,revision,receiptId,affectedSources,undoUntil?}` plus domain IDs. The same actor, arguments and key return the original receipt. A different fingerprint returns `409 IDEMPOTENCY_MISMATCH`. A stale write returns `409 STALE_REVISION`. A locked day returns `409 DAY_CLOSED`.

| Route | Body and effect |
| --- | --- |
| `POST /expenses` | `{date,category,amount,evidence?,memo?,supplierId?,confirmDuplicate?}`. Amount must be positive. Evidence defaults to `receipt`. Use a separately confirmed request with `confirmDuplicate:true` after `409 LIKELY_DUPLICATE_EXPENSE`. Explicit historical dates are allowed when the effective date has no close. |
| `PATCH /expenses/:expenseId` | Changed `date,category,amount,memo` and `expectedRevision`. A purchase-backed expense retains its original receipt amount and business date. |
| `POST /expense-candidates/:expenseId/confirm` | `{expectedRevision}`. Inventory is rechecked before booking. `RECEIPT_PENDING` indicates the receipt undo window is active, `RECEIPT_VOIDED` indicates a reversal, and `RECEIPT_STATUS_UNAVAILABLE` indicates an unavailable authoritative status. |
| `POST /finance/receipts/:receiptId/undo` | `{}`. Requires the same owner, the original six-second deadline, a matching current expense revision, and unlocked days. A repeated command uses its original idempotency key. Bind the Navis undo to the visible receipt and its server deadline. |
| `POST /closings` | `{businessDate,expectedRevision}`. Freezes a snapshot and locks the current day atomically. `409 CLOSING_BLOCKED` lists unpaid bills. |
| `POST /closings/:closingId/reopen` | `{expectedRevision,confirmed:true}`. Reopens the current day after confirmation and retains its previous closing. |
| `PATCH /closings/:businessDate/drawer` | Changed `opening,actual,memo` and `expectedRevision` from the closing read. `actual:null` clears the count. |
| `POST /cash-movements` | `{businessDate,kind,amount,memo?,expectedRevision}`, with `kind=in\|out`. |
| `DELETE /cash-movements/:movementId` | `{expectedRevision,confirmed:true}`. The source movement is preserved with cancellation metadata. |

Expense categories are `ingredients,operations,supplies,labor,rent,other`. Evidence choices are `receipt,tax-invoice,card,none`. Card arguments remain `ledger.recordExpense`, `ledger.updateExpense`, and `ledger.confirmCandidate`. The widget adds HTTP revision metadata. Financial close and drawer actions use the closing widget.

## Producer and consumer contracts

- The B04 worker uses `recordReceiptExpenseCandidate` and `voidReceiptExpenseCandidate` from `pos/expenses.ts` inside its scoped Inbox transaction. The original receipt comes first. Amount zero is valid with a purchase source. Void and duplicate delivery cannot add a booked expense.
- B08 calls `recognizeCustomPickup(tx,{customOrderId,businessDate,name,amount,settlementId?})` inside the owning pickup command, under the same store transaction and business-day lock. It records a single recognition for the custom order at the pickup amount. Record the actual advance or balance in `pos.settlement` with `purpose=custom_order` and `pos.payment`. The helper never creates tender.
- Outbox events are `pos.expense_changed.v1 {expenseId,businessDate,revision,status,previousBusinessDate?}` and `pos.closing_changed.v1 {closingId,businessDate,status,revision}`. Events carry no evidence bytes or memo. Consumers should read using the authenticated source and use `previousBusinessDate` when an edit moves an expense.
- Migrations `20261122000900` through `20261122000902` extend the candidate lifecycle and add expenses, receipt undo, drawer movements, closing history and pickup recognition. Roll back the runtime with data preserved after cutover. The down migrations are for disposable pre-cutover databases.
