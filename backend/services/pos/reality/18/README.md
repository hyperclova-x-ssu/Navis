# POS tax workflow (B18, D-347 replacement 1)

Owner routes live under `/api/v1/stores/{storeId}/pos` (gateway clock: `all`, the same as the B09 finance routes). POS reads and writes its own database under store-scoped FORCE RLS. Navis does not file, pay or look up taxes. The owner opens `홈택스 열기` (`officialLinks.hometax`), pays there, and records the payment here. `납부 완료` is the owner's record of that payment. `증빙 있음` means at least one verified Account file is attached; there is no `example` evidence. `세무사 자료 받기` produces a real CSV or XLSX file from a frozen, verified export.

Amounts are integer won. Dates are `YYYY-MM-DD` in the store's operating day. Every read returns `asOf` and a numeric `sourceRevision`. Lists take `limit` 1–50 (default 30) and the returned `nextCursor`. Commands require `Idempotency-Key`. The same actor, body and key return the stored receipt; a different body with the same key returns `409 IDEMPOTENCY_MISMATCH`. Successful commands return `{resourceId,revision,receiptId,affectedSources,undoUntil?}` plus the fields listed below. A repeated no-op returns `changed:false`, the current revision and `affectedSources: []`. Errors use `{ok:false,code,reason,messageKey,details?}`; map `reason` to copy.

## Tax payments (`tax.createPayment`, `updatePayment`, `deletePayment`, `markPaid`)

`TaxPaymentDto`:

```json
{ "taxPaymentId": "uuid", "type": "원천세(11월분)", "amount": 183000, "dueOn": "2026-12-10", "paidOn": null,
  "status": "unpaid", "overdue": false, "revision": 1, "paidRecordedAt": null,
  "evidence": "none", "evidenceFiles": [],
  "createdAt": "2026-11-17T06:45:00.000Z", "updatedAt": "2026-11-17T06:45:00.000Z" }
```

`status` is `unpaid|paid`. `overdue` is `unpaid` with `dueOn` before today. `evidence` is `attached|none` and maps to the widget's `납부 증빙 있음/없음`. Each `evidenceFiles` item is `{fileId,contentType,size,sha256,attachedAt}`; the bytes stay in Account (`GET /files/{fileId}/content`).

