# F08 — custom orders on the F00 port (REAL-PLAN D-344)

UI → api-gateway → POS service (B08) → its own PostgreSQL DB, re-read after reload or in a new session. Backend contract: `.evidence/real/B08-custom-dto.md`.
FAKE providers only: payments are **recorded** (the store's own terminal slip or cash); no provider is called.

## What this folder holds

| File | Role |
| --- | --- |
| `adapter.ts` / `register.ts` | The `custom` domain: loads templates, orders and pickups, binds every widget/Navis command to its route. Picked up by the F00 eager glob. |
| `dto.ts` | Wire shapes (the existing `CustomTemplate` / `CustomOrderView` / `PickupReservation` plus per-row `revision`) and their projection into `customTemplate`, `customOrder` and `realCustom`. |
| `commands.ts` | `customOrder.recordPayment` and `customOrder.recordCorrection`: HTTP-only widget actions (terminal slip). Not Navis commands. |
| `testing.ts` | In-memory B08 behind `fakeBackend` for the adapter, widget and card tests. |

## Reads and the tables they fill

`GET /pos/custom-templates`, `/pos/custom-orders`, `/pos/custom-pickups` (page size 50, followed by cursor). Table rows are the existing shapes;
`realCustom` holds the pickups and the service's per-order payment view (`selectCustomOrderRead` merges them, so every consumer — widget, calendar
hooks, Navis facts — reads one read model). Money rows stay in the POS ledger (B09); the order read carries only the payment view.

Revision keys for `expectedRevision`: `custom-template:<id>`, `custom-order:<id>`, `custom-pickup:<reservationId>` (= the order's POS revision).

## Commands → routes (names and argument contracts unchanged)

| Command | Request |
| --- | --- |
| `customTemplate.generate` | `POST /pos/custom-templates/generate {productKind,keywords}` |
| `customTemplate.save` | `POST /pos/custom-templates` or `PATCH /pos/custom-templates/:id` |
| `customTemplate.delete` | `DELETE /pos/custom-templates/:id {confirmed:true}` |
| `customOrder.create` / `.update` | `POST /pos/custom-orders`, `PATCH /pos/custom-orders/:id`. Reference photos picked as data URLs are stored once through the account file service (`custom-reference-photo`); the order keeps file ids. |
| `customOrder.quote` / `.recordDecision` / `.setStage` / `.receive` / `.cancel` | `POST /pos/custom-orders/:id/transitions {type,…}` (`receive` and `cancel` send `confirmed:true` — the owner's press or card is the confirmation) |
| `pickup.reschedule` / `pickup.cancel` | `POST /pos/custom-pickups/:id/transitions` |
| `customOrder.recordPayment` | `POST /pos/custom-orders/:id/settlement-quote` (read) then `POST /pos/custom-orders/:id/payments {quoteId,allocations,terminal?}` |
| `customOrder.recordCorrection` | `POST /pos/custom-orders/:id/reversal-quote` (read) then `POST /pos/custom-orders/:id/corrections {quoteId,kind,amount?,confirmed:true,terminal?}` |

Undo: templates, a rescheduled pickup and an advance-paid pickup carry `undoUntil`; the port undoes them at `POST /pos/custom-receipts/receipts/:id/undo`.
Quote, payment and correction receipts have none. Every command is pending until the receipt (nothing is shown as saved before it); an unknown outcome
is resent under the same `Idempotency-Key`.

## Widget (`src/features/widgets/i7-custom`)

On an HTTP build `CustomOrderProvider` swaps the sync port for `createHttpCustomPort` (`execute` waits for the receipt; `dispatch` is shut with `ASYNC_REQUIRED`).
Buttons show pending, a second press is ignored, and an answer after the widget is gone is dropped (`useCustomRun`). `단말 결제 기록` / `단말 취소·환불 기록` open
`real-money.tsx` instead of the simulated terminal of the POS host. The dialog lives at the detail root so it survives the order row changing under it.

## Navis

The card runs the same command: `domains/custom.ts` hands the real port the widget's own command (`realCommand`), so the card waits for the receipt and its
undo is the receipt's, through `applyAgentReceiptUndo` (F17 backlog item (c)). Fixture builds keep the run-level undo.
