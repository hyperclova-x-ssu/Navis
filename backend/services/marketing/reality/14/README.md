# Marketing coupons HTTP contract (B14)

Navis code coupons for widgets 24 `slot-coupon`, 25 `expiry-coupon` and 28 `coupon-status`, POS redemption, and the separate NAVER PN05 coupon lifecycle. Public prefix `/api/v1/stores/{storeId}/marketing` (gateway prefix `/marketing`, clock `all`). Service prefix `/internal/v1/marketing/stores/{storeId}`. The gateway checks current owner membership and forwards the marketing workload token, owner/store IDs, `x-navis-store-timezone` and `x-navis-business-day-start`. Responses are `Cache-Control: no-store`. Errors are `{code,reason,field?,details?}`.

## Coupons

| Method and path | Request → result |
| --- | --- |
| `GET /coupons` | `status=active\|paused\|ended\|running\|all`, `origin=slot\|expiry\|group\|manual`, `lotKey`, `businessDate`, `limit` (1–200, default 50), `cursor`. Returns `{items:[Coupon],nextCursor,asOf,businessDate,sourceRevision}` ordered by end date. |
| `GET /coupons/:id` | One `Coupon`. |
| `GET /coupons/usage?from&to` | `{from,to,issued,activatedCodes,used,reversed,held,discount,asOf,sourceRevision}`. `used`/`discount` are verified POS uses by business date of use. Defaults to the current month to date. |
| `POST /coupons/slot` | `coupon.sendSlot`. `{slots:[{slotId:"slot-YYYY-MM-DD-H",date,startHour,endHour}],benefitId:"free-shot"\|"percent-10"\|"amount-500",recipientIds:[customerId],body?,sendAt?:"YYYY-MM-DDTHH:mm"}`. Live consent is rechecked at commit through Customer. Without `sendAt`, 21:00–08:00 schedules `내일 8시`. Returns `{couponId,codeId,issued,queued,delivery:"queued",scheduledAt,scheduledLocal,night}`. Not undoable. |
| `POST /coupons/expiry` | `coupon.createExpiry`. `{itemId,batchId?,menuId?,route:"place_news"\|"sms",benefit:{kind:"percent"\|"amount"\|"setPrice",value}}` or legacy `discountRate`. The lot must expire on the current business day. Cost/price come from the Inventory menu whose recipe uses the item, and the customer price may not go below unit cost. One coupon per lot and business day. `place_news` returns `{code,post,issueLimit,issued:0,sent:false}`, issue limit min(10, remaining pieces), and is undoable until posted. `sms` queues to consenting members with ≥2 visits in 28 days. |
| `POST /coupon-codes/:id/mark-posted` | `coupon.markPosted` `{}`. Owner attests the public post. Activates the code. Irreversible. |
| `POST /coupon-codes/:id/unpublish` | `coupon.unpublish` `{confirmed:true,expectedRevision?}`. Keeps the issued terms for already shared codes (D-326). Undoable. |
| `PATCH /coupons/:id` | `coupon.update` `{benefitValue?,quantity?,expectedRevision}`. Snapshots activated codes' terms first. Quantity changes the unposted draft or creates a new draft code for future issue. Expiry coupons recheck against the sale-time basis. Undoable. |
| `POST /coupons/:id/{pause,resume,extend}` | `{expectedRevision}`. Extend adds 7 days. Undoable. |
| `POST /coupons/:id/end` | `coupon.endEarly` `{expectedRevision,confirmed:true}`. Snapshots issued terms and ends today. Undoable. |
| `POST /coupons/:id/notify-ending` | `coupon.notifyEnding` `{}`. Active coupons ending within 3 days. Queues reminders only to targets who still consent at commit. |
| `POST /coupons/receipts/:id/undo` | `{}`. Same actor, before `undoUntil` (6 s), refused if any touched row changed or a code was posted or redeemed. |

Commands require `Idempotency-Key`. Same key and body return the stored receipt. A different body returns `409 IDEMPOTENCY_MISMATCH`. Receipt `{resourceId,revision,receiptId,changed,affectedSources,undoUntil?,...}`. `affectedSources` are `slot-coupon, expiry-coupon, coupon-status, marketing-today, marketing-performance`. Domain errors include `STALE_REVISION` (`details.revision`), `ALREADY_DONE`, `COUPON_NOT_ACTIVE`, `EXPIRY_ALREADY_MADE`, `NO_EXPIRY_STOCK`, `LOT_EXPIRED`, `NOT_EXPIRING_TODAY`, `MENU_REQUIRED`, `OVER_LIMIT`, `COST_UNKNOWN`, `PERCENT_RANGE`, `AMOUNT_RANGE`, `SET_PRICE_RANGE`, `OVER_PRICE`, `SLOT_ALREADY_HANDLED`, `SLOT_PAST`, `NO_CONSENT`, `RECIPIENT_NOT_FOUND`, `NO_RECIPIENTS`, `NOT_ENDING_SOON`, `NO_REMINDER_RECIPIENTS`, `EXTRA_CONFIRMATION_REQUIRED`, and 503 `CUSTOMER_UNAVAILABLE`/`INVENTORY_UNAVAILABLE`.

