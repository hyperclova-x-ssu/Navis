# Persona NAVER PN13–PN15

These private provider routes serve the fictional 안숭잘부 카페 with assumed owner approvals. All three capabilities use grade W and the published provider wire. Register the three capability modules through the persona foundation. The Navis domain adapters retain approval, consent and durable attempt ownership. The provider receives synthetic requests using private workload and account headers plus each product's official authentication headers.

| Product | Routes and fields | Official references |
| --- | --- | --- |
| PN13 SMS and LMS | `POST/GET /sms/v2/services/{serviceId}/messages` and `GET .../messages/{messageId}`. Acceptance is HTTP 202 with `requestId`, `requestTime`, `statusCode` and `statusName`. Result lookup uses `messageId`, per-recipient state, completion time and carrier code. The send reference documents truncation above the 90-byte SMS and 2,000-byte LMS EUC-KR limits. Persona approximates the byte count using one byte for ASCII and two for supported non-ASCII characters, then truncates at a character boundary. The Navis SMS path uses its own 80-byte limit. | [Send](https://api.ncloud-docs.com/docs/sens-sms-send) · [List](https://api.ncloud-docs.com/docs/sens-sms-list) · [Result](https://api.ncloud-docs.com/docs/sens-sms-get) |
| PN13 AlimTalk and Brand Message | The same methods under `/alimtalk/v2/services/{serviceId}/messages` and `/brandmessage/v2/services/{serviceId}/messages`. AlimTalk uses one approved informational text template. Brand Message uses free-form or registered template text with the synthetic consent and channel-friend lists and the published KST advertising window. Acceptance and later result retain distinct request and message codes. | [AlimTalk send](https://api.ncloud-docs.com/docs/sens-alimtalk-send) · [List](https://api.ncloud-docs.com/docs/sens-alimtalk-list) · [Result](https://api.ncloud-docs.com/docs/sens-alimtalk-get) · [Brand send](https://api.ncloud-docs.com/docs/sens-brandmessage-send) · [List](https://api.ncloud-docs.com/docs/sens-brandmessage-list) · [Result](https://api.ncloud-docs.com/docs/sens-brandmessage-get) |
| PN13 Mail | `POST/GET /mail/v2/services/{serviceId}/requests`, `GET .../requests/{requestId}`, `GET .../requests/{requestId}/mails` and `GET .../requests/{requestId}/mails/{mailId}`. Explicit-recipient supplier mail reports `requestCount` at acceptance, counts by state at request lookup and per-recipient result at detail lookup. | [Create](https://api.ncloud-docs.com/docs/sens-mail-request-create) · [Request list](https://api.ncloud-docs.com/docs/sens-mail-request-list) · [Request detail](https://api.ncloud-docs.com/docs/sens-mail-request-get) · [Mail list](https://api.ncloud-docs.com/docs/sens-mail-list) · [Mail detail](https://api.ncloud-docs.com/docs/sens-mail-get) |
| PN14 Studio | `POST /v3/chat-completions/{modelName}` for HCX-005 tool calling and text/image, and HCX-007 Structured Outputs with `thinking.effort: none`. `POST /v3/api-tools/chat-tokenize/{modelName}` returns counts in the published tokenizer envelope. SSE returns token and result events with typed tool fragments, final arguments, finish reason and usage. | [Function calling](https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-fc) · [Text/image](https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3) · [Structured Outputs](https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-so) · [Tokenizer](https://api.ncloud-docs.com/docs/clovastudio-tokenizerhcxv3) |
| PN15 Speech and Receipt OCR | `POST /recog/v1/stt?lang=Kor` accepts the Navis mic's WAV and returns text and 15-second quota units. `POST /custom/v1/{domainId}/{invokeKey}/document/receipt` accepts one V2 synthetic receipt in JSON/base64 or as multipart `message` and `file`. It returns OCR's nested receipt data, field confidence and image-level error states. The positive fixture uses JPEG or PNG. | [Speech](https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-shortsentence) · [Speech errors](https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech) · [Receipt](https://api.ncloud-docs.com/docs/ai-application-service-ocr-ocrdocumentocr-receipt) · [OCR errors](https://api.ncloud-docs.com/docs/ai-application-service-ocr) |

The provider uses a shared clock for SENS scheduling, Studio result timestamps and OCR receipt dates. Studio returns deterministic draft content and fixture token counts. The Speech transcript and OCR recognition fields are synthetic outputs for approved café media. Media request bytes are scoped to the request. SENS keeps synthetic acceptance records and results in the isolated `naver_virtual` schema. The next installed café generation refreshes those records.

## Registration

| Caller | Operations | Mounted provider credential names |
| --- | --- | --- |
| `marketing-worker` | `pn13.{sms,alimtalk,brandmessage,mail}.{send,list,get}` plus `pn13.mail.{request,mails}` | `accessKey`, `secretKey`, `serviceId` on every operation. SMS and Mail send also use `sender`. AlimTalk send uses `plusFriendId`, `templateCode`, optional `templateText` (default `주문 안내`). Brand send uses `plusFriendId`, comma-separated `consentedRecipients` and `channelFriends`, plus `templateCode` and `templateText` for the template mode. Use synthetic numbers `0100000xxxx` and reserved Mail domains. [SENS authentication](https://api.ncloud-docs.com/docs/sens-overview) |
| `insight`, `marketing-worker` | `pn14.chat`, `pn14.tokenize` | `apiKey` for the Bearer header. [Studio authentication](https://api.ncloud-docs.com/docs/ai-naver-clovastudio-summary) |
| `insight` | `pn15.speech`, `pn15.receipt` | `secret` for each operation plus `domainId` and `invokeKey` for Receipt OCR. |

The selected fixtures cover SMS and LMS, a plain AlimTalk template, Brand text and its approved template, and explicit-recipient Mail. The provider signs off on acceptance and result shape. Navis owns command execution and any unknown send outcome stays with its durable attempt and reconciliation. Studio and media fixtures perform no outbound I/O. Compose and deployment grant installation and the adapter-to-widget checks belong to PN-COMPOSE, PN-W5 and PN-A2–A3.

## Verification

Run the contract suite from `backend` using Node 24. The Compose proof uses the local backend tools image, the same registrars and migrations, a fresh PostgreSQL database and a private Docker network. The contract runner calls the registered service over HTTP and verifies cross-account denial, SENS persistence, wire field lists and distinct errors, deterministic SSE, and both OCR request encodings.

```sh
npm exec vitest -- run services/naver-virtual/capabilities/pn13/group.test.ts --maxWorkers=2 --testTimeout=30000
npm run typecheck
docker compose --env-file /dev/null -p navis-pnp4-proof -f services/naver-virtual/capabilities/pn13/compose.test.yaml up --pull never --abort-on-container-exit --exit-code-from contracts
docker compose --env-file /dev/null -p navis-pnp4-proof -f services/naver-virtual/capabilities/pn13/compose.test.yaml down --volumes
```


## SMS reservations

[Send message](https://api.ncloud-docs.com/docs/sens-sms-send) accepts `reserveTime` as Seoul local
`YYYY-MM-DD HH:mm` and `reserveTimeZone` as `Asia/Seoul`. The reservation ID is the acceptance
`requestId`. The PN13 virtual capability also supports
[`GET /sms/v2/services/{serviceId}/reservations/{reserveId}/reserve-status`](https://api.ncloud-docs.com/docs/sens-sms-reservation-status-get)
with `reserveId`, `reserveTimeZone`, `reserveTime` and `reserveStatus`, and
[`DELETE /sms/v2/services/{serviceId}/reservations/{reserveId}`](https://api.ncloud-docs.com/docs/sens-sms-reservation-delete)
with an empty 204 response on cancellation. No outbound SMS is sent. A canceled reservation
cannot transition to a sent result. Since FIX-GAP-B, Navis owner notices no longer use provider
reservations: Marketing keeps the schedule in its own ledger and marketing-worker sends at the
scheduled minute after re-checking consent and closure (RV-GAP-B-3). The reservation routes stay
available for contract tests. No workload needs `pn13.sms.reservation-status` or
`pn13.sms.reservation-delete`.

Persona supports a private durable `Idempotency-Key` header for scheduled and immediate SMS sends.
The official request body is unchanged. A replay with the same key and identical body returns the
original acceptance and stores nothing new. The same key with a different body is refused with the
SENS 400 envelope and stores nothing. Live SENS
documents no such header, so the PN13 wire attaches the key only on the strict synthetic binding.

## Local rules without an official source

- `contentType: "AD"` outside 08:00–21:00 Seoul time returns 400 (`messages.ts`). The
  [send reference](https://api.ncloud-docs.com/docs/sens-sms-send) documents no time-of-day rejection.
  The night ban is the sender's legal duty (정보통신망법 §50), which Navis enforces before any call:
  B15 schedule validation, the marketing-worker claim re-check and the PN13 wire (`advertisingNight`).
  This virtual-server rule is a local backstop only (RV-GAP-B-8, same treatment as PN-AUDIT-3-1).
