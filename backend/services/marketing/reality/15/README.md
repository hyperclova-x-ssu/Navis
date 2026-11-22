# B15 inquiry and notice DTO

The browser calls `/api/v1/stores/:storeId/marketing`. The gateway maps the methods in `noticeReplyRoutes` to `/internal/v1/marketing/stores/:storeId` and supplies the Marketing workload credential and the current authenticated owner context.

## F15 requests and responses

| Method and suffix | Body or query | Result |
| --- | --- | --- |
| GET `/inquiries`, `/notices` | Optional `limit` (1–100), UUID `cursor` | `{items,nextCursor,asOf,sourceRevision,waitingCount}` |
| GET `/inquiries/:id` | — | `{id,type,source,providerRef,title,text,sourceUrl,draft,reply,status,revision,updatedAt,authorNotification?}` |
| POST `/inquiries` | Manual `{title,text,type?,sourceUrl?,source?:"manual"}` or `{source:"review"\|"talktalk",providerRef}` | Receipt |
| PATCH `/inquiries/:id/draft` | `{expectedRevision,text,draftSource?}` | Receipt |
| POST `/inquiries/:id/attestation` | `{expectedRevision,approvalId}` | Owner record from the saved draft |
| POST `/inquiries/:id/reply` | `{expectedRevision,approvalId}` | Provider review reply or consultation acceptance from the saved draft |
| PATCH `/inquiries/:id/reply` | `{expectedRevision,approvalId,text}` | Provider review reply edit |
| DELETE `/inquiries/:id/reply` | `{expectedRevision,approvalId}` | Provider review reply deletion after two confirmations |
| GET `/notices/:id` | — | Draft fields plus `{id,revision,status,result,updatedAt,closureStatus,nextSendWindow,smsEnabled}`, and `smsPreview` for an SMS draft |
| GET `/notice-recipient-groups` | — | `{asOf,items:[{groupId,recipientGroupId\|null,memberCount}]}` for `churn-risk`, `first-visit` and `regular` |
| POST `/notice-recipient-groups` | `{groupId}` | `{recipientGroupId,groupId}`. Idempotent per store and group, so no key is needed. |
| POST `/notices` | Notice draft fields below | Receipt |
| PATCH `/notices/:id/draft` | Notice draft fields and `expectedRevision` | Receipt |
| POST `/notices/:id/attestation` | `{expectedRevision,approvalId}` | Owner record from the saved draft |
| POST `/notices/:id/send` | `{expectedRevision,approvalId,scheduledFor?}` | Existing provider result, or `state:"scheduled"` for SMS (ledger only, no provider call) |
| POST `/notices/:id/cancel-sms` | `{expectedRevision,approvalId}` | `state:"canceled"` after the second card confirmation, while the dispatch is still unclaimed |
| GET `/notices/:id/sms-reservation` | — | `{resourceId,revision,scheduledFor,status,dispatchState,reason,messageType,recipientCount,acceptedCount,failedCount,unknownCount}` from the Marketing ledger |
| DELETE `/notices/:id/draft` | `{expectedRevision,approvalId}` | Deletion with a six-second undo deadline |
| DELETE `/notices/:id/place-news` | `{expectedRevision,approvalId}` | Deletes a news post published through that notice |
| GET `/notice-reply-receipts/:id` | — | Original receipt or `{resourceId,receiptId,state:"pending-reconciliation"}` |
| POST `/notice-reply-receipts/:id/undo` | Empty body or `{}` | Restored draft and new receipt |

Every write takes `Idempotency-Key`. A receipt has `{resourceId,revision,receiptId,state,affectedSources,undoUntil?,reason?}`. Keep the original key after a timeout. A changed payload returns `IDEMPOTENCY_CONFLICT`. An ambiguous provider outcome returns `EFFECT_PENDING_RECONCILIATION` with the reserved receipt ID, and a retry sends nothing. A provider outcome that is known to have changed nothing finishes the attempt as `state:"rejected"` with `reason` and returns 409 with that reason and the receipt ID (RV-GAP-B-5). This covers local validation before any request, a missing binding and a documented refusal (`PROVIDER_INVALID_INPUT`, `PROVIDER_REJECTED`, `PROVIDER_FORBIDDEN`, `PROVIDER_NOT_FOUND`, `PROVIDER_CONFLICT`, `PROVIDER_RATE_LIMITED`, `PROVIDER_NOT_CONFIGURED`, …). The notice keeps its revision and is not locked. The same key replays the rejection, and a new attempt needs a fresh card. Timeouts, `UNKNOWN_OUTCOME` and response-shape violations stay pending. `STALE_REVISION` requires a fresh read and card. Render the original `undoUntil` in both receipt surfaces.

