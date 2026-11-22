# R1-B11 manuals, checklists and grants

Routes are owner-scoped under `/api/v1/stores/{storeId}/insight`. The gateway supplies live membership and the account operating clock. Register the service via `registerManualsGrants` and use `manualsGrantsRoutes` as the explicit allowlist. The internal prefix is `/internal/v1/insight/stores/{storeId}/insight`.

## DTO for F11

Lists return `{ items, nextCursor, asOf, sourceRevision }`. Use `limit` (1–100) and the returned cursor. Checklist list filters accept `manualId`, `from`, and `to` (inclusive ISO business dates). Items carry `id`, `revision`, and `updatedAt`. All collections provide detail `/:id` and revision history `/:id/history`.

| Collection | Item fields | Write |
| --- | --- | --- |
| `/manuals` | `section, title, category, body, cautions, steps[{body,photoKey?}], checklist, isPublished, checklistVersion` | POST the editable fields and optional `confirmDuplicate`. PATCH `/:id` with `{patch,expectedRevision}`. POST `/:id/publish` with `{published,expectedRevision,confirmed?}`. |
| `/manual-drafts` | `memo, section, title, category, body, cautions, steps[{body,photoKey?}], status` | POST `{memo,section?,cautions?}`. POST `/:id/save` with `{expectedRevision,...edits}` to publish a new manual and archive the draft atomically. |
| `/checklists` | `manualId, manualRevision, businessDay, category, checkedSteps, totalSteps` | POST `{manualId,stepNo,checked,expectedRevision,expectedChecklistRevision?,businessDay?}`. `expectedRevision` refers to the manual record. Send explicit desired state. |
| `/grant-notices` | `noticeId, providerId, source, sourceMode, sourceUpdatedAt, officialUrl, title, agency, summary, target, applicationMethod, startsOn, deadline, tags, region, industry, reviewStatus, matchStatus` | POST `/sync` with `{region,industry}`. POST `/:id/review` with `{expectedRevision}`. |
| `/grant-applications` | `noticeId, title, appliedOn, status, receiptNumber, resultMemo, source` | POST `{noticeId,appliedOn?,status?,receiptNumber?,resultMemo?}`. PATCH `/:id` with `{expectedRevision,status?,receiptNumber?,resultMemo?}`. |

DELETE manual, draft or application with `{expectedRevision,confirmed:true}`. Unpublish also requires `confirmed:true`. All writes need `Idempotency-Key` and return `{resourceId,revision,receiptId,changed,affectedSources,undoUntil?}`. Use the receipt ID and the same displayed expiry for POST `/receipts/:id/undo` with `{}`. Map `STALE_REVISION` to a fresh read and confirmation. Draft save returns the new manual ID. Checklist `manualRevision` maps to the manual's `checklistVersion`, so publish/unpublish and changes to unrelated fields preserve that day's progress. New step definitions get separate progress. Apply records an owner's external submission or outcome. Use `officialUrl` for the original notice and source fields when preparing copyable application text.

## Dependent reads and events

`GET /manuals-grants-briefing` exposes `{openingChecked,openingSteps,upcomingGrantDeadlines,businessDay,asOf,sourceRevision}`. Show the opening checklist task when `openingSteps > openingChecked`. Counts use current published definitions and the scoped operating day.

Migration `20261122001100_real_manuals_grants.sql` requires B10's `20261122001000` for the shared Insight outbox and sequence. Writes atomically commit the affected records, history, receipt and events. `insight.manual_check_changed.v1` invalidates the manuals, checklist and briefing sources. `insight.grant_review_changed.v1` carries an optional B07 `calendarProjection` for notice changes. Application notes, attachment references and receipt numbers stay out of event payloads.

## Provider and attachment registration

The default provider reads a local JSON fixture adapted from the published Bizinfo response example. Its matching tags are test data. The provider uses explicit exact region and industry tags as evidence of a match. The original notice remains the source for eligibility. Live access requires `NAVIS_BIZINFO_MODE=live`, `NAVIS_BIZINFO_A6_APPROVED=1`, `NAVIS_BIZINFO_TERMS_ACCEPTED=1`, and `NAVIS_BIZINFO_KEY_FILE` when the composer uses `configureBizinfo(process.env)`. The client only reads notices from Bizinfo's official API. [Bizinfo API documentation](https://www.bizinfo.go.kr/apiDetail.do?id=bizinfoApi)

Manual step photos take completed account file UUIDs. Supply `verifyPhoto` from the account service workload client and check store, owner, completed file state, `manual-evidence` purpose and image content type. Until that route is registered, photo writes return `FILE_VERIFICATION_UNAVAILABLE`.
