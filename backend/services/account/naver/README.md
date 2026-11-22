# PN-A1 operating adapters

The private provider represents the fictional 안숭잘부 카페 with assumed owner and partner approvals. The partner-assumed contracts represent the selected owner views. Public wires use the documented provider requests and return bounded Navis projections. Deployment chooses bindings per store and operation through the PN-P0 transport. The A-3 runtime uses fake-only bindings. Live W bindings require current A6 approval.

## Composition registration

Pass the store-scoped PN-P0 `createNaverTransport({ bindings, … })` result to the four services. The adapter's `NaverTransport` type is structural so the domain tests can run against a stub. Supply the binding's HTTP method, exact path regex, grade, provider account and credential references using the tables below. The four caller workloads need access to the private `naver-virtual` origin. Register the AiCall callback only in Customer and authenticate it with an independent private callback credential mapped to the fixed store. Allow the callback from Persona to Customer in the private network.

| Domain | Compose injection | Owner integration |
| --- | --- | --- |
| Account | `createAccountNaver(transport, verifyPhotos)`, `createNaverLogin(transport, { credentials, consumeState })`, `createNaverObjectStorage(transport, authorizeObject)` | Verify owner upload rights before publishing. Resolve bucket and key through authorized file metadata. Use `createObjectStorageSigner(accessKeyId, now)` as PN-P0's credential signer with the file-mounted secret. Bind Calendar and PN17 Café bearer tokens to scoped authorized records with `createOwnerGrantResolver`. Login profile returns only the provider ID. |
| Inventory | `createInventoryNaver(transport)` | Feed the menu publish and online stock commands. Supply the existing seller option ID, price and usability unchanged when the owner chooses a new stock quantity. Adapter checks the acknowledged option. |
| Customer | `createCustomerNaver(transport)`, `createWorksCalendar(transport, resolveTeam)`, `registerAiCallCallback(app, { authenticate, upsertCandidate })` | Feed booking reads and commands, SmartCall, hours and Calendar. Resolve the linked WORKS member and calendar on the server. Authenticate the callback to a fixed `storeId`. Persist `{ storeId, dedupeKey, usageAt, partySize, contact? }` with a unique store/dedupe key. The hash covers the store, provider user ID/key, usage time and party size. Enable contact retention only for the fulfillment purpose. The accepted callback returns `{ valid: "reservationFailed" }` while review is pending. |
| POS | `createPosNaver(transport)` | Feed booking-associated order progression, approved online Npay merchant operations and separately sourced settlement, plus authorized seller order status. Keep terminal/Connect tender references in POS. |

Inventory and POS use separate seller credentials and tokens. `createCommerceTokenExchange` accepts the binding's client ID, optional seller account and bcrypt signing callback. Each corresponding W operation attaches the bearer through PN-P0. Calendar/profile use the scoped owner bearer, WORKS uses team credentials and Npay uses the official client and chain headers. File credential references, live approval settings, transport budgets and the callback client header belong to composition. Object uploads and downloads need a transport budget suitable for the approved file limit. OAuth authorization redirect responses have a fixed callback allowlist and are handled server-side in persona. Live browser authorization uses the official Login page and the session's single-use state.

The adapters add no gateway registrations or migrations. No service entry point or composition hunk is included. The callback candidate writer and credential/session storage belong to the existing services. The existing widget handlers own their routes, command receipts and retry reconciliation.

## Endpoint and source map

Partner paths in this table begin with `/partner-assumed/v1`.

