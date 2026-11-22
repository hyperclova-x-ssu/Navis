# Navis Backend

Navis의 서버 쪽 코드입니다. 기능별로 나눈 **6개 서비스(MSA)** 와 API gateway, 이벤트 전달용 relay, 백그라운드 작업기로 이루어져 있습니다.
각 서비스는 **자기 DB만** 읽고 쓰며, 다른 서비스에 알릴 일은 같은 트랜잭션 안에서 outbox에 적고 Redis Streams로 전달합니다.

| 항목 | 선택 |
| :--- | :--- |
| 런타임 | Node.js 24 (TypeScript 그대로 실행), Fastify 5 |
| DB | PostgreSQL 17 — 서비스별 논리 DB 6개, 서비스마다 migrate·runtime 역할 분리, FORCE RLS로 매장 격리 |
| 인증 | ES256 JWT(10분) + 회전 refresh 토큰, gateway가 요청마다 계정·매장 권한 확인 |
| 이벤트 | Transactional outbox → relay → Redis Streams → 소비자(커밋 후 ACK, 재전달 대비 멱등 처리) |
| 마이그레이션 | node-pg-migrate + 버전별 SQL |
| 로컬 실행 | Docker Compose (그림과 같은 모양: edge · frontend · gateway · 서비스 6개 · DB · Redis) |
| 배포 대상 | NAVER Cloud NKS — [`deploy/`](deploy/)의 Helm 차트 샘플 참고 |

## 폴더 안내

```text
backend/
├── gateway/                     // API gateway: 유일한 공개 API 입구, JWT 검증, 매장 권한 확인, 내부 서비스로 전달
├── services/
│   ├── account/                 // 계정·매장·소속, 로그인·토큰 발급·회전, 비공개 파일 메타데이터
│   ├── pos/                     // 주문·결제 원장: 바뀌지 않는 판매/정정 기록, 명령 영수증, outbox
│   ├── inventory/               // 메뉴·레시피·재고·입고, 판매 기반 재료 사용량, 수요 예측 결과 API
│   ├── customer/                // 손님·예약·회원권, 첫 주문 예약·회원권 claim과 POS 결과 맞추기
│   ├── marketing/               // 쿠폰·공지·홍보 영상, 네이버 톡톡 1:1 문의, 동네·상권 자료(서울 공공데이터)
│   ├── insight/                 // Navis 대화(HCX-005), 매출 집계, CCTV 5분 집계, 브리핑, AI 사용량 기록
│   └── naver-virtual/           // 네이버 가상 서버: 키 없이 네이버 API 계약대로 답하는 시연용 내부 서버
│       └── */migrations/        //   서비스별 SQL 마이그레이션
├── workers/
│   ├── pos-receipts/            // 입고 영수증 이벤트 소비 → POS 지출 후보로 기록
│   ├── marketing-worker/        // 홍보 영상 생성·문자 발송 작업 실행, 실패 재시도와 결과 맞추기
│   └── forecast-cron/           // 하루 한 번 도는 재고 수요 예측 (같은 요일 4주 판매 × 레시피)
├── relay/                       // outbox-relay: 각 서비스 DB의 outbox를 Redis Streams로 옮김
├── packages/
│   ├── contracts/               // 서비스·화면이 공유하는 API·이벤트 타입
│   ├── db/                      // DB 연결, 역할별 접속, 마이그레이션·시드 CLI, 카페 90일 시드 맥락
│   ├── naver/                   // 네이버 API 공통: 계약 타입, 전송(재시도·서명), 설정
│   ├── approvals/               // 확인 카드(1분 유효) 발급과 승인 기록: 돈·발송 같은 작업은 확인 뒤에만 실행
│   └── streams/                 // 이벤트 봉투, outbox 트랜잭션, relay·소비자 공통 로직
├── infra/
│   ├── edge/                    // nginx edge: '/' → frontend, '/api' → gateway, 요청 ID 부여
│   ├── frontend/                // 정적 SPA를 서빙하는 nginx 설정
│   ├── postgres/                // 서비스별 DB·역할 생성 스크립트
│   ├── local-secrets.sh         // 로컬 전용 일회용 비밀번호·서명키 생성 (.secrets/, 커밋 안 함)
│   └── entrypoint.ts · http.ts  // 공통 기동 코드, /healthz · /readyz
├── test/compose/                // Compose 위에서 도는 통합 시험 (스트림 전달·재고·예약)
├── deploy/                      // NKS 배포 샘플: Helm 차트, Secret 예시, GitHub Actions 예시
├── Dockerfile                   // 워크로드별 빌드 타깃(edge, frontend, api-gateway, account …)
└── compose.yaml                 // 로컬 실행 구성
```