Inquiry statuses are `waiting`, `draft_ready` and `done`. Reply states are `recorded` (owner attestation), `saved` (provider read-back), and `accepted` (TalkTalk provider acknowledgement). Drafts have `{text,source}` with source `owner`, `naver-ai` or `navis`. List `waitingCount` is the full-store count of waiting inquiries and inquiries with a draft, across pages. The corresponding notice count covers all persisted active drafts. Consume the same source revision and count in Marketing Today and Navis facts.

Notice drafts take `{title,text,channel,closure?,startDate?,endDate?,audience?,recipientGroupId?,couponRef?,businessHours?,pin?}`. The channels are `manual`, `sms`, `talktalk`, `place-news`, and `place-hours`.

- A closure link is `{eventId,revision}` from B07. A detail read returns `closureStatus` as `none`, `current`, `changed` or `unavailable`. Saving or confirming a linked notice re-reads the source and rejects `CLOSURE_CHANGED` when it moved or disappeared. Update the closure link in a fresh draft before retry.
- `talktalk` takes exactly one cohort, `benefit-subscribers` or `recent-visitor-reviewers`, and an optional eligible coupon reference. `accepted` means provider acknowledgement. TalkTalk does not offer scheduled sends. The night hint uses the next Seoul calendar day at 08:00, including after midnight.
- `place-news` accepts an optional `pin:{from,to,order}` with at most 45 calendar days, up to five active slots and the start date of the current business day. `place-hours` takes either a B07 closure link or `businessHours:[{day,open,close}]`, with day `mon` through `sun`. Saved marketing receipts do not certify search visibility.
- `sms` requires an opaque `recipientGroupId` from `POST /notice-recipient-groups`. An unknown ID returns 409
  `UNKNOWN_RECIPIENT_GROUP`. `scheduledFor` is a Seoul local minute using `YYYY-MM-DDTHH:mm`.
  From 21:00 until 08:00 Seoul time the only offered time is the next local calendar day's 08:00 (`내일 8시`).
  Times within ten minutes return `SMS_SCHEDULE_TOO_SOON`. Times more than 30 days ahead return `SMS_SCHEDULE_TOO_FAR`
  (bounded horizon, RV-GAP-B-3; the 30-day value is a proposal for R3). Owner-authored notice copy is advertising.
  It requires current SMS advertising consent and a send time within 08:00–21:00 (end exclusive). A6 stays off. Until
  the recipient binding is supplied, the command fails closed with `A6_DISABLED`.
  Both SMS cards use the shared owner-card approval (`sms.schedule`, and `sms.cancel` with confirmation; see
  "Scheduled SMS card approval" below). Typed or spoken text cannot produce either approval.

### Scheduled notice SMS (FIX-GAP-B)

