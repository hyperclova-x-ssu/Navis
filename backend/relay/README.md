# Local Phase ② Streams

Run these commands from `backend`. The relay uses the private `data` and `cache` networks. Only the edge publishes a loopback port.

```sh
./infra/local-secrets.sh
docker compose -p navis-backend-local --profile tools --profile streams build tools relay
docker compose -p navis-backend-local up -d --wait db
docker compose -p navis-backend-local run --rm tools npm run migrate -- pos
docker compose -p navis-backend-local run --rm tools npm run seed -- pos
docker compose -p navis-backend-local exec -T db /docker-entrypoint-initdb.d/20-stream-access.sh
docker compose -p navis-backend-local --profile streams up -d --wait relay
```

Run the same grant setup on an existing volume after each new outbox migration. The bootstrap creates the relay logins and consumer tables on fresh volumes. The grant script detects an inventory outbox once T-308 supplies it. Each relay login can connect only to its own DB. Producers grant outbox reads and updates to three delivery-status columns. Consumer DBs grant the relay reads of that service group's checkpoints. Each Redis identity has key-scoped command permissions.

To run the private POS HTTP fixture after migration and seed, set these Compose inputs before starting `pos`:

```sh
NAVIS_POS_FIXTURE_NOW=2026-11-17T06:45:00Z \
NAVIS_GATEWAY_POS_TOKEN_FILE=/run/secrets/gateway_pos_token \
NAVIS_CUSTOMER_POS_TOKEN_FILE=/run/secrets/customer_pos_token \
docker compose -p navis-backend-local up -d --wait pos
```

## Local recovery defaults

- One retained stream per producer, `navis.pos.0` and `navis.inventory.0`. POS requires `inventory` and `customer` checkpoints. Inventory requires `pos`. Service-owned consumers register in T-308 and T-309. The relay preserves their backlog from sequence one until each registers progress.
- The relay holds a failed head with its existing event ID and retries after 250 ms exponential backoff, capped at 30 seconds. Earlier unpublished rows fence successors within each producer and scope. Other scopes remain eligible.
- Consumers reclaim pending deliveries after one second idle and permit five handler attempts. They commit effects, inbox state and checkpoints together. Permanent errors and exhausted attempts retain the envelope and failure code in the consumer DB. The Redis DLQ notification contains the event ID, sequence, scope and error code. It can be delivered more than once.
- Redis keeps no durable local state. A missing stream or epoch triggers an exclusive producer rebuild. The relay recreates the groups and publishes retained events after the earliest required group's checkpoint for each scope. A group with no checkpoint starts at zero. Original IDs remain unchanged. The relay stops publishing to the affected stream until its rebuilt epoch is ready. No automatic trim runs locally.
- W5 decisions cover required production groups, retry thresholds, repair and replay authority, retention, Redis durability and HA, and PostgreSQL restore objectives.

## Consumer interface

Instantiate `StreamConsumer` with the service's runtime pool, producer, group, replica name, authenticated Redis connection from `connectStreams`, and handlers keyed by the complete event type. Use `run(signal)` for a long-running consumer and pass a different name for each replica. The runner sets the store context and supplies its PostgreSQL transaction to the handler. Validate the event payload in the handler and apply business idempotency there. Throw `PermanentStreamError` with a stable error code for a definitive rejection. The runner advances the checkpoint for irrelevant types and quarantines unsupported versions of registered event families.

After repairing a handler or its prerequisite state, call `consumer.replay(scopeKey, eventId)` under the affected service's runtime identity. It processes the original quarantined head and releases pending successors after commit. PostgreSQL keeps quarantined envelopes recoverable across Redis loss.

Run the Compose acceptance with `node test/compose/phase2-streams.mjs` after building the tools image. It uses disposable PostgreSQL and Redis services within `navis-backend-local`.