<br/>

## Local run (Docker Compose on Mac)

Docker Desktop runs the edge, static frontend, API gateway, six Fastify services, the insight-navis workload, PostgreSQL 17.11 and Redis. Open `http://127.0.0.1:18180`. The edge routes `/api` and `/api/*` to the gateway and the frontend serves the SPA paths. Only the edge publishes a host port.

## R1 account and store records

Run migrations before starting the R1 images. For an operating store, provision its initial owner from the migrator environment with `node packages/db/cli.ts provision-owner`. Mount an operator-managed JSON file read-only and set `NAVIS_OWNER_PROVISION_FILE` to its path in the tools container. Supply `loginId`, `password`, `ownerName`, `storeId` (UUID), `storeName` and optionally `businessDayStart` (HH:mm, Asia/Seoul). Use at least 12 characters for the password. Reuse the existing account credential and supply a new store ID to add a second store. The transaction refuses to take over a store owned by a different account.

Use `VITE_NAVIS_DATA_SOURCE=http` for browser sign-in and store selection. `POST /api/v1/auth/login` issues the usual access token and refresh cookie. `POST /api/v1/auth/logout` revokes the cookie's session and clears the cookie. `GET /api/v1/stores` returns the active memberships. `POST /api/v1/auth/store` checks the access token and current cookie, rotates into the selected store and preserves the original expiry. Demo issuance is opt-in via `NAVIS_BACKEND_DEMO_AUTH=1` on the canonical loopback origin or an explicitly generated disposable replay origin. Hosted demo issuance requires `NAVIS_HOSTED_DEMO_AUTH=1`, the HTTPS edge proof and the hosted seed.

With an authorized store token, use `GET/PATCH /profile`, `GET/PATCH /preferences`, and `GET /boards` or `PUT /boards/{management|marketing}` under `/api/v1/stores/:storeId`. Board writes replace all pages and panels of that board atomically. Writes include `expectedRevision` and `Idempotency-Key`, returning a receipt and affected sources. Retrying a key returns its existing receipt. A changed body returns `409 IDEMPOTENCY_CONFLICT`, and a stale revision returns `409 STALE_REVISION`.

Create a store attachment with `POST /files` and `{purpose,contentType,size,sha256}`. Supply `Idempotency-Key: file:{purpose}:{sha256}`, upload the exact bytes to `PUT /files/:id/content`, and finalize with `POST /files/:id/complete`. Download from `GET /files/:id/content`. `DELETE /files/:id` returns 204 and revokes the file and releases its stored bytes. A new upload of deliberately revoked content requires a fresh key. The limit is 4 MiB for PNG, JPEG and WebP images, plus PDF for evidence purposes. Menu photos must be complete and belong to the same store before Inventory can reference them.

The account migration `20261122000000_real_account.sql` stores credentials, configuration, preferences, normalized boards, attachment metadata and bytes, receipts and an outbox. Events carry store, membership, preference, panel/widget or file identities and revisions/state. Service-local writes commit with their event. Inventory and POS provision their scoped records with a live account store, and POS prices operating sales from a private Inventory snapshot.

