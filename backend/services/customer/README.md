# Customer Phase ② fixture

Customer keeps a versioned first-order booking claim or a count-membership use in PostgreSQL. It commits the hold before calling POS over private HTTP and returns the stable approval key after POS confirms the binding. A repeated reservation request with the same actor, source, version and `Idempotency-Key` returns the existing claim. The approval key goes on both POS approval requests.

All routes below are under `/internal/v1/customer/stores/{storeId}`. Use the scoped gateway bearer credential and matching `X-Navis-Store-Id`, `X-Navis-Store-Role: owner` and `X-Navis-User-Id` headers from the verified session.

| Method and path | Request and result |
| --- | --- |
| POST `/reservations/{id}/first-order-claim` | `{sourceVersion}` and `Idempotency-Key`. Holds the booking at that version. |
| POST `/reservations/{id}/cancel` | `{sourceVersion}` and `Idempotency-Key`. Cancels the booking when the version is current and no first-order claim is held or linked. |
| POST `/memberships/{id}/use-claim` | `{sourceVersion}` and `Idempotency-Key`. Reserves one available count use and returns its stable `claimId`. |
| GET `/claims/{id}` | Reads the persisted claim. |
| POST `/claims/{id}/reconcile` | `{}`. Retries a missing bind and checks the durable POS result. |
| POST `/claims/{id}/abort` | `{}`. Requests the POS terminal fence. A committed POS approval still settles its original claim. |

Claim writes return HTTP 202 while held and HTTP 200 after a terminal result. A held response without `commandKey` means the bind still needs confirmation. Repeat the original request or call reconcile. A missing or pending POS outcome keeps the hold. A durable rejection or abort releases it once. The customer consumer can also commit a recognized sale directly from `pos.sale_recognized.v1`. Booking finalization records both the first order and bill and increments the booking version.

The count-membership fixture covers the contributing allocations of one settlement. POS currently marks all allocations as contributing through its sale lines. When it supplies `membershipContributions`, customer uses the listed whole allocations. Customer tracks their quantities across cancellations, including zero-won allocations. The last applicable cancellation restores one use. Prepared-goods refunds keep the use. Contribution changes, correction dedupe, inbox and checkpoints share the consumer transaction. POS owns open-day eligibility and the money ledger.

The local owner workflow handles contention with HTTP 409 and retains a pending hold until POS confirms its result. Booking archive eligibility is a synthetic snapshot. Membership eligibility is based on the active count balance, the version and the 05:00 Asia/Seoul business day. The owner session identifies the claimant. Recovery runs through the same-store owner routes and the customer consumer.

## Local Compose

Run from `backend` with the existing local tool image and synthetic secrets from `./infra/local-secrets.sh`. The acceptance suite creates a separate disposable PostgreSQL and Redis pair without publishing ports.

```sh
node test/compose/phase2-customer.mjs
node test/compose/phase2-customer.mjs --backend-checks
```

For the shared local runtime, the default migration command includes customer. To apply only the customer migration, select it explicitly. The migration credential stays in the tools container.

```sh
docker compose --env-file /dev/null -p navis-backend-local run --rm --pull never tools npm run migrate -- customer
```

Compose supplies `NAVIS_DB_HOST`, `NAVIS_GATEWAY_CUSTOMER_TOKEN_FILE`, `NAVIS_POS_URL`, `NAVIS_CUSTOMER_POS_TOKEN_FILE` and `NAVIS_REDIS_URL`. The customer runtime uses mounted PostgreSQL and Redis credentials. A fixed `NAVIS_CUSTOMER_FIXTURE_NOW` can pin the eligibility date when running against a fixed POS fixture clock. Relay and consumer defaults are in [the Phase ② Streams README](../../relay/README.md).
