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
│   ├── marketing/               // 쿠폰·홍보 영상 작업 상태, SENS 테스트 문자 원장
│   └── insight/                 // Navis 대화(HCX-005), 매출 집계, CCTV 5분 집계, AI 사용량 기록
│       └── */migrations/        //   서비스별 SQL 마이그레이션
├── workers/
│   ├── pos-receipts/            // 입고 영수증 이벤트 소비 → POS 지출 후보로 기록
│   ├── marketing-worker/        // 홍보 영상 생성·문자 발송 작업 실행, 실패 재시도와 결과 맞추기
│   └── forecast-cron/           // 하루 한 번 도는 재고 수요 예측 (같은 요일 4주 판매 × 레시피)
├── relay/                       // outbox-relay: 각 서비스 DB의 outbox를 Redis Streams로 옮김
├── packages/
│   ├── contracts/               // 서비스·화면이 공유하는 API·이벤트 타입
│   ├── db/                      // DB 연결, 역할별 접속, 마이그레이션·시드 CLI
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

Docker Desktop runs the edge, static frontend, API gateway, six Fastify workloads, PostgreSQL 17.11 and Redis. Open `http://127.0.0.1:18180`. The edge routes `/api` and `/api/*` to the gateway and the frontend serves the SPA paths. Only the edge publishes a host port.

## Prepare and run

Run these commands from `backend/`. The generator requires OpenSSL and creates local throwaway credentials and an ES256 signing key. It preserves existing files. `.env.local` is optional configuration for the demo route and frontend source. Save credentials only in the ignored `.secrets/` directory. Compose mounts only the files each runtime needs.

```sh
./infra/local-secrets.sh
docker compose --env-file .env.local -p navis-backend-local --profile tools build
docker compose --env-file .env.local -p navis-backend-local up -d --wait db
docker compose --env-file .env.local -p navis-backend-local run --rm --build tools npm run migrate
docker compose --env-file .env.local -p navis-backend-local run --rm tools npm run seed
docker compose --env-file .env.local -p navis-backend-local up -d --wait
```

The default build serves the frontend placeholder. After the HTTP catalog is integrated, build the SPA and enable local demo issuance with the command below. The standalone fixture app still runs from `frontend/` with its existing `npm run dev`.

```sh
NAVIS_BACKEND_DEMO_AUTH=1 VITE_NAVIS_DATA_SOURCE=http docker compose --env-file .env.local -p navis-backend-local up -d --build --wait
```

The DB image initializes the six named databases and schemas when the local volume is empty. Each service has a `<service>_migrate` schema owner and a `<service>_runtime` login. The service migrations grant access to specific tables and sequences. Migrations and seeds run as separate tools invocations. You can target one service by appending `-- account` or `-- inventory` to the npm command. The CLI reports pending work for services without a migration directory or seed entrypoint.

## Reset the disposable local fixture

The account seed inserts the synthetic café owner, store and membership plus a separate synthetic comparison store and owner. Inventory inserts the café menu from the SPA's generated fixture and a distinct catalog item for the comparison store. Both seeds are safe to rerun. Existing rows survive a rerun, so a changed generator snapshot or locally edited seed row requires a fresh volume to restore parity.

Run this only when you intend to discard all databases and demo sessions in the `navis-backend-local_db-data` volume. From `backend/`, stop the project, replace that one volume, then migrate and seed the Phase ① fixture.

```sh
docker compose --env-file .env.local -p navis-backend-local stop
docker compose --env-file .env.local -p navis-backend-local rm -f db
docker volume rm navis-backend-local_db-data
docker compose --env-file .env.local -p navis-backend-local up -d --wait db
docker compose --env-file .env.local -p navis-backend-local run --rm --build tools npm run migrate -- account
docker compose --env-file .env.local -p navis-backend-local run --rm tools npm run migrate -- inventory
docker compose --env-file .env.local -p navis-backend-local run --rm tools npm run seed -- account
docker compose --env-file .env.local -p navis-backend-local run --rm tools npm run seed -- inventory
docker compose --env-file .env.local -p navis-backend-local up -d --wait
```

## Checks and teardown

```sh
docker compose --env-file .env.local -p navis-backend-local --profile test up -d --wait test-db
docker compose --env-file .env.local -p navis-backend-local --profile test run --rm tools npm run typecheck
docker compose --env-file .env.local -p navis-backend-local --profile test run --rm tools npm test
curl -fsS http://127.0.0.1:18180/
curl -fsS -i http://127.0.0.1:18180/api/healthz
curl -fsS -i http://127.0.0.1:18180/api/readyz
docker compose --env-file .env.local -p navis-backend-local logs --no-color edge api-gateway
docker compose --env-file .env.local -p navis-backend-local --profile test --profile tools down
```

The test profile starts a separate PostgreSQL instance with disposable storage and separate role passwords. Vitest connects to `test-db` and exercises the six DBs with real runtime and migration logins, plus versioned SQL migration apply, retry and rollback. The DB helpers select the test instance when `NODE_ENV=test`. The normal Compose volume retains local fixture data across teardown.

All seven Fastify workloads expose `/healthz` and `/readyz` on private port 3000. Service readiness checks its runtime DB connection. The gateway checks account and inventory readiness and has matching probes under `/api/` for the edge. The response header `X-Request-Id` matches the `requestId` field in edge, gateway and frontend JSON logs. The edge generates it and allows only the browser headers used by the API through to the gateway.

## Service integration

- Account, inventory and the API gateway require their packaged entrypoints and fail startup if one is missing. Phase ① POS, customer, marketing and insight explicitly start health-only apps from their own entrypoints. Use explicit `.ts` extensions for runtime imports and `import type` for shared SPA contracts. Node runs erasable TypeScript directly.
- Put versioned SQL under the service's `migrations/` directory, with `-- Up Migration` and `-- Down Migration` sections. Migration history belongs to `<service>.schema_migrations`. The runtime starts with its own schema on the search path. Grant only the operations used by each service and grant inventory catalog access as read-only. Export `async function seed(pool: Pool)` from the service's `seed.ts` and make inserts safe to retry. The tools image includes the canonical café generator, input and generated SPA snapshots.
- Import `dbPool` and `runMigrations` from `packages/db/` in DB tests. Use the runtime role for readiness and HTTP tests, and the migration role for setup. `packages/contracts/index.ts` supplies types and Fastify JSON Schemas for the catalog request and response, access token response and error codes.
- Account reads `NAVIS_ACCOUNT_SIGNING_KEY_FILE` at `/run/secrets/account_signing_key.pem`. Gateway and account read `NAVIS_GATEWAY_ACCOUNT_TOKEN_FILE`. Gateway and inventory read `NAVIS_GATEWAY_INVENTORY_TOKEN_FILE`. The two gateway tokens use distinct secret files. Gateway dependencies are `NAVIS_ACCOUNT_URL` and `NAVIS_INVENTORY_URL`. The runtime DB host is `NAVIS_DB_HOST` and passwords mount as `/run/secrets/<service>_runtime_password`. Migration passwords mount in tools as `/run/secrets/<service>_migrate_password` for account and inventory. PostgreSQL bootstrap passwords are scoped to their respective DB containers.