Configure distinct, private workload credential files for the POS-to-Inventory (`NAVIS_POS_INVENTORY_TOKEN_FILE`) and Inventory-to-Account (`NAVIS_INVENTORY_ACCOUNT_TOKEN_FILE`) calls. Configure `NAVIS_POS_INVENTORY_URL` on POS and `NAVIS_INVENTORY_ACCOUNT_URL` on Inventory. Both ends of each hop mount its corresponding file. The local generator creates both credential files. W5 projects them from `navis-tokens` and pairs ingress and egress for each TCP 3000 hop. POS reads its gateway credential from `NAVIS_GATEWAY_POS_TOKEN_FILE` and uses the store clock. Setting `NAVIS_POS_FIXTURE_NOW` selects the existing private fixture routes.

The standalone `inventory-stock-worker` consumes POS sale and correction events through the existing relay and Redis consumer group. It connects as `inventory_wrk`, mounted from `inventory_wrk_password`, and uses the inventory Redis ACL. The worker logins must exist before their service migrations run. On an existing local fixture volume, run the local generator, then `docker compose --env-file /dev/null exec -T db /docker-entrypoint-initdb.d/15-worker-logins.sh` before migrating. Run `20-stream-access.sh` after migration and start the workloads. W5 provisioning creates the worker logins and grants each its own database connection before the migration Job.

For disposable verification, `python3 test/compose/real-plan-local.py` prepares a separate Compose project on loopback port 18280 and returns its Compose config path. Build `tools account inventory pos api-gateway edge frontend inventory-stock-worker relay`, start `db` and `redis`, run `tools npm run migrate` and `20-stream-access.sh`, then start `edge` and `inventory-stock-worker`. Run `tools node test/compose/real-plan-account.mjs` against that project to check the account and dependent service records, including stock after a POS sale and correction. The browser proof script `test/compose/real-plan-account-browser.mjs` accepts the Compose config path and an evidence directory and uses the shared Chrome session.

For the reviewer fixture, pass `--gate-seed` to enable the two seeded stores' bilateral community pair. Pass `--replay-instant` with a timezone-qualified ISO timestamp to give the workloads and seed CLI a shared business clock and enable café demo issuance on the generated loopback port. Run `tools npm run seed` on the fresh disposable stack after migration to seed all registered services using that clock.

For purchasing, also migrate and start `customer` and start `pos-receipt-worker` from the POS image. The worker uses `pos_wrk` and the POS Redis identity to process Inventory receipts and voids. Customer consumes Inventory order changes for Calendar. On a running local setup, regenerate the ACL and recreate `redis` to pick up Customer's access to the Inventory stream. The relay reconstructs stream groups from the service databases. The HTTP proof accepts `--customer --postpaid --purchasing` for the combined member, calendar, table, receipt and expense checks.

Insight and Marketing owner records run with Phase 3 off. The regular migrations and post-migration scripts configure the POS, Customer, Insight and Marketing Streams. Briefing reads POS, Customer, Inventory and Marketing through four target-specific credentials. They authorize only the listed private GET routes and preserve owner and store scope. Manual photos, tax evidence and community participation use their private Account workload credentials. Account resolves only explicitly configured bilateral pairs in `NAVIS_ACCOUNT_COMMUNITY_PAIRS`; the default is an empty list.

Account's demo seed stores the approved café promo photos as scoped attachments. Confirmed promo generation binds the selected photos into worker artifacts. The local worker can use the FAKE Phase 3 fixture with `NAVIS_FIXTURE_SMS_ENABLED=0`; the owner assets, drafts, job status and MP4 remain available through the versioned records APIs. The Compose proof flags `--insight --insight-streams --briefing --marketing-local --marketing-cards --booking --booking-persona --promo --tax --groups` exercise the corresponding owner routes.

### NAVER Virtual Server

The NAVER Virtual Server runs the synthetic 안숭잘부 카페 owner scenario, with assumed approvals and restaurant eligibility. Only the assigned Navis domain workloads and marketing worker join its private HTTP network. It has a separate DB-only network and the `naver_virtual` database. Its roles are `nvirtual_run` and `nvirtual_mig`. Each caller receives its own workload token and only the synthetic provider credentials for its granted operations. The private HTTP network is restricted to those workloads.