- **Final text (RV-GAP-B-2).** The final text is `(광고) ` + the sender line + `\n` + the owner's text + `\n` + the
  free opt-out line. Coupons use the same frame and lines from `services/marketing/sms-text.ts`. R1 uses the FAKE lines
  `스토어사스 테스트 매장 (연락처: 테스트 전용)` and `무료수신거부 테스트 전용`. A6 must replace them with the verified sender
  and a working free 080 opt-out ([정보통신망법 제50조](https://www.law.go.kr/lsLinkProc.do?chrClsCd=010202&joNo=005000000&lsId=000030)).
  The final text is sent as SMS up to 90 EUC-KR bytes and as LMS up to 2,000 bytes. Anything longer, or a character
  outside EUC-KR, returns 400 `SMS_CONTENT_UNSUPPORTED`. `GET /notices/:id` returns
  `smsPreview:{content,contentType:"AD",type:"SMS"|"LMS"|null,bytes,recipientCount,maxRecipients,sendAllowed,reasons[]}`
  for an SMS draft. The card shows `content` exactly. `reasons` uses `A6_DISABLED`, `SMS_CONTENT_UNSUPPORTED`,
  `SMS_CONSENT_REQUIRED`, `SMS_RECIPIENT_LIMIT` and `RECIPIENTS_UNAVAILABLE`.
- **Ledger, not a provider reservation (RV-GAP-B-3/5/6).** The card press writes one `marketing.notice_sms_dispatch`
  row in the same transaction as the receipt and calls no provider. The notice `result` is
  `{state:"scheduled",providerRef:<dispatchId>,scheduledFor}`. Cancellation is a database change on the unclaimed
  row and needs no provider call, so neither press can leave the notice pending. At the scheduled minute marketing-worker
  claims the row. Marketing then re-checks, right before the send, the 08:00–21:00 window, the linked closure revision
  (B07) and current advertising consent (Customer B05). It returns the current numbers in batches of at most 100 in
  the claim response only. The worker sends each batch through its own PN13 grant and reports each outcome.
- **Outcomes.** A failed re-check finishes the dispatch as `skipped` with `reason` (`CLOSURE_CHANGED`,
  `SMS_CONSENT_REQUIRED`, `SMS_RECIPIENT_LIMIT` or `NOTICE_OUTSIDE_SEND_WINDOW`) and sends nothing. A recipient who
  withdrew consent is dropped. Batch results settle the dispatch as `sent` (any accepted), `failed` (all refused) or
  `uncertain` (any unknown). The notice `result.state` and a new `marketing.message_status_changed.v1` follow.
  `sent` and `uncertain` keep the Calendar entry, and `skipped`, `failed` and `canceled` clear it. An unavailable
  consent or closure source leaves the row `scheduled` and the worker retries. A claim older than two minutes is never
  resent; its unreported batches become `uncertain` for operator reconciliation. On the virtual server, a timed-out
  batch is replayed once with the same attempt key (private idempotent replay). Live SENS has no such lookup.
- **Status read.** `GET /notices/:id/sms-reservation` reads the ledger in the SENS `reserveStatus` vocabulary:
  `READY` (scheduled), `PROCESSING` (claimed or uncertain), `DONE` (sent), `CANCELED`, `SKIP` and `FAIL`. It also
  returns `dispatchState`, `reason` and counts. No numbers or text appear in events, logs or this DTO.
- **Recipient groups.** `recipientGroupId` is an opaque per-store ID for one B19 group (`churn-risk`, `first-visit`,
  `regular`). Membership is classified from the B19 projection when used. Consent and numbers come from Customer B05
  at preview, at the press and at the claim. Marketing stores neither.

The Navis command names and shared arguments stay intact. Map `notice.saveDraft` and `notice.importClosure` to create or patch, `notice.deleteDraft` to delete, `notice.send` to its channel-specific send, `inquiry.saveDraft` to draft patch, and `inquiry.send` or `inquiry.post` to the matching inquiry reply. A draft preview is separate from persistence. F15 and F17 supply the existing owner card path for effects.

### Provider reads

- `GET /reviews?view=venue|booking` returns `{items,averageStars?,authorNotification}`. Booking filters are `product`, `rating` (1–5), `hasReply`, and `sort=use-date`. `GET /reviews/:id` returns one visible review and the author-notification note. Nullable `stars` represents no rating.
- `GET /review-statistics?unit=day|week|month` uses the PN03 period, themes and top keywords. `POST /reviews/:id/draft-preview` takes `{style,length}` and returns `{text,source:"naver-ai"}` through PN03.
  `POST /reviews/:id/navis-draft-preview` takes the same body and returns `{text,source:"navis"}`
  through PN14 HCX-005 on Persona. It uses the scoped review text with contact patterns removed.
  Both endpoints return previews and make no reply or draft record. Save the owner's edited text through the existing inquiry
  draft command with the matching `draftSource` before posting. [NAVER AI draft](https://help.naver.com/service/30026/contents/25102),
  [CLOVA Studio Chat Completions v3](https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3).
- `GET /talktalk/consultations?from=YYYY-MM-DD&to=YYYY-MM-DD&status=...` accepts an optional cursor and a window of at most 31 days. `GET /talktalk/consultations/:id` reads one owner-visible thread. A consultation reference alone does not authorize selecting a reply recipient.
- `GET /talktalk/marketing/audiences` reads allowed cohorts and the month's assigned allowance as `quota: {month, assigned}`. Place campaign consumption is unconfirmed. The notice list and receipt show accepted sends. `GET /place/news` and `GET /place/hours` read publish targets separately.

## Composition registration

- Register `registerNoticeReplyRoutes(app,pool,options)` in Marketing independently of Phase 3. Set `gatewayToken`, the scoped `provider`, and `readClosure` from `createClosureReader` with the owning B07 HTTP client. Use a non-exported workload binding for the B07 call. Configure `verifyApproval` to verify the actual server-authorized owner card, expiry, operation, resource, store, actor, fingerprint and revision. When `secondConfirmation` is true, require proof of both steps. The route fails closed for approval-required commands until that callback is bound.
- Add the explicit allowlist exported by `noticeReplyRoutes` as a `marketing` service target at public prefix `/marketing`, with scoped headers, idempotency header forwarding and a 128-character provider selector limit. The local Compose proof patched only `backend/gateway/app.ts`. Its hunks imported the allowlist, accepted a `marketingRecords:{url,token}` option, destructured that option in `createGateway`, and appended the marketing record target to `recordTargets`. No gateway changes are included in the commit.
- Apply `20261122001500_real_notice_reply.sql` to Marketing. Outbox events `marketing.inquiry_changed.v1` and `marketing.message_status_changed.v1` share the same transaction and per-store sequence with their receipts, and include stable aggregate IDs, revision, status and receipt ID. Notice events include a B07 `calendarProjection` and closure reference. B07 already subscribes; B12 and B19 can re-read the relevant scoped source. No message text, recipients or credentials enter the outbox.
- The boundaries of `createFakeNoticeProvider` describe the PN-A2, PN-A3 and PN-A1 mapping, including distinct PN06 consultation and approved reply-recipient resolution. Bind only the isolated Persona transport to this wrapper. It reports `virtual`. B15 also accepts in-process `fake` fixtures and rejects live providers. Current PN-A2 working signatures differ from the authoritative PN-P2 Persona wire. Refresh those structural signatures after PN-A2 finishes the alignment and run end-to-end Persona verification. The approvals, scope checks and database proof use injected fixtures until composer bindings land.

## Inbound TalkTalk inquiry candidates

Bind PN-A2's private `registerTalkTalkInbound` callback to `createTalkTalkInbox(pool, storeId)` with the separate workload callback token assigned to that store. Use the provisioned store binding for routing. The callback stores text inquiries in the existing `/inquiries` list as `source:"talktalk"`, and acknowledges without a reply. It deduplicates the provider correlation fingerprint within five minutes per store because NAVER supplies no delivery ID.

Migration `20261122002000_real_talktalk_inbox_coupon_approval.sql` links a private pseudonymous recipient to each inquiry. The inquiry uses a generated opaque reference. Only the approved reply command looks up the stored recipient and passes it to `sendReply`, with the existing receipt ID as the attempt key. Candidate creation emits `marketing.inquiry_changed.v1` with the waiting status and revision 1. The event payload omits recipient and message text.

### Registration for GAP-MKT

The new gateway allowlist entries are `POST /reviews/:id/navis-draft-preview`,
`GET /notices/:id/sms-reservation` and `POST /notices/:id/cancel-sms`. Keep the existing
`POST /reviews/:id/draft-preview` and `POST /notices/:id/send`. Pass `navisReviewDraft` and
`scheduledSms` through `createMarketingApp` to `registerNoticeReplyRoutes`. FIX-GAP-B replaced the
PN13 wire in `scheduledSmsProvider` with a recipients-only binding (see below).
Apply `20261122002002_real_sms_reservation.sql`. Existing message status events carry
`scheduled` and `canceled`. A scheduled notice without an effective date projects the
scheduled day to Calendar. Cancellation clears its Calendar entry.

### Scheduled SMS card approval

The owner card issues `POST /approvals` under the marketing prefix with
`{stage:"press",operation,targetRef,expectedRevision,command}`. Use `targetRef`
for the notice ID and `expectedRevision` for the current notice revision.
`sms.schedule` takes `command: {scheduledFor}`; `sms.cancel` takes `command: {}`.
For cancellation, repeat with `stage:"confirm"` and the returned `approvalId`
before calling the existing cancel route. Submit the returned `approvalId` in the
existing send or cancel request within 60 seconds. Retrying an accepted request
with its original idempotency key returns the stored receipt.

`registerNoticeApprovals` registers the shared route on the same gateway workload
credential as the notice routes. Apply `20261122002003_real_card_approval.sql`.
The existing approval issuer still serves other notice and inquiry operations.

### Composition registration (FIX-GAP-B)

These composition hunks are not in this commit. They were not needed for the proof either, because the test wires the same
functions directly (`sms-dispatch.postgres.test.ts`).

1. **Gateway** `gateway/records.ts` `marketingNoticeRoutes`: append `['GET','/notice-recipient-groups']` and
   `['POST','/notice-recipient-groups']`. R1 checkpoint 7 already lists `sms-reservation`, `cancel-sms` and `/approvals`.
   Do not expose `/internal/v1/marketing/notice-sms-dispatch/**` through the gateway.
2. **Marketing** `services/marketing/app.ts`/`index.ts`: pass `scheduledSms: scheduledSmsProvider({mode:'virtual', recipients:
   createNoticeRecipients({pool, senderNumber, readCustomer, clock})})` and `smsWorkerToken` (a new file secret,
   distinct from the gateway token) to `registerNoticeReplyRoutes`. `readCustomer(storeId, body)` POSTs `body` to
   Customer `/internal/v1/customer/stores/{storeId}/sms-recipients` with `authorization: Bearer <marketing SMS-recipient
   token>` and `x-navis-store-id`. `senderNumber` is the registered synthetic sender (`01000000000` on the virtual
   server). `clock` is the store operating clock (default Asia/Seoul, 05:00). Marketing needs **no** PN13 grant or SENS
   credential any more. Remove `pn13.sms.send`, `pn13.sms.reservation-status` and `pn13.sms.reservation-delete`
   from any Marketing grant that the Mac composition added for GAP-MKT (RV-GAP-B-6).
3. **Customer** `services/customer/app.ts`: call `registerSmsRecipientRoute(app, pool, {marketingToken, otherTokens:
   [gatewayToken, posPrivateToken]})` from `reality/05/sms-recipients.ts` with a new file secret shared only with
   Marketing. NetworkPolicy: allow marketing → customer on the service port (already allowed for B07 and B05 reads).
4. **marketing-worker** `workers/marketing-worker/index.ts`: create
   `createNoticeSmsWorker({marketingUrl, token: smsWorkerToken, storeId, sens: noticeSmsWire({storeId, providerAccount,
   virtualOrigin, privateTokenFile, credentialFiles:{sens}}, {sms: serviceId})})` from `notice/sms.ts` and run
   `step()` in the existing poll loop every few seconds. The worker's PN13 grant needs only `pn13.sms.send`, which
   `compose.yaml` already grants. Env: `NAVIS_MARKETING_BASE_URL`, `NAVIS_MARKETING_SMS_WORKER_TOKEN_FILE`.
   NetworkPolicy: allow marketing-worker → marketing on the service port.
5. **Migration** Apply `20261122002004_real_notice_sms_dispatch.sql` after CARD-AUTH's `002003`. It adds
   `notice_recipient_group` and `notice_sms_dispatch` (FORCE RLS, `marketing_run` only; the worker uses HTTP, so
   `marketing_wrk` gets no new grant).
6. **Dockerfile** (RV-GAP-B-1 remains the composition layer's): Marketing no longer imports `workers/**` for SMS limits.
   `services/marketing/sms-text.ts` holds them, and `gap-providers.ts` no longer imports `pn13-sens.ts`. The
   marketing-worker stage still needs `packages/naver/**` for its PN13 wire.