| Route | Body / query | Result and errors |
| --- | --- | --- |
| `GET /tax-payments` | `status=unpaid\|paid`, `dueFrom`, `dueTo`, `cursor`, `limit` | `{items,nextCursor,next,summary,today,asOf,sourceRevision}`. Items are newest due date first (the grid default). `next` is the earliest unpaid record by due date, amount, then ID (`selectNextTaxPayment`). `summary = {unpaidCount,unpaidTotal,overdueCount,dueSoonCount,paidCount,withEvidenceCount}`; `dueSoonCount` counts unpaid records due within 30 days, overdue included (briefing rule). `INVALID_STATUS`, `INVALID_PERIOD`, `INVALID_LIMIT`. |
| `GET /tax-payments/:id` | | `TaxPaymentDto` with `sourceRevision = revision`. `404 TAX_PAYMENT_NOT_FOUND`. |
| `POST /tax-payments` | `{taxType,amount,dueOn,confirmDuplicate?}` | `{...receipt,taxPaymentId,payment,undoUntil}`. `TAX_TYPE_REQUIRED`, `TAX_TYPE_TOO_LONG` (60), `AMOUNT_INVALID`, `DATE_INVALID`. `409 TAX_PAYMENT_EXISTS` with `details {taxPaymentId,type,amount,dueOn,status}` for the same normalized type, amount and due date (the widget's `normalizeName`); resend with `confirmDuplicate:true` and a new key. Past due dates are allowed. |
| `PATCH /tax-payments/:id` | changed `type,amount,dueOn,paidOn,status` + `expectedRevision` | Same patch fields as `tax.updatePayment`. `unpaid` clears `paidOn`; `paid` needs `paidOn`; `paidOn` on an unpaid record without `status:'paid'` is `DATE_INVALID`. `PAID_ON_FUTURE`, `STATUS_INVALID`, `409 STALE_REVISION {revision}`. |
| `POST /tax-payments/:id/paid` | `{expectedRevision,paidOn?}` | `tax.markPaid`: `paidOn` defaults to today. Already paid returns `changed:false`. `PAID_ON_FUTURE`, `STALE_REVISION`. |
| `DELETE /tax-payments/:id` | `{expectedRevision,confirmed:true}` | Soft delete with undo. `CONFIRMATION_REQUIRED`, `STALE_REVISION`. |
| `POST /tax-payments/:id/evidence` | `{fileId,expectedRevision}` | Attach a complete Account file of purpose `tax-evidence` owned by this store (upload first with `POST /files {purpose:'tax-evidence',...}`, `PUT /files/:id/content`, `POST /files/:id/complete`). `404 EVIDENCE_FILE_NOT_FOUND` (missing, pending, revoked, other store or purpose), `503 EVIDENCE_VERIFIER_UNAVAILABLE`, `409 EVIDENCE_LIMIT {max:10}`. An attached file returns `changed:false`. |
| `DELETE /tax-payments/:id/evidence/:fileId` | `{expectedRevision,confirmed:true}` | Detaches; the Account file is kept. `404 EVIDENCE_NOT_ATTACHED`. |

## Review items (`tax.markChecked`)

A review item is a confirmed B09 expense whose owner-recorded evidence is `none`. A check holds for the expense revision that was reviewed; editing the expense makes it `needs-check` again.

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /tax-reviews` | `from`,`to` (inclusive, ≤366 days; default this operating month to today), `status=needs-check\|checked`, `cursor`, `limit` | `{from,to,items,nextCursor,reviewCount,checkedCount,totalCount,asOf,sourceRevision}`. Item: `{refType:'expense',refId,expenseId,date,category,amount,memo,reason:'missing-evidence',status,expenseRevision,reviewRevision,checkedAt}`. `reviewCount` is the widget's `확인할 세무 자료 {n}건`. |
| `POST /tax-reviews/:expenseId/check` | `{expenseRevision}` | `{...receipt,expenseId,item,undoUntil}`. `404 TAX_ITEM_NOT_FOUND`, `409 STALE_REVISION {revision}`. |

## Accountant export (`tax.export`)

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /tax-exports/preview` | `from`,`to` | `{from,to,preview,verification,estimate,connections,officialLinks,asOf,sourceRevision}`. |
| `POST /tax-exports` | `{from,to,expectedSourceRevision?}` | Freezes the verified rows: `{...receipt,exportId,from,to,createdAt,rowCount,preview,verification,sourceRevision,files:{csv,xlsx}}`, each file `{filename,contentType,size,sha256}`. Pass the preview's `sourceRevision`: `409 TAX_EXPORT_PREVIEW_CHANGED {sourceRevision,preview}` when figures changed. `503 TAX_EXPORT_UNVERIFIED {checks}`, `TAX_EXPORT_TOO_LARGE` (20,000 rows), `INVALID_PERIOD`. |
| `GET /tax-exports`, `GET /tax-exports/:id` | `cursor`,`limit` | History and detail with `preview`, `verification` and file hashes. `404 TAX_EXPORT_NOT_FOUND`. |
| `GET /tax-exports/:id/file` | `format=csv\|xlsx` (default csv) | `{exportId,format,filename,contentType,size,sha256,contentBase64}`. The SPA keeps its bearer in memory, so decode to a `Blob` and download; check `sha256`. `INVALID_FORMAT`, `503 TAX_EXPORT_INTEGRITY`. |

`preview = {from,to,sales:{gross,discount,refund,total,bySource},deposits:{total,byMethod},expenses:{total,count,evidenceRecorded,missingEvidence},reviews:{needsCheck,checked},taxPayments:{count,paidTotal,unpaidTotal,withEvidenceFile},cashReceipts:null,rowCount}`. Sales, deposits and expenses come from B09 `readFinance`, so they equal `GET /ledger` for the same period. `cashReceipts` is `null` because POS records no cash-receipt issuance; show it as unavailable, not zero. Widget mapping: `exportPreview.salesTotal = sales.total`, `expenseTotal = expenses.total`, `withEvidence = expenses.evidenceRecorded` (owner classification, not a file), `missingEvidence = expenses.missingEvidence`.

`verification = {status:'verified'|'mismatch',checks:[{check,expected,actual}]}` compares the export rows with the ledger totals for sales, deposits and expenses. `estimate` follows the widget rule and is present only when no review item is open: `{amount,basisDate,salesTotal,deductibleExpenses,assumption:'vat-included-10-percent'}`. `connections` is `[{source:'sales'|'expenses'|'evidence',status:'connected'|'partial'}]`.

The CSV is UTF-8 with BOM and CRLF, columns `구분,날짜,항목,세부,금액(원),증빙,증빙 파일 수,납부일,메모,원천 ID`. Rows: `매출` per day (`순매출`, detail `총매출 · 할인 · 환불`), `입금` per day and method (net of returns), `지출` per confirmed expense, and `세금 납부` per record due or paid in the period. The sum of each kind equals the preview. Owner text starting with `= + - @` is prefixed with `'`. The XLSX has the same `장부` sheet plus a `요약` sheet with the preview totals and verification.

## Undo

`POST /tax/receipts/:receiptId/undo` `{}` reverts a tax payment or review command within the receipt's `undoUntil` (6 s), by the same owner, once, while the resource still has the receipt's revision. `404 RECEIPT_NOT_FOUND`, `409 UNDO_EXPIRED {undoUntil}`, `409 UNDO_UNAVAILABLE`. Undo of a create withdraws the record. Exports are immutable.

## Events and dependent widgets

`pos.tax_due_changed.v1` (aggregate `taxPaymentId`), one per committed revision: `{taxPaymentId,revision,status,dueOn,paidOn,amount,deleted,evidenceCount,calendarProjection:{source:'tax-due',sourceId,revision,entry:{date}|null}}`. `entry` is the due date only while the record is active and unpaid, so the B07 calendar (`tax-admin`) and the briefing tax alert drop it when paid or deleted. Events carry no tax type text, file names or bytes. The existing customer POS consumer (`calendarPosProjectionHandlers`) applies it; the B12 briefing can consume the same event or read `GET /tax-payments` (`summary.dueSoonCount`, `next`).

## Navis impact

Command names and arguments stay as in `agentCommandPolicy`: `tax.createPayment({taxType,amount,dueOn})`, `tax.updatePayment({taxPaymentId,patch})`, `tax.deletePayment({taxPaymentId})` (extra confirmation → `confirmed:true`), `tax.markPaid({taxPaymentId})` (widget-only), `tax.markChecked({refId})` (`refId` = expense ID) and `tax.export({period})` (widget-only, `period → from/to`). The port adds `expectedRevision`/`expenseRevision`/`expectedSourceRevision` from the same DTO and a per-attempt idempotency key. `tax.setEvidence({evidence:'example'})` has no backend equivalent under D-347: evidence is the file attach route on the evidence screen (B17 policy, handed over through B09's `money` adapter). Feed `get_widget(tax)` and facts from `GET /tax-payments` and `GET /tax-exports/preview`, citing the POS source.

## Migration

`20261122001800_real_tax.sql` adds `pos.tax_payment`, `pos.tax_evidence`, `pos.tax_review`, `pos.tax_undo` and `pos.tax_export` with FORCE RLS, composite store keys and column-scoped runtime grants. Down drops them for a disposable pre-cutover database only.

## Composition registration

`REGISTRATION.patch` in this folder holds the composition hunks used for the local proof: POS `app.ts`/`index.ts` (`registerTaxRoutes` on the clock-requiring gateway registrar, `NAVIS_POS_ACCOUNT_URL` and `NAVIS_POS_ACCOUNT_TOKEN_FILE`), Account `files/attachments.ts`, `app.ts`, `index.ts` (`POST /internal/v1/account/stores/:storeId/files/:fileId/evidence-verify {actorId,purpose}` with a distinct POS workload token, 200 `{fileId,purpose,contentType,size,sha256}` or 404), gateway `records.ts` (`taxGatewayRoutes` in `routes.ts`), `compose.yaml` and `infra/local-secrets.sh` (`pos_account_token`). R9 adds the POS → Account NetworkPolicy and secret for W5.

## Local proof

`compose-test.mjs` runs inside the Compose network (`api` and `data`) and proves create → evidence upload/attach → paid → calendar withdrawal → new-session re-read → review check and undo → verified export download, with gateway request IDs and DB rows.