```ts
type Coupon = {
  couponId: string; origin: 'slot'|'expiry'|'group'|'manual'; name: string;   // fixed Korean label
  benefitType: 'free_item'|'percent'|'amount'|'set_price'; benefitValue: number;
  benefit: { kind: 'percent'|'amount'|'setPrice'; value: number } | null;      // null for a free item
  targetRef: string | null;            // menu UUID, 'opt-extra-shot', or null for the whole bill
  validHours: { weekday: 1..7; startHour: number; endHour: number }[] | null;
  startsOn: string; endsOn: string; status: 'active'|'paused'|'ended'; storedStatus: string;
  daysLeft: number; endingSoon: boolean; originRef: { slotIds?, benefitId?, itemId?, batchId?, menuId?, menuName? };
  basis: { price, unitCost, maxRatePercent, menuRevision, lotExpiresOn, lotRemainingBase, unit, economics } | null;
  futureIssueCount: number | null; businessDate: string; createdAt: string;
  issued: number; used: number; discountSum: number;                          // used = committed POS uses
  reminderTargets: number; remindersQueued: number; messagesQueued: number;
  canPause: boolean; canResume: boolean; canExtend: boolean; canEnd: boolean; canNotify: boolean;
  codes: { codeId; code; route: 'sms'|'place_news'|'blog'|'clip'; issueCount; activated; activatedAt; unpublished; unpublishedAt;
    issuedTerms: { benefitType; benefitValue; targetRef; endsOn } | null; used; held; discountSum; remaining; eligible; revision }[];
  revision: number;
};
```

Navis adapter fields (`server/navis/coupons.mjs`, unchanged): coupon `status`, `endingSoon`, `reminderRecipients` ← `reminderTargets` (consent rechecked at commit); code `route`, `activated`, `unpublished`, `eligible`; expiry stock `expiryHandled` ← a coupon exists for `lotKey` on the business day, `expiryEligible` ← lot expires today and menu cost is known; slot `handled` ← a non-ended slot coupon lists the `slotId`.

## POS redemption

| Method and path | Request → result |
| --- | --- |
| `POST /coupon-redemptions/quote` | `{code,lines:[{lineId,menuId,gross,basePrice,options:[{optionId,extraPrice}]}],customerId?}` → `{codeId,couponId,couponName,route,discount,scope:{kind,targetLineIds},terms,remaining}`. No write. Use before creating the POS bill. |
| `POST /coupon-redemptions` | `Idempotency-Key`. `{code,billId,customerId?,commandKey?}`. Marketing reads the open POS bill. Its whole-bill `discount` must equal the coupon discount computed from the bill's own quote lines. Holds one use (`state:"held"`, `holdUntil` +10 min). 201 `{resourceId,revision,receiptId,changed,affectedSources,redemption}`. |
| `GET /coupon-redemptions` · `GET /coupon-redemptions/:id` | Page (`codeId`, `couponId`, `limit`, `cursor`) or one `{redemptionId,codeId,couponId,billId,customerId,discount,scope,terms,businessDate,state,heldAt,holdUntil,sale,committedAt,releaseReason,releasedAt,correctionId,reversedAt,revision}`. |
| `POST /coupon-redemptions/:id/reconcile` | `{}`. Reads the bill: paid with the discount → `committed` with `sale`, paid without it → `released`/`rejected`, void → `released`/`aborted`, open → 202 `held`. |
| `POST /coupon-redemptions/:id/release` | `{confirmed:true}`. Removes the coupon from an unpaid bill (`owner_released`). A paid bill is reconciled instead (`409 ALREADY_REDEEMED`). |

Redeem errors: `COUPON_CODE_NOT_FOUND`, `COUPON_CODE_INVALID`, `COUPON_CODE_INACTIVE` (unposted), `COUPON_PAUSED`, `COUPON_ENDED`, `COUPON_HOURS`, `COUPON_MENU_REQUIRED`, `COUPON_SHOT_REQUIRED`, `COUPON_MEMBER_REQUIRED` (SMS codes only for their targets), `COUPON_EXHAUSTED` (held + committed ≥ issue count), `COUPON_INVALID_BENEFIT`, `BILL_NOT_FOUND`, `BILL_NOT_OPEN`, `BILL_DISCOUNT_MISMATCH` (`details.couponDiscount`, `billDiscount`), `BILL_ALREADY_HAS_COUPON`, 503 `POS_UNAVAILABLE`. A code ended early or unpublished still redeems under its `issuedTerms` until the original end date (D-326). Paused coupons do not redeem.