| Operations | Method and path | Official source |
| --- | --- | --- |
| `pn01.place.{read,update}` | GET/PATCH `/place` | [Store details](https://help.naver.com/service/30026/contents/20366?lang=ko), [edit](https://help.naver.com/service/30026/contents/20379?lang=ko), [reflection delay](https://help.naver.com/service/30026/contents/20394?lang=ko) |
| `pn01.menu.{read,update}`, `pn01.hours.{read,update}` | GET/PATCH `/place/menu`, `/place/hours` | [POS menu](https://new.smartplace.naver.com/introduction/solution-market/payNPos), [hours](https://help.naver.com/service/30026/contents/20380?osType=MOBILE) |
| `pn02.bookings.{list,read,change,confirm,cancel,payment-request}` | GET `/bookings`, GET/PATCH `/bookings/:ref`, POST `/bookings/:ref/{confirm,cancel,payment-request}` | [Lookup](https://help.naver.com/service/11712/contents/7579?lang=ko), [change](https://help.naver.com/service/11712/contents/7581?lang=ko), [confirm](https://help.naver.com/service/30026/contents/20630?lang=ko), [cancel](https://help.naver.com/service/11712/contents/18720?lang=ko), [payment request](https://new.smartplace.naver.com/notices/1098) |
| `pn02.booking-products.list`, `pn02.orders.{list,read,prepare,pickup}` | GET `/booking-products`, GET `/orders`, GET `/orders/:ref`, POST `/orders/:ref/{prepare,pickup}` | [Restaurant products](https://new.smartplace.naver.com/notices/1098), [order progression](https://new.smartplace.naver.com/introduction/solution-market/payNPos) |
| `pn08.smartcall.{settings,calls}` | GET `/smartcall/settings`, `/smartcall/calls` | [SmartCall analytics](https://help.naver.com/service/30026/contents/20474?lang=ko&osType=COMMONOS) |
| AiCall private Customer callback | POST `/internal/naver-virtual/aicall/custom-condition/v2` | [Custom Condition v2](https://guide.ncloud-docs.com/docs/chatbot-chatbot-2-3), [AiCall scenario](https://guide.ncloud-docs.com/docs/clovaaicall-aicall-1-9) |
| `pn09.pay.{approve,cancel,settlement}` | POST `/naverpay-partner/naverpay/payments/v2.2/apply/payment`, POST `/naverpay-partner/naverpay/payments/v1/cancel`, GET `/naverpaysettle-payment/naverpaysettle/v1/settlements/by-case/{payment-id\|pay-hist-id}/:id` | [Approval](https://docs.pay.naver.com/docs/onetime-payment/payment/apply/), [cancel](https://docs.pay.naver.com/docs/onetime-payment/payment/cancel/), [settlement](https://docs.pay.naver.com/docs/settlement/settlement-api/settle-by-case/), [auth](https://docs.pay.naver.com/docs/common/authentication), [idempotency](https://docs.pay.naver.com/docs/common/idempotency) |
| `pn11.{authorize,token,profile}`, `pn11.calendar.create` | GET `/oauth2.0/authorize`, POST `/oauth2.0/token`, GET `/v1/nid/me`, POST `/calendar/createSchedule.json` | [Login](https://developers.naver.com/docs/login/api/api.md), [profile](https://developers.naver.com/docs/login/profile/profile.md), [Calendar](https://developers.naver.com/docs/login/calendar-api/calendar-api.md) |
| `pn11.works.{list,read,create,update,delete}` | GET/POST `/v1.0/users/:userId/calendars/:calendarId/events`, GET/PUT/DELETE event detail | [WORKS Calendar](https://developers.worksmobile.com/kr/docs/calendar) |
| `pn16.object.{put,get,delete}` | PUT/GET/DELETE `/:bucket/:key`, signed binary traffic | [Object Storage](https://api.ncloud-docs.com/docs/storage-objectstorage), [authentication](https://api.ncloud-docs.com/docs/common-objectstorageapi-objectstorageapi) |
| `pn16.commerce.{token,products.search,options.update,orders.detail}` | POST `/external/v1/oauth2/token`, POST `/external/v1/products/search`, PUT `/external/v1/products/origin-products/:id/option-stock`, POST `/external/v1/pay-order/seller/product-orders/query` | [Token](https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth), [product search](https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product), [stock](https://apicenter.commerce.naver.com/docs/commerce-api/current/update-options-product), [order detail](https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller) |

## Command and receipt integration

Construct `OwnerContext { storeId, actorId }` from authenticated request context. For writes, construct `OwnerApproval { key, extraConfirmed? }` inside the existing widget command only, after validating the pressed card, its operation and target, revision, expiry, owner role and durable idempotency fingerprint. Use an extra confirmation for booking or payment cancellation and object or WORKS deletion. The key maps to the same durable receipt on retry. Booking and order commands read back the bounded provider projection. An after-use payment request returns `awaiting-customer`. Record a pending outcome on an uncertain write and reconcile the actual provider state or prior attempt before retry. Npay approval returns merchant approval evidence. Settlement evidence is acquired separately. Calendar addition and WORKS creation require stable, locally derived event identifiers. Booking contact remains limited to active current fulfillment. Excel export follows the [official owner handoff](https://help.naver.com/service/30026/contents/20635?lang=ko).

## Verification

Run `npm exec vitest -- run --maxWorkers=2 services/account/naver/adapters.test.ts` and `npm run typecheck` from the backend. The gpu-server proof mounted the Mac provider snapshot into a private Compose network with PostgreSQL and the pinned test clock. It exercised the six capability groups, checked payload projections, denied an unlinked store, verified retry and restart read-back, and used the provider's AiCall fixture with an injected candidate writer. The proof used synthetic credentials and made zero real provider calls.

### PN11 and PN17 synthetic owner grants

`createPersonaOwnerGrants({owner,scopes,bindings})` returns `read` for the PN11
Calendar linkage and `resolve(owner,"cafe")` for the PN17 adapter. Configure a
single fixture owner and the private grade-P operation `pn11.fixture.owner-grant`
for POST `/partner-assumed/v1/fixture/owner-grants` on the virtual transport.
The operation's provider credentials are `storeId`, `actorId` and `scopes`
(a comma-separated list of calendar/cafe). Use the same virtual provider account
for the grant and the applicable Calendar/Café operations. The virtual server
mints a one-minute scoped bearer. Keep the mint route on the private network.
