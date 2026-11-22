# Inventory publication and supplier send

GAP-INV implements D-344 widget gaps 1, 12, and 13 for the fictional café. NAVER partner enrollment is assumed for the fixture. Place uses the private `partner-assumed` adapter. Commerce and SENS use the virtual NAVER service and its scoped credentials. A6 remains off.

- Place supports publication of owner-visible menu name and price and venue name, address, phone, keywords, and authorized photos. The provider read-back confirms a saved value. The widget can show “저장했어요 · 검색에 반영되는 데 시간이 걸려요”. [SmartPlace POS integration](https://new.smartplace.naver.com/introduction/solution-market/payNPos) · [Business information editing](https://help.naver.com/service/30026/contents/20379?lang=ko)
- Commerce changes one linked Smart Store option's online quantity. For keyed Navis requests, the virtual provider checks expected price and usability under its product lock. The service then reads the quantity back. The official option-stock API treats price and usability as supplied values. Its published contract provides no conditional update, so this read-back cannot guarantee price or usability preservation if a live concurrent edit occurred. A6 remains off. Store stock is independent. [Product search](https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product) · [Origin product read](https://apicenter.commerce.naver.com/docs/commerce-api/current/read-origin-product-product) · [Option stock update](https://apicenter.commerce.naver.com/docs/commerce-api/current/update-options-product)
- Supplier messages use virtual SENS LMS or Mail for the saved supplier contact and exact scheduled purchase order. The receipt tracks provider acceptance and delivery separately from order acceptance. [SMS/LMS send](https://api.ncloud-docs.com/docs/sens-sms-send) · [SMS lookup](https://api.ncloud-docs.com/docs/sens-sms-list) · [Mail send](https://api.ncloud-docs.com/docs/sens-mail-request-create) · [Mail request status](https://api.ncloud-docs.com/docs/sens-mail-request-get)

## Widget handoff

All browser paths use `/api/v1/stores/{storeId}/inventory`. The service uses `/internal/v1/inventory/stores/{storeId}`. Use the F00 authenticated transport. The following POST paths each take both a `/preview` suffix and a `/confirm` suffix.

| Command path | Preview input | Preview payload | Re-read |
| --- | --- | --- | --- |
| `/menu/{menuId}/place` | `{currentName?: string}` | Local menu revision, provider `current`, local `desired`, changed `patch`. Use the selected provider name for a rename. Omitting it matches the local name or prepares a new listing. | `GET /place/menu` → `{items:[{name,price}]}` |
| `/place/venue` | Partial `{name,address,phone,keywords,photos}` | Current venue and changed `patch` | `GET /place/venue` → those five venue fields |
| `/items/{itemId}/commerce-stock` | `{optionId,stockQuantity}` | `{originProductNo,current,stockQuantity}`. `current` has `id,name,stockQuantity,price,usable`. | `GET /items/{itemId}/commerce-stock` → `{originProductNo,name,stockQuantity,options}` |
| `/purchase-orders/{poId}/supplier-message` | `{channel:"sms"|"mail"}` | Order revision, supplier name, masked target, generated title/body, source revision and `scheduledAt` | `GET /purchase-orders/{poId}/supplier-message` → `{items:SupplierMessageReceipt[]}` |

Post `{input}` to the preview route. It returns `{previewId,expectedRevision,inputHash,diff,expiresAt}`.
Render the owner-visible `diff`. On the owner card press, post
`{stage:"press",operation,resourceId,expectedRevision,previewId}` to `POST /approvals` under the same inventory root.
Use `place.menu.publish` with the menu ID, `place.venue.publish` with `"venue"`,
`commerce.stock.set` with the linked inventory item ID, or `supplier.message.send` with the purchase order ID.
The result is `{approvalId,expiresAt,requiresConfirmation}`. Inventory publication needs one explicit press.
The widget then posts `{approvalId,expectedRevision,previewId}` to the action's `/confirm` with
`Idempotency-Key: <approvalId>`. The server uses the recorded input and binds its hash to the approval.

A successful retry of the exact same confirm returns the original receipt. Place and Commerce return
`{receiptId,resourceId,state:"saved",readBack,affectedSources}`. An `observed` receipt means the desired provider state was verified on resumption.
Re-read the corresponding GET for the authoritative value. Show a fresh card on `STALE_REVISION` or `CARD_EXPIRED`.
A missing link returns `COMMERCE_ITEM_NOT_LINKED`. `NO_CHANGES` indicates the preview found an empty patch.

Supplier Send stays widget-only under the existing `supplier.sendOrder` policy. The press creates a `queued` receipt. Poll the GET for `dispatching`, `accepted`, `delivered`, `failed`, `blocked`, or `unknown`. Show the provider acceptance separately from delivery. If the preview has a future `scheduledAt`, show “내일 8시” on the card. SMS is sent as informational LMS using the supplier phone field. Mail uses the saved contact field when it contains a valid address. The order revision and channel deduplicate new cards while a send is active, accepted, delivered, or unknown. A failed or blocked send allows a fresh preview and owner press. If the provider outcome is unknown and lacks an authoritative receipt ID, the worker leaves it unknown and prevents a duplicate send.

Shared TypeScript types are in `01/publication-dto.ts`, `03/commerce-routes.ts`, and `04/supplier-message.ts`.

## Composition registration

1. In the inventory app, register `registerPublicationApprovals(app,pool,gatewayToken)` once.
   Call `registerPlacePublication(app,pool,gatewayToken,{inventory,account})` with the existing PN-A1 ports.
   Provide the account service's store and photo rights verifier to `createAccountNaver`.
   Call `registerCommerceStock(app,pool,gatewayToken,transport)` and
   `registerSupplierMessages(app,pool,gatewayToken,{workerToken,storeId,now})` with the existing scoped bindings and separate worker token.
2. In the gateway `inventoryRoutes`, add POST `/approvals`, the four GETs, and the eight POSTs in the widget table.
   Apply the existing browser owner and workload authorization rules and forward the idempotency key.
   The widget card path calls `/approvals` and `/confirm`. Keep both out of typed/voice agent execution.
   Private `GET /internal/v1/inventory/supplier-dispatch/stores/:storeId` and
   `POST .../:receiptId/{ready,claim,result}` keep their worker token and single-store scope.
3. Bind `pn01.menu.{read,update}` and `pn01.place.{read,update}` to the PN-A1 Persona transport. Venue uses the account workload capability or an explicit inventory grant scoped to those two operations. Bind `pn16.commerce.products.read` to GET `/external/v2/products/origin-products/:originProductNo`. Use the same scoped Commerce authorization and `clientId`/`sellerId` grant files as `pn16.commerce.products.search`. Keep the existing token, search, and option-stock bindings. The Persona stock adapter journals card keys. Provision the approved demo catalogue item in `inventory.commerce_link` with origin product number `10001` and its scoped inventory item UUID. Use the migration role and bound store context for that existing fixture link.
4. Instantiate `createSupplierWorker` from `workers/marketing-worker/supplier/index.ts`. Supply the existing marketing worker DB pool and Redis streams, configured store, Persona workload and SENS signing files, Persona fixture sender number/address and SMS/Mail service IDs, and private inventory URL/token. Start `consumer.run(stop.signal)` and call `step(stop.signal)` in the existing poll loop. The registrar forces Persona mode and four PN13 operations. Existing marketing-worker grants cover `pn13.sms.{send,list}` and `pn13.mail.{send,request}`.
5. Add `marketing-supplier` to inventory relay groups in `relay/index.mjs` and map it to marketing's schema and relay DB. Extend the marketing relay checkpoint policy in `infra/postgres/30-phase3-access.sh` for `consumer_group='marketing-supplier' AND producer='inventory'`. Grant marketing-worker Redis ACL read/claim/ack and epoch access for `navis.inventory.0` and `navis.inventory.0.epoch`, and XADD for `navis.dlq.marketing-supplier`. In local ACL generation these are the existing `extra_streams` and `extra_dlq` switches. Permit marketing worker to reach inventory privately and Persona within the workload network. Keep the existing grants for marketing's stream inbox and checkpoint worker roles.

## Persistence and events

Inventory migrations `20261122000401` through `20261122000406` are ordered after the previously released purchasing migration. Each table uses forced store RLS. Supplier approval, dispatch and request outbox are committed before any worker call. `inventory.supplier_message_requested.v1` carries a receipt ID only. The worker reports result transitions to the private inventory endpoint, which persists each transition and emits `inventory.supplier_message_status_changed.v1` with receipt ID, purchase order ID and state. Contact details and message bodies are reconstructed by the private claim route only after checking the order and supplier snapshot. Provider request identifiers are private.

## Local evidence

The gpu-server worktree retains `.evidence/gap-inv/compose-proof.log`, `backend-tests.log`, `widget-tests.log`, `typecheck.log` and `lint.log`. Node 22 passed typecheck and lint, 36 backend tests (6 optional cases skipped), and 69 widget tests. The isolated Compose proof used PostgreSQL and Redis, loaded the gateway allowlist in the test process, verified signed browser tokens with a test account verifier, and called the private Persona app over HTTP with fresh scoped databases. It checked a new session after inventory restart, provider read-back, forged text denial, RLS, unchanged in-store stock, and SMS/Mail acceptance followed by delivery. The Mac-owned widget and composition changes are pending integration.

Filtered A-3 FAKE evidence is in `.evidence/navis-scenarios/A3-GAP-INV-report.md`, `A3-GAP-INV-manifest.jsonl`, and `A3-GAP-INV-ledger.jsonl`. The selected menu, inventory and supplier widget and slice filters cover 385 IDs and 1,213 variants. The fixture harness passed 120 IDs and 448 variants with zero unauthorized writes. Browser testing of the new widgets awaits their Mac cutover.