POS flow for F02/F14: quote → `POST /pos/bills {type,lines,discount}` → claim with `billId` → `POST /pos/bills/:id/payments` → reconcile (or the sale event). `couponPosHandlers` consumes `pos.sale_recognized.v1` (held claim on that bill → committed) and `pos.sale_corrected.v1` `kind:"cancel"` (committed use → `reversed`, so performance counts verified uses only). POS refuses partial cancellation of a discounted bill (I-17).

## NAVER coupons (PN05, separate class)

`GET /naver-coupons` (`placeCursor`, `promotionCursor`) returns `{placeCoupons,orderPromotions,membership,source:"naver",sourceRevision,asOf}`. `GET /naver-coupons/place/:ref/issues` reads masked issues. Writes take `Idempotency-Key` and an owner card. The registrar enables PN05 writes only with the explicitly configured fake mode.

- `POST /naver-coupons/place` uses `{type,name,audience,benefit,displayPeriod?,quantity?,conditions?}`. Audience is `all`, `benefit-subscribers` or `marketing-message`. Benefit is `{type:'amount'|'percent',value}` or `{type:'gift',item}`. Display period is `{from,to}`. Marketing-message coupons omit display period and quantity. NAVER booking/order coupons cover the whole product class (I13).
- `POST /naver-coupons/promotions` uses `{name,from,to,orderAmountPerStamp,coupons,instructions?}`. Each coupon uses `{stampCount,name,validDays,canCombine,canUseAlone,instructions?}`.
- `DELETE /naver-coupons/place/:ref` and `POST /naver-coupons/promotions/:ref/end` take `{confirmed:true}`. Existing downloads stay valid after a Place coupon deletion. `PATCH /naver-coupons/issues/:ref/usage` keeps `{status:'used'|'unused'}` and forwards `{used:boolean}`. `POST /naver-coupons/promotions/:ref/extend` keeps `{endDate}` and forwards `{to}`.

On the authenticated owner card press, POST `/naver-coupon-approvals` with `{stage:"press",operation,targetRef?,expectedRevision,command}`. Use `sourceRevision` for `expectedRevision` and the original route body for `command`. The operation is one of `place.create`, `place.delete`, `issue.usage`, `promotion.create`, `promotion.extend`, `promotion.end`. Omit `targetRef` for creates. The server returns `{approvalId,expiresAt,requiresConfirmation}`. For delete or end, wait for the second press and send the same request with `stage:"confirm"` and the returned `approvalId`. Add `approvalId` and `expectedRevision` to the original write body.

The server expires approvals after 60 seconds. It consumes the approval in the same transaction that reserves the `naver_coupon_action` row, and then calls the fake provider. A duplicate request with the same key returns the stored result. An uncertain outcome stays pending (202). A duplicate pending request reads its status and the store's next PN05 write waits for reconciliation. Applied actions advance the store's PN05 source revision. A provider refusal returns `422 NAVER_REJECTED`. An unbound PN05 port returns `503 NAVER_COUPONS_UNAVAILABLE` with `details.officialUrl`. NAVER membership is read-only and coupon controls live in the membership provider's console.

## Records and events

Migration `20261122001400_real_coupons.sql` adds `coupon`, `coupon_code`, `coupon_message`, `coupon_target`, `coupon_reminder`, `coupon_redemption`, `coupon_command`, `coupon_revision` and `naver_coupon_action`, all FORCE RLS on `app.store_id` with column-level runtime grants. Rollback keeps the schema once rows exist. Events share the marketing outbox and store sequence: `marketing.coupon_code_changed.v1` `{codeId,couponId,code,route,issueCount,revision,operation:issued|activated|unpublished|terms_preserved|redeemed|released|reversed,...}` and `marketing.message_queued.v1` `{couponId,codeId?|reminderId?,kind,count,scheduledAt}`. Events carry no phone numbers or message bodies. A6 is off, so messages stay `queued`. The approved SENS worker sends and records acceptance and delivery separately. The outbox aggregate for a repeated change is a stable UUID derived from the resource ID and revision.

### Korean advertising SMS

Coupon and reminder queue bodies start with \`(광고)\`, identify the sender, and end with a \`무료수신거부\` line. R1 queue bodies use synthetic sender and opt-out placeholders for FAKE verification. A6 requires verified sender name and contact details and a working, free opt-out before delivery. Explicit local \`sendAt\` values from 21:00 inclusive to 08:00 exclusive return \`NIGHT_SEND_NOT_ALLOWED\`. The default scheduling path defers to 08:00 during those hours under D-331. [KISA guidance](https://spam.kisa.or.kr/spam/na/ntt/selectNttInfo.do?bbsId=1002&mi=1020&nttSn=3001) · [정보통신망법 제50조 제3·4·6항](https://www.law.go.kr/lsLinkProc.do?chrClsCd=010202&joNo=005000000&lsId=000030) · [시행령 별표 6](https://law.go.kr/LSW/flDownload.do?flSeq=162427345)
