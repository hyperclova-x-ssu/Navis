# PN-A2 marketing NAVER adapters

Marketing-side provider ports for PN03 reply, PN04–PN07, PN10, PN12 publication, PN13 sends, PN14 promo client, PN16 artifact consumer and PN17 Café posting ([PERSONA_NAVER §6.1](../../../../../03_architecture/PERSONA_NAVER.md#61-new-implementation-and-contract-work)). Every call goes through the PN-P0 scoped transport (`packages/naver/transport`) using bindings from `binding.ts`. Payloads follow the committed provider contracts in `packages/naver/contracts/pn03…pn17`. The ports store no state and add no owner routes. B13–B16/B19 call write ports only inside their existing card command, after the revision, expiry and extra-confirmation checks, and pass their durable attempt key. Typed, spoken or model text never reaches a write port.

## Modes

| Mode | Binding |
| --- | --- |
| `fake` | `createMarketingProvider({ mode: 'fake', fakeOnly: true, fakeHandler })`. In-process handler and zero sockets (A-3, R1 checks). |
| `virtual` | `http://naver-virtual:3000`. PN-P0 adds `x-navis-naver-virtual-token` and `x-navis-naver-virtual-account`. W operations also send the official authentication (API key, SENS signature v2, Studio Bearer, S3 SigV4 `kr-standard` or TalkTalk `Authorization`) with synthetic credentials. |
| `live` | W only, at the official origin, with the caller's A6 `approve(request)` check on every request. P/O stays refused until a verified partner contract exists (§7). |

Responses are checked against the field allowlist: strictly in persona and fake mode (no invented fields), while live W tolerates fields that NAVER adds later. Errors map to `NaverAdapterError.code` values: `INVALID_INPUT`, `CONFIRMATION_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, `REJECTED`, `RATE_LIMITED`, `UNAVAILABLE` (a read changed nothing), `UNKNOWN_OUTCOME` (a write may have happened; keep the attempt pending and reconcile), `CONTRACT_VIOLATION`, `NOT_CONFIGURED` and `LIVE_NOT_APPROVED`. Delete, end and cancel need `confirmation: 'confirmed-twice'`.

## Ports and signatures

`createNaverMarketing(provider, { clock?, cafeGrant? })` in `index.ts`. `provider = createMarketingProvider({ storeId, providerAccount, mode, virtualOrigin?, privateTokenFile?, credentialFiles?, operations?, fakeHandler?, approve?, now?, fetcher?, readCredential?, fakeOnly? })`.

| Port (owner) | Methods | Persona endpoint · operation | Official source |
| --- | --- | --- | --- |
| `reply` PN03 (B15) | `readReview(ref)`, `post({reviewRef,text,attemptKey})`, `update({reviewRef,text,attemptKey})`, `remove({reviewRef,attemptKey,confirmation})` → `{effect, reply, readBack}`; `draft({reviewRef,style,length})` → `{text, source:'naver-ai'}`; `reconcile(ref, expectedText)`; `REPLY_NOTICE` | `/partner-assumed/v1/reviews/:ref`, `…/reply`, `…/reply-draft` · `pn03.reviews.get`, `pn03.reply.{create,update,delete,draft}` | [20545](https://help.naver.com/service/30026/contents/20545) · [25102](https://help.naver.com/service/30026/contents/25102) · [876](https://smartplace.naver.com/notices/876) |
| `news` PN04 (B15/B16) | `list({limit,offset})`, `get(ref)`, `create({title,text,video?,pin?:{to,order},attemptKey})`, `update({ref,…,attemptKey})`, `remove({ref,attemptKey,confirmation})` | `/partner-assumed/v1/place/news[/:ref]` · `pn04.news.*` | [20513](https://help.naver.com/service/30026/contents/20513) · [695](https://new.smartplace.naver.com/notices/695) · [922](https://new.smartplace.naver.com/notices/922) |
| `coupons` PN05 (B14) | `listPlaceCoupons`, `createPlaceCoupon({coupon,attemptKey})`, `deletePlaceCoupon({ref,attemptKey,confirmation})`, `listCouponIssues({couponRef})`, `setIssueUsage({issueRef,used,attemptKey})`, `listOrderPromotions`, `createOrderPromotion({promotion,attemptKey})`, `extendOrderPromotion({ref,to,attemptKey})`, `endOrderPromotion({ref,attemptKey,confirmation})`, `listMembershipBenefits` | `/place/coupons…`, `/place/coupon-issues/:ref/usage`, `/order/promotions…`, `/membership/benefits…` · `pn05.{coupons,issues,promotions,membership}.*` | [20833](https://help.naver.com/service/30026/contents/20833) · [20837](https://help.naver.com/service/30026/contents/20837) · [20843](https://help.naver.com/service/30026/contents/20843) · [21111](https://help.naver.com/service/30026/contents/21111) · [20710](https://help.naver.com/service/30026/contents/20710) · [1100](https://smartplace.naver.com/notices/1100) · [25061](https://help.naver.com/service/30026/contents/25061) |
| `talktalk` PN06 (B15) | `listConsultations({status?,from?,to?})`, `getConsultation(ref)`, `sendReply({user,text,attemptKey?})` → `{state:'accepted'}`; `registerTalkTalkInbound(app,{mode,callbackToken,onEvent,verify?})`; `parseTalkTalkEvent` | `/partner-assumed/v1/talktalk/consultations[/:ref]` · `pn06.consultations.*`; W `POST /chatbot/v1/event` · `pn06.chatbot.send`; callback `POST /internal/v1/naver/talktalk/webhook` on marketing | [chatbot README](https://github.com/navertalk/chatbot-api/blob/master/README.md) · [3614](https://help.naver.com/service/11830/contents/3614?lang=ko) · [23823](https://help.naver.com/service/11830/contents/23823) · [24283](https://help.naver.com/service/11830/contents/24283) |
| `talktalkMarketing` PN07 (B14/B15 send worker) | `audiences()` → `{items:[{audience}],quota?:{month,assigned}}`; `send({audience,title,body,couponRef?,attemptKey})` → `{effect:'talktalk-marketing-accepted'}` (persona 204). Quota is the monthly assigned allowance. Consumption is unconfirmed. Navis keeps the D-331 night policy (21:00–08:00 → `REJECTED`/`night-window`, card proposes 내일 8시) | `/partner-assumed/v1/talktalk/marketing/{audiences,sends}` · `pn07.audiences.list`, `pn07.sends.create` | [20507](https://help.naver.com/service/30026/contents/20507) · [21111](https://help.naver.com/service/30026/contents/21111) |
| `search` PN10 (B13) | `search(channel,{query,display?,start?,sort?})`, `trend({request})`, `geocode({query,coordinate?,page?,count?})` → `{attribution:{provider,operation,retrievedAt,use:'display-only'}, result}` | W `GET /search/v1/{blog,cafearticle,local,news}`, `POST /search-trend/v1/search`, `GET /map-geocode/v2/geocode` · `pn10.*` | [API HUB](https://api.ncloud-docs.com/docs/naver-api-hub-overview) · [blog](https://api.ncloud-docs.com/docs/naver-api-hub-search-blog) · [cafe](https://api.ncloud-docs.com/docs/naver-api-hub-search-cafearticle) · [local](https://api.ncloud-docs.com/docs/naver-api-hub-search-local) · [news](https://api.ncloud-docs.com/docs/naver-api-hub-search-news) · [trend](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend) · [geocoding](https://api.ncloud-docs.com/docs/application-maps-geocoding) |
| `clips` PN12 (B16) | `publish({media,caption?,category?,tags?,visibility,attemptKey})` → `{effect:'clip-published',ref,visibility,link}`; `read(ref)` | `/partner-assumed/v1/clips[/:ref]` · `pn12.clip.{create,read}` | [24422](https://help.naver.com/service/30048/bookmark/24422) · [25170](https://help.naver.com/service/30048/contents/25170) |
| `cafe` PN17 (B13) | `post({clubid,menuid,subject,text,attemptKey})` → `{effect:'cafe-article-posted',articleId,articleUrl}`; text is HTML-escaped, `\n` → `<br>` | W `POST /v1/cafe/{clubid}/menu/{menuid}/articles` · `pn17.article.create` | [Café API](https://developers.naver.com/docs/login/cafe-api/cafe-api.md) |
| `createSensWire(provider,{serviceIds,clock})` PN13 (marketing-worker) | `sendSms`, `listSms`, `getSms`, `sendAlimTalk`, `getAlimTalk`, `sendBrandText`, `getBrand`, `sendMail`, `getMailRequest`; `createVirtualSensTransport(wire, mode)` implements the existing `FakeSensTransport` for `createSensWorker` | W `/sms|alimtalk|brandmessage/v2/services/{serviceId}/messages[/:id]`, `/mail/v2/services/{serviceId}/requests[/:id]` · `pn13.{sms,alimtalk,brandmessage}.{send,list,get}`, `pn13.mail.{send,request}` | [SENS](https://api.ncloud-docs.com/docs/sens-overview) · [SMS](https://api.ncloud-docs.com/docs/sens-sms-send) · [AlimTalk](https://api.ncloud-docs.com/docs/sens-alimtalk-send) · [Brand](https://api.ncloud-docs.com/docs/sens-brandmessage-send) · [Mail](https://api.ncloud-docs.com/docs/sens-mail-request-create) |
| `createStudioPromoFetch(provider)` PN14 (marketing-worker) | `(stage, attemptId) => fetch` for `createFakePromoProvider({ naverFetch })`; look = HCX-005 image JSON, story/scenes = HCX-007 Structured Outputs | W `POST /v3/chat-completions/{HCX-005|HCX-007}` · `pn14.chat` | [v3](https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3) · [SO](https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-so) |
| `createPromoObjectStore(provider,{bucket,keyPrefix})` PN16 (marketing-worker) | `put(scope,bytes,mime)`, `get(scope,sha256?)`, `remove(scope)`; key `{keyPrefix}{storeId}/{artifactId}` | W `PUT/GET/DELETE /{bucket}/{key}` · `pn16.object.{put,get,delete}` | [Object Storage](https://api.ncloud-docs.com/docs/storage-objectstorage) |

SENS: `202` means accepted, and delivery is read separately. The wire enforces the documented SMS 90-byte and LMS 2,000-byte EUC-KR limits, while the policy keeps the Navis 80-byte QA reply limit. AlimTalk and Brand Message keep SMS failover off. Brand Message holds the 20:50–08:00 lock. Advertising SMS needs the `(광고)` prefix and is refused at night. Search results are display-only and attributed, and never stored, fed to HCX or blended into a KPI. TalkTalk inbound events carry no ID, so `correlation` is a content fingerprint for the B15 ledger to dedupe within its receive window.

## Composition registration (no composition files changed)

- Marketing service uses `registerTalkTalkInbound(app, { mode, callbackToken, onEvent })` with B15's inbox ledger as `onEvent`. Read `callbackToken` from a dedicated mounted synthetic token file shared with the Persona callback grant. Set `NAVIS_NAVER_VIRTUAL_TALKTALK_CALLBACK_URL=http://marketing:3000/internal/v1/naver/talktalk/webhook`.
- Marketing and marketing-worker: call `createMarketingProvider({ storeId, providerAccount: 'ansungjalbu-cafe', mode, virtualOrigin: 'http://naver-virtual:3000', privateTokenFile, credentialFiles, operations })` and inject it into `createNaverMarketing`, `createSensWire`, `createStudioPromoFetch` and `createPromoObjectStore`. Use `mode: 'fake', fakeOnly: true` in A-3.
- Persona grants:
  - `marketing`: `pn03.reviews.get`, `pn03.reply.{create,update,delete,draft}`, `pn04.news.{list,get,create,update,delete}`, `pn05.{coupons.{list,create,delete},issues.{list,update},promotions.{list,create,extend,end},membership.list}`, `pn06.consultations.{list,get}`, `pn06.chatbot.send`, `pn07.{audiences.list,sends.create}`, `pn10.{blog,cafearticle,local,news,trend,geocode}`, `pn12.clip.{create,read}` and `pn17.article.create`.
  - `marketing-worker`: `pn13.{sms,alimtalk,brandmessage}.{send,list,get}`, `pn13.mail.{send,request}`, `pn14.chat` and `pn16.object.{put,get,delete}`.
- Persona `providerCredentialFiles`, synthetic and per operation:
  - pn10: `keyId`, `key`.
  - pn06.chatbot.send uses `talktalkAuthorization` and `talktalkCallbackToken`. The private fixture workload's pn06.fixture.dispatch grant uses the same `talktalkCallbackToken` file.
  - pn13: `accessKey`, `secretKey`, `serviceId`, `sender`, `plusFriendId`, `templateCode`, `consentedRecipients` and `channelFriends`.
  - pn14.chat: `apiKey`.
  - pn16: `accessKeyId`, `secretAccessKey`, `bucket` and `keyPrefix`.
- Adapter credential files, mounted read-only: the persona workload token, `apihub.json` `{keyId,key}`, `sens.json` `{accessKey,secretKey}`, `studio.json` `{apiKey}`, `objects.json` `{accessKeyId,secretAccessKey}` and `talktalk-authorization` (raw value). Non-secret settings are the SENS service IDs, Object Storage `bucket` and `keyPrefix`, and the Café grant from account's `createOwnerGrantResolver` (PN-A1).
- Network: allow marketing and marketing-worker → naver-virtual:3000, and persona → marketing:3000 for the callback only. No gateway route. The persona DB needs `pgcrypto` and the `nvirtual_mig`/`nvirtual_run` roles.

## Verification

```sh
cd services/marketing/naver/test/compose
NODE_DIR=… MODULES_DIR=… docker compose --env-file /dev/null up -d --wait postgres      # loopback :55432
PN_A2_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<fresh db> npm exec vitest -- run services/marketing/naver --maxWorkers=2 --testTimeout=30000
NODE_DIR=… MODULES_DIR=… docker compose --env-file /dev/null --profile proof up --abort-on-container-exit --exit-code-from marketing naver-virtual marketing
docker compose --env-file /dev/null --profile proof down --volumes
```

`naver-virtual-provider.test.ts` runs the committed naver-virtual registrars, migrations and seed against PostgreSQL. `unit.test.ts` needs no provider and covers fake mode, live refusal, the AWS SigV4 example, SENS signature format and inbound parsing. The Compose proof runs the marketing container against the naver-virtual container on an internal-only network and prints one JSON summary. It compares fields with the official lists (`test/official-fields.ts`) and covers the callback, denial and blocked egress.

## Open items

- PN12 report provenance belongs to PN-A3's insight channel facts (§6.1). PN-A2 covers Clip publication only.
- PN16: putting a worker-stored object reference into the account artifact registry needs PN-A1/B16 agreement. Today's promo flow keeps using the account artifact client.
- PN04/PN12 media: news `video` and clip `media` are already-registered owner refs. Persona exposes no upload route.
- Live P/O wires stay 미확인 (§7), and live W needs A6 per operation.