After generating local credentials, use `docker compose --env-file /dev/null run --rm --build naver-virtual-tools` for migrations, then `docker compose --env-file /dev/null run --rm naver-virtual-tools node --experimental-transform-types services/naver-virtual/seed.ts` for the fixed seed. Start `naver-virtual` after both steps. Recreate disposable local volumes from before the migration renumbering and service rename.

The virtual server's local clock defaults to 2026-11-17 15:45 Seoul time. Use `NAVIS_NAVER_VIRTUAL_CLOCK=real` for a timed hosted demo and pass a single timezone-qualified `NAVIS_NAVER_VIRTUAL_SEED_INSTANT` to both seed Jobs. The two Jobs share the Seoul calendar range and 05:00 business cutoff. Same-generation retries preserve recorded operations. The private TalkTalk and AiCall callback URLs are configured when their receiving adapters are installed. A-3 uses its in-process FAKE bindings.

Use `node test/compose/naver-virtual-topology.mjs` from `backend/` to verify the network and grants without starting containers. The disposable repository proof in `.evidence/r1-compose/persona-compose-proof.py` builds the virtual server image, applies the migrations and seed, then confirms and re-reads a synthetic booking across a seed retry and service restart.

The operating POS browser proof builds with `VITE_NAVIS_DATA_SOURCE=http` and `VITE_NAVIS_POS_CLOCK=real`. For the member, calendar and staff proof, also build and start `customer` and run the HTTP script with `--customer`. Customer reads and writes receive the live Account operating clock. POS and Customer mount separate credentials for each call direction. The new POS-to-Customer credential is `NAVIS_POS_CUSTOMER_TOKEN_FILE` on both workloads, with `NAVIS_CUSTOMER_URL` configured on POS. Checkout funded entirely from a member balance records a settlement without a deposit payment, and Inventory projects its sale-time usage from the settlement event.

## Hosted café seed clock

The opt-in hosted seed Job generates a 90-day café window ending on the current Seoul calendar date. Account stores the café timezone and 05:00 cutoff. Before 05:00, POS and Inventory seed the preceding business date. An explicit `NAVIS_HOSTED_DEMO_SEED_END_DATE=YYYY-MM-DD` pins the window and its service business date. Set the same value for the HTTP frontend build and the seed Job to reproduce a release across midnight. The Helm setting is `--set-string seed.endDate=YYYY-MM-DD`, and the Kustomize `apply.sh seed` entrypoint reads the environment variable directly. The CLI logs the resolved calendar window and business date.

Hosted HTTP frontend builds select `VITE_NAVIS_CLOCK=real` and pass an optional `VITE_NAVIS_FIXTURE_END_DATE` from the seed pin. An explicit clock mode overrides the legacy POS build flag. The default Compose clock and the ordinary seed keep the fixed 2026-11-17 fixture.

## Prepare and run

Run these commands from `backend/`. The generator requires OpenSSL and creates local throwaway credentials and an ES256 signing key. It preserves existing files. `.env.local` is optional configuration for the demo route and frontend source. Save credentials only in the ignored `.secrets/` directory. Compose mounts only the files each runtime needs.

```sh
./infra/local-secrets.sh
docker compose --env-file .env.local -p navis-backend-local --profile tools build
docker compose --env-file .env.local -p navis-backend-local up -d --wait db redis
docker compose --env-file .env.local -p navis-backend-local run --rm --build tools npm run migrate
docker compose --env-file .env.local -p navis-backend-local exec -T db /docker-entrypoint-initdb.d/20-stream-access.sh
docker compose --env-file .env.local -p navis-backend-local exec -T db /docker-entrypoint-initdb.d/30-phase3-access.sh
docker compose --env-file .env.local -p navis-backend-local run --rm tools npm run seed
docker compose --env-file .env.local -p navis-backend-local up -d --wait
```

