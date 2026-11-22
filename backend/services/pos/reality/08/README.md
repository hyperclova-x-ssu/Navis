# Custom orders, tender and pickup

Application routes are under `/api/v1/stores/{storeId}/pos`. The operating POS registrar uses the gateway's owner and store guard, trusted operating clock, and store transaction. The UI and Navis use the existing order, template and pickup commands. The complete DTO and consumer contract are in `.evidence/real/B08-custom-dto.md`.

- `/custom-templates` lists and saves order templates. The `generate` action saves an editable example using local rules. Orders retain the original template snapshot.
- `/custom-orders` persists receipts, quotes, decisions and production status. The order revision guards every edit. Quote decisions also bind the business quote revision.
- `/custom-pickups` reads the same pickup rows and accepts reschedule and cancellation. An approval creates or restores one pickup ID per order. Booking can invoke the same POS transition.
- `/custom-orders/:id/{settlement-quote,payments,reversal-quote,corrections}` previews and records cash, a prior terminal receipt, and linked member charge or receivable allocations. Quote tokens bind the store, owner, order revision and effective allocations. Member-value checkout additionally binds the POS member account revision. Provider calls are disabled.
- `/custom-receipts/receipts/:id/undo` checks actor, effect revision and expiry. Templates, pickup moves, advance-paid handover and member-only payments use the same six-second receipt expiry. Handover undo posts the inverse sale value and reopens the pickup. Repeating the handover after undo records its new business day. Member-only payment undo restores the original stage and account amounts with compensating postings.

The B08 migration creates the template, order, history, pickup, undo and pickup adjustment tables in POS with store-scoped foreign keys and forced row-level security. Settlement uses `pos.settlement` with purpose `custom_order` and the full approved order amount. `pos.payment` holds the actual tender amount and splits, when present. The initial handover invokes B09's `recognizeCustomPickup` in the same transaction. A post-handover return adjusts the pickup's recognized revenue by the total returned value and retains its unknown-cost status.

`pos.custom_template_changed.v1` supplies template revision and archive state. `pos.custom_pickup_changed.v1` supplies order stage, a pickup snapshot, and separate pickup and production calendar projections, all keyed by order ID and revision. The event payload contains no contact details, file IDs or terminal references. The command receipt, business updates and outbox writes commit together.

Member references use the B05 private scoped lookup. Reference photos are completed `custom-reference-photo` attachments verified with Account under a distinct POS workload credential.

## B08-2 member-value DTO

- Settlement quotes and payments accept `{kind:'charge'|'receivable',amount}` in the existing `allocations` array. Amounts are positive integer won. The member comes from the order. Method rows keep their original shape and may be combined with either or both member-value kinds. A quote returns normalized allocations and `accountEffects` rows with `{memberId,account,kind:'use'|'sale',amount}`. Charge use is negative and receivable creation is positive. A guest quote yields `MEMBER_REQUIRED`. Insufficient charge yields `CHARGE_BALANCE_EXCEEDED` with `details.available`.
- Use the existing payment fields `quoteId` and `expectedRevision`. A payment funded entirely through member value has `paymentId:null`, `receiptId=settlementId` and `undoUntil`. The undo route accepts `{}` and the standard idempotency header. Recorded cash and terminal returns go through `/corrections` with `confirmed:true`. Use `realMethodReturns` to determine whether a recorded terminal reversal reference is required.
- Reversal previews also return `accountEffects` rows with `{memberId,account,kind:'reversal',amount,originalTxnId}`. A partial refund apportions across the remaining original tender and member amounts. A receivable return that exceeds the uncollected amount on its original posting yields `RECEIVABLE_ALREADY_COLLECTED`. The existing B05 funding correction can reverse the relevant collection first. Order reads expose net `payment.realDeposits`, `payment.chargeApplied` and `payment.receivableAmount`. The latter describes settlement value after refunds and the member account supplies outstanding debt after collection.
- B05's posting contract writes charge use, receivable creation and reversals in `pos.member_account_entry`, with charge top-up sources and original member posting IDs. `pos.member_balance_changed.v1` and the usual `pos.custom_pickup_changed.v1` publish with the command receipt in the same POS transaction.

## B09 finance inputs

Migration `20261122000904_real_custom_order_corrections.sql` links a correction to its original custom settlement. `payment_correction.custom_order_amount` is the total value reversed. `payment_correction.amount` and `methods` carry actual tender returns. Member-only corrections have a zero tender amount and a null payment ID. The member ledger carries the signed posting effects. Pickup recognition and any post-handover adjustment supply the full custom sales effect. The existing B09 deposit, account activity and sales joins cover those records.

Recreate disposable local Compose databases that applied the pre-renumber drafts of the POS custom order or Customer booking migrations.