The default build serves the frontend placeholder. After the HTTP catalog is integrated, build the SPA and enable local demo issuance with the command below. From `frontend/`, `npm run dev` serves the fixture app, and `server/serve.mjs` remains available as a direct Node HTTP development harness.

```sh
NAVIS_BACKEND_DEMO_AUTH=1 VITE_NAVIS_DATA_SOURCE=http docker compose --env-file .env.local -p navis-backend-local up -d --build --wait
```

The DB image initializes the six named databases and schemas when the local volume is empty. Each service has a `<service>_mig` schema owner and a `<service>_run` login. The service migrations grant access to specific tables and sequences. Migrations and seeds run as separate tools invocations. You can target one service by appending `-- account` or `-- inventory` to the npm command. The CLI reports which services have no migration or seed files.

For an existing fixture volume initialized with the previous role names, use the same Compose project and volume suffix. Stop app workloads, run `./infra/local-secrets.sh`, and recreate only the DB container with `docker compose --env-file /dev/null up -d --wait --force-recreate db`. Run `docker compose --env-file /dev/null exec -T db /docker-entrypoint-initdb.d/10-service-databases.sh --upgrade-local-roles` before restarting the workloads. This renames the local roles in place, preserving ownership, grants and RLS policies, and sets their passwords from the new local files. Follow the Phase ③ grant steps below for stream and worker access.

## Reset the disposable local fixture

The account seed inserts the synthetic café owner, store and membership plus a separate synthetic comparison store and owner. Inventory inserts the café menu from the SPA's generated fixture and a distinct catalog item for the comparison store. Both seeds are safe to rerun. Existing rows survive a rerun, so a changed generator snapshot or locally edited seed row requires a fresh volume to restore parity.

Run this only when you intend to discard all databases and demo sessions in the fixture volume. The example uses Phase ① settings. Keep `NAVIS_LOCAL_VOLUME_SUFFIX` set to the same value as the running project if it uses a suffix. For Phase ③, follow the Phase ③ private runtime setup below after replacing the DB volume so the grants and smoke fixtures are reapplied.

```sh
docker compose --env-file /dev/null -p navis-backend-local --profile streams --profile phase3 stop
docker compose --env-file /dev/null -p navis-backend-local rm -f db
docker volume rm "navis-backend-local_db-data${NAVIS_LOCAL_VOLUME_SUFFIX:-}"
docker compose --env-file /dev/null -p navis-backend-local up -d --wait db
docker compose --env-file /dev/null -p navis-backend-local run --rm --build tools npm run migrate
docker compose --env-file /dev/null -p navis-backend-local run --rm tools npm run seed
NAVIS_BACKEND_DEMO_AUTH=1 VITE_NAVIS_DATA_SOURCE=http docker compose --env-file /dev/null -p navis-backend-local up -d --build --wait
```

## Checks and teardown

```sh
curl -fsS http://127.0.0.1:18180/
curl -fsS -i http://127.0.0.1:18180/api/healthz
curl -fsS -i http://127.0.0.1:18180/api/readyz
node test/compose/navis-browser-smoke.mjs
docker compose --env-file .env.local -p navis-backend-local logs --no-color edge api-gateway
docker compose --env-file .env.local -p navis-backend-local --profile test --profile tools down
```

Run the backend test setup below before invoking Vitest. The test profile starts a separate PostgreSQL instance with disposable storage and separate role passwords. Vitest connects to `test-db` and exercises the six DBs with real runtime and migration logins, plus versioned SQL migration apply, retry and rollback. The DB helpers select the test instance when `NODE_ENV=test`. The normal Compose volume retains local fixture data across teardown.

The seven Fastify workloads expose `/healthz` and `/readyz` on private port 3000. Service readiness checks its runtime DB connection. The gateway checks account and inventory readiness, plus insight and marketing in Phase ③. The edge uses matching probes under `/api/`. The response header `X-Request-Id` matches the `requestId` field in edge, gateway and frontend JSON logs. The insight-navis workload serves its own health and readiness probes on private port 8787 so a Navis restart does not affect gateway readiness.

The gateway routes `/api/navis/chat`, `/api/navis/widget-drafts`, `/api/navis/reply-test-*`, and `/api/navis/media/*` to the insight-owned insight-navis process. It routes `/api/promo/*` to marketing. The hosted edge checks the demo password cookie. The gateway checks the configured browser origin, preserves the public Host for Navis's same-origin check, and authenticates to marketing with a private workload token. Only the gateway can reach insight-navis from another workload. Compose sets the local origin with `NAVIS_BROWSER_API_ORIGIN` available when changing the local edge port. The versioned store APIs continue to require an owner bearer. Chat streams through both hops with buffering disabled and an idle timeout of 180 seconds.

The browser fixture routes use fake chat, drafts, media and SMS, with bundled promo media and hosted rendering disabled. Insight-navis and marketing-worker have optional `navis-providers` file mounts for A6. When conversation or AI usage persistence is enabled for insight-navis, it uses the Insight DB role.

## Service integration

- Account, inventory and the API gateway require their packaged entrypoints and fail startup if one is missing. POS and customer run from their own entrypoints. Enable Phase ③ fixtures to register Insight and Marketing routes and launch the marketing worker. Use explicit `.ts` extensions for runtime imports and `import type` for shared SPA contracts. The fixture images use Node 24 type transformation for the landed provider modules.
- Put versioned SQL under the service's `migrations/` directory, with `-- Up Migration` and `-- Down Migration` sections. Migration history belongs to `<service>.schema_migrations`. The runtime starts with its own schema on the search path. Grant only the operations used by each service and grant inventory catalog access as read-only. Export `async function seed(pool: Pool)` from the service's `seed.ts` and make inserts safe to retry. The tools image includes the canonical café generator, input and generated SPA snapshots.
- The hosted café photo seed in `packages/db/promo-cafe.ts` uses `server/promo/photo-source.mjs` and its asset catalog. Keep that module, its server dependencies and the café photo assets in the `tools` image used by the seed Job.
- Import `dbPool` and `runMigrations` from `packages/db/` in DB tests. Use the runtime role for readiness and HTTP tests, and the migration role for setup. `packages/contracts/index.ts` supplies types and Fastify JSON Schemas for the catalog request and response, access token response and error codes. Missing routes, including disabled demo issuance, return `404 NOT_FOUND`. Other Fastify request errors retain their HTTP status and use `INVALID_REQUEST`.
- Account reads `NAVIS_ACCOUNT_SIGNING_KEY_FILE` at `/run/secrets/account_signing_key.pem`. Gateway and account read `NAVIS_GATEWAY_ACCOUNT_TOKEN_FILE`. Gateway and inventory read `NAVIS_GATEWAY_INVENTORY_TOKEN_FILE`. The two gateway tokens use distinct secret files. Gateway dependencies are `NAVIS_ACCOUNT_URL` and `NAVIS_INVENTORY_URL`. The runtime DB host is `NAVIS_DB_HOST` and passwords mount as `/run/secrets/<service>_run_password`. Migration passwords mount in tools as `/run/secrets/<service>_mig_password`. PostgreSQL bootstrap passwords are scoped to their respective DB containers.


## Phase ③ private runtime

Use a fresh synthetic fixture for the integrated smoke. The volume suffix below creates independent PostgreSQL, promo storage and fake SENS state volumes under the same local project. Pick a new suffix for each full run. The edge remains at `http://127.0.0.1:18180`.

```sh
./infra/local-secrets.sh
export NAVIS_LOCAL_VOLUME_SUFFIX=-phase3
export NAVIS_PHASE3_FIXTURES=1 NAVIS_FIXTURE_SMS_ENABLED=1 NAVIS_BACKEND_DEMO_AUTH=1
export NAVIS_POS_FIXTURE_NOW=2026-11-17T06:45:00Z NAVIS_INSIGHT_FIXTURE_NOW=2026-11-17T06:45:00Z
export NAVIS_FORECAST_FIXTURE_NOW=2026-11-24T06:45:00Z NAVIS_PROMO_FIXTURE_STAGE_INTERVAL_MS=3000
export VITE_NAVIS_DATA_SOURCE=http

docker compose --env-file /dev/null --profile tools --profile streams --profile phase3 --profile forecast build
docker compose --env-file /dev/null up -d --wait db redis
docker compose --env-file /dev/null run --rm tools npm run migrate
docker compose --env-file /dev/null exec -T db /docker-entrypoint-initdb.d/20-stream-access.sh
docker compose --env-file /dev/null exec -T db /docker-entrypoint-initdb.d/30-phase3-access.sh
docker compose --env-file /dev/null run --rm tools npm run seed
docker compose --env-file /dev/null run --rm tools node test/compose/phase3-smoke.mjs --prepare
docker compose --env-file /dev/null --profile streams --profile phase3 up -d --wait
node test/compose/phase3-smoke.mjs
node test/compose/smoke.mjs
```

On an existing synthetic volume, stop the workloads, rerun secret generation, migrations, both grant scripts and the seed, then recreate the disposable Redis container with `docker compose --env-file /dev/null up -d --force-recreate --wait redis`. The relay rebuilds Streams with the expanded group list from durable outboxes and checkpoints. The grant scripts provision missing local identities and give relay access to publication columns and recovery checkpoints. The marketing worker can update durable stage/send state and stream checkpoints in its own database. Forecast cron reaches only the private Insight and Inventory APIs. Run it once using the forecast profile or on demand.

```sh
docker compose --env-file /dev/null --profile forecast run --rm forecast-cron
```

The gateway exposes the local owner routes under `/api/v1/stores/{storeId}`. Typed Navis SSE uses `POST /navis/chat` with `X-Navis-Protocol: agent-v1`. Confirm the returned proposal at `POST /navis/proposals/{proposalId}/confirm` and read its job and range-capable MP4 under `/promo/jobs/{jobId}`. The fake SMS fixture issues an owner draft via `GET /sens/test-card`. Submit that card at `POST /sens/attempts` and read its acceptance and delivery receipts at `GET /sens/attempts/{receiptId}`. The forecast for a date and model version is available under `/forecasts/{targetDate}/{modelVersion}`. Device intake uses `POST /api/v1/insight/cctv/aggregates` with a registered device bearer. Owner briefing access uses `GET /briefing/cctv`.

The promo fixture uses HCX-005 for photo metadata, HCX-007 Structured Outputs for planning, a fake Claude CLI scene seam and a prerecorded clip with deterministic media probes. The worker records model usage through the private Insight API. The SENS fixture is opt-in and persists simulated provider acceptance separately from the marketing ledger so reconciliation survives a process restart. The forecast uses the same weekday over four observed weeks, recognizes cancellations through the Insight projection and reads current inventory recipes.

### Backend and earlier-slice checks

```sh
docker compose --env-file /dev/null --profile test up -d --wait test-db test-redis
for service in pos inventory customer; do
  docker compose --env-file /dev/null run --rm tools env NODE_ENV=test npm run migrate -- "$service"
done
docker compose --env-file /dev/null exec -T test-db /docker-entrypoint-initdb.d/20-stream-access.sh
docker compose --env-file /dev/null run --rm tools npm run typecheck
docker compose --env-file /dev/null run --rm -e NAVIS_DB_HOST=test-db tools npm test -- --maxWorkers=1

node test/compose/phase2-streams.mjs
node test/compose/phase2-inventory.mjs
node test/compose/phase2-customer.mjs
```

Tests use disposable PostgreSQL and private Redis with a separate logical DB for each Phase ③ suite. Give the tests a fresh test container pair to repeat a full acceptance run. Stop the local services with `docker compose --env-file /dev/null --profile streams --profile phase3 --profile test down`. The named fixture volumes are retained.
