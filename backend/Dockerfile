FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node-base

FROM node-base AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=navis-backend-npm,sharing=locked \
    npm ci --ignore-scripts --no-audit --no-fund

FROM node-base AS production-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=navis-backend-npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node-base AS workload-source
COPY backend/services/ /runtime/services/
COPY backend/gateway/ /runtime/gateway/
COPY backend/relay/ /runtime/relay/
COPY backend/packages/ /runtime/packages/
COPY backend/workers/ /runtime/workers/
RUN find /runtime -type d \( -name migrations -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find /runtime -type f \( -name '*.test.*' -o -name '*.test-cases.*' -o -name '*.spec.*' -o -name 'compose-test.*' -o -name 'compose-proof.*' -o -name 'seed.ts' -o -name 'README.md' \) -delete

FROM node-base AS fixture-source
COPY frontend/server/ /runtime/server/
COPY frontend/shared/ /runtime/shared/
# Phase ③ uses shared server modules and a few test helpers as local providers.
RUN find /runtime -type f \( -name '*.test.*' -o -name '*.test-cases.*' -o -name '*.spec.*' \) -delete

FROM fixture-source AS insight-navis-source
RUN rm -rf /runtime/server/dev /runtime/server/promo/dev /runtime/server/promo/test \
    /runtime/server/promo/references/tools /runtime/server/dev-host.mjs /runtime/server/preview.mjs \
    /runtime/server/vite-plugin.* /runtime/server/navis/scenario-fixtures.mjs \
    /runtime/server/promo/smoke.mjs /runtime/server/media/smoke.mjs

FROM node-base AS insight-navis
WORKDIR /app
ENV NODE_ENV=production NAVIS_PORT=8787 NAVIS_PROMO_DIR=/tmp/navis-promo \
    NAVIS_AGENT_MODE=fixture NAVIS_WIDGET_MODE=fake \
    NAVIS_PROMO_HCX_PILOT=false NAVIS_PROMO_SCENE_PROVIDER=claude
COPY --from=insight-navis-source /runtime/server/ ./server/
COPY --from=insight-navis-source /runtime/shared/ ./shared/
COPY frontend/src/data/marketing/promo-catalog.json ./src/data/marketing/
COPY frontend/src/data/db/generated/manifest.json frontend/src/data/db/generated/widget-drafts.json ./src/data/db/generated/
# The fixture runtime uses Node built-ins. Hosted video render tools are an A6 dependency.
VOLUME ["/tmp"]
EXPOSE 8787
USER 1000:1000
CMD ["node", "server/serve.mjs"]

FROM node-base AS backend-runtime
WORKDIR /app/backend
ENV NODE_ENV=production
COPY --from=production-deps /app/backend/node_modules/ ./node_modules/
COPY backend/package.json ./
COPY backend/infra/http.ts ./infra/
COPY backend/infra/browser-api.ts ./infra/
COPY backend/packages/contracts/index.ts ./packages/contracts/index.ts
COPY backend/packages/contracts/replay-clock.ts ./packages/contracts/replay-clock.ts
COPY backend/packages/db/index.ts ./packages/db/index.ts
USER node

FROM backend-runtime AS api-gateway
COPY backend/infra/entrypoint.ts ./infra/
COPY --from=workload-source /runtime/gateway/ ./gateway/
CMD ["node", "infra/entrypoint.ts", "api-gateway"]

FROM backend-runtime AS account
COPY backend/infra/entrypoint.ts ./infra/
COPY --from=workload-source /runtime/services/account/ ./services/account/
COPY frontend/server/media/errors.mjs frontend/server/media/validation.mjs /app/frontend/server/media/
USER root
RUN install -d -o node -g node /var/lib/navis/promo
USER node
CMD ["node", "infra/entrypoint.ts", "account"]

FROM backend-runtime AS streams-runtime
COPY backend/packages/contracts/events.ts ./packages/contracts/events.ts
COPY backend/packages/contracts/workload-read.ts ./packages/contracts/workload-read.ts
COPY --from=workload-source /runtime/packages/approvals/ ./packages/approvals/
COPY --from=workload-source /runtime/packages/streams/ ./packages/streams/

FROM streams-runtime AS fixture-runtime
ENV NODE_OPTIONS="--experimental-transform-types --disable-warning=ExperimentalWarning"
COPY --from=fixture-source /runtime/server/ /app/frontend/server/
COPY --from=fixture-source /runtime/shared/ /app/frontend/shared/
COPY frontend/src/data/marketing/promo-catalog.json /app/frontend/src/data/marketing/
COPY frontend/src/data/db/generated/manifest.json frontend/src/data/db/generated/widget-drafts.json /app/frontend/src/data/db/generated/
COPY backend/packages/contracts/promo-photos.ts ./packages/contracts/promo-photos.ts

FROM streams-runtime AS inventory
COPY backend/infra/entrypoint.ts ./infra/
COPY --from=workload-source /runtime/services/inventory/ ./services/inventory/
COPY --from=workload-source /runtime/services/account/naver/ ./services/account/naver/
COPY --from=workload-source /runtime/packages/naver/ ./packages/naver/
COPY frontend/server/sens-sms.mjs /app/frontend/server/
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "infra/entrypoint.ts", "inventory"]

FROM streams-runtime AS pos
COPY --from=workload-source /runtime/services/pos/ ./services/pos/
COPY --from=workload-source /runtime/workers/pos-receipts/ ./workers/pos-receipts/
COPY --from=workload-source /runtime/services/account/naver/wire.ts /runtime/services/account/naver/commerce.ts ./services/account/naver/
COPY --from=workload-source /runtime/packages/naver/ ./packages/naver/
CMD ["node", "services/pos/index.ts"]

FROM streams-runtime AS customer
COPY --from=workload-source /runtime/services/customer/ ./services/customer/
COPY --from=workload-source /runtime/services/account/identity.ts ./services/account/identity.ts
COPY --from=workload-source /runtime/services/account/naver/wire.ts /runtime/services/account/naver/oauth.ts /runtime/services/account/naver/persona-grants.ts ./services/account/naver/
COPY --from=workload-source /runtime/packages/naver/ ./packages/naver/
CMD ["node", "services/customer/index.ts"]

FROM backend-runtime AS naver-virtual
COPY --from=workload-source /runtime/services/naver-virtual/ ./services/naver-virtual/
COPY --from=workload-source /runtime/packages/naver/ ./packages/naver/
COPY frontend/server/media/errors.mjs frontend/server/media/validation.mjs /app/frontend/server/media/
COPY db/seed/ansungjalbu/content.json /app/db/seed/ansungjalbu/
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "services/naver-virtual/index.ts"]

FROM fixture-runtime AS marketing
COPY --from=workload-source /runtime/services/marketing/ ./services/marketing/
COPY --from=workload-source /runtime/services/account/identity.ts ./services/account/identity.ts
COPY --from=workload-source /runtime/services/account/naver/wire.ts /runtime/services/account/naver/oauth.ts /runtime/services/account/naver/persona-grants.ts ./services/account/naver/
COPY --from=workload-source /runtime/services/insight/naver/ ./services/insight/naver/
COPY --from=workload-source /runtime/services/insight/scope.ts ./services/insight/scope.ts
COPY --from=workload-source /runtime/packages/naver/ ./packages/naver/
COPY --from=workload-source /runtime/workers/marketing-worker/promo/clients.ts ./workers/marketing-worker/promo/clients.ts
CMD ["node", "services/marketing/index.ts"]

FROM fixture-runtime AS insight
COPY --from=workload-source /runtime/services/insight/ ./services/insight/
COPY --from=workload-source /runtime/packages/naver/ ./packages/naver/
CMD ["sh", "-ec", "if [ \"$NAVIS_PHASE3_FIXTURES\" = 1 ]; then export NAVIS_INSIGHT_AGENT_MODE=fixture NAVIS_MARKETING_BASE_URL=http://marketing:3000 NAVIS_INSIGHT_MARKETING_TOKEN_FILE=/run/secrets/insight_marketing_token NAVIS_GATEWAY_INSIGHT_TOKEN_FILE=/run/secrets/gateway_insight_token NAVIS_FORECAST_INSIGHT_TOKEN_FILE=/run/secrets/forecast_insight_token NAVIS_PROMO_INSIGHT_TOKEN_FILE=/run/secrets/promo_insight_token NAVIS_INSIGHT_REDIS_PASSWORD_FILE=/run/secrets/insight_redis_password; fi; exec node services/insight/index.ts"]

FROM fixture-runtime AS marketing-worker
COPY --from=workload-source /runtime/services/account/identity.ts ./services/account/identity.ts
COPY --from=workload-source /runtime/services/marketing/ ./services/marketing/
COPY --from=workload-source /runtime/packages/naver/ ./packages/naver/
COPY --from=workload-source /runtime/workers/marketing-worker/ ./workers/marketing-worker/
USER root
RUN install -d -o node -g node /var/lib/navis/fake-sens
USER node
CMD ["node", "workers/marketing-worker/index.ts"]

FROM backend-runtime AS forecast-cron
COPY --from=workload-source /runtime/workers/forecast-cron/ ./workers/forecast-cron/
CMD ["node", "workers/forecast-cron/index.ts"]

FROM streams-runtime AS relay
COPY --from=workload-source /runtime/relay/ ./relay/
CMD ["node", "relay/index.mjs"]

FROM backend-deps AS tools
COPY backend/tsconfig.json backend/vitest.config.ts ./
COPY backend/infra/ ./infra/
COPY backend/packages/ ./packages/
COPY backend/services/ ./services/
COPY backend/gateway/ ./gateway/
COPY backend/relay/ ./relay/
COPY backend/test/ ./test/
COPY backend/workers/ ./workers/
# The hosted café photo seed imports frontend/server/promo/photo-source.mjs from this tree.
COPY frontend/server/ ../frontend/server/
COPY frontend/public/menu-photos/ ../frontend/public/menu-photos/
COPY frontend/shared/ ../frontend/shared/
COPY frontend/src/catalog/ ../frontend/src/catalog/
COPY frontend/src/contracts/ ../frontend/src/contracts/
COPY frontend/src/i18n/ ../frontend/src/i18n/
COPY frontend/src/layout/ ../frontend/src/layout/
COPY frontend/src/state/ ../frontend/src/state/
COPY frontend/src/data/ ../frontend/src/data/
COPY frontend/src/orders/ ../frontend/src/orders/
COPY frontend/src/pos/ ../frontend/src/pos/
COPY db/seed/ansungjalbu/generate.mjs db/seed/ansungjalbu/content.json ../db/seed/ansungjalbu/
RUN ln -s /app/backend/node_modules /app/node_modules && chown node:node /app/backend
USER node

FROM node-base AS frontend-build
ARG VITE_NAVIS_DATA_SOURCE=placeholder
ARG VITE_NAVIS_CLOCK=
ARG VITE_NAVIS_POS_CLOCK=
ARG VITE_NAVIS_FIXTURE_END_DATE=
ARG VITE_NAVIS_REPLAY_INSTANT=
ENV VITE_NAVIS_REPLAY_INSTANT=${VITE_NAVIS_REPLAY_INSTANT}
ENV VITE_NAVIS_CLOCK=${VITE_NAVIS_CLOCK} VITE_NAVIS_FIXTURE_END_DATE=${VITE_NAVIS_FIXTURE_END_DATE}
RUN --mount=type=bind,target=/source \
    --mount=type=cache,target=/root/.npm,id=navis-backend-npm,sharing=locked \
    case "$VITE_NAVIS_POS_CLOCK" in \
      ''|real) ;; \
      *) printf '%s\n' 'VITE_NAVIS_POS_CLOCK must be empty or real' >&2; exit 1 ;; \
    esac \
    && case "$VITE_NAVIS_CLOCK" in \
      '') ;; \
      fixed) export VITE_NAVIS_POS_CLOCK= ;; \
      real) export VITE_NAVIS_POS_CLOCK=real ;; \
      *) printf '%s\n' 'VITE_NAVIS_CLOCK must be empty, fixed or real' >&2; exit 1 ;; \
    esac \
    && mkdir /site \
    && case "$VITE_NAVIS_DATA_SOURCE" in \
      placeholder) cp /source/backend/infra/frontend/index.html /site/ ;; \
      fixture|http) \
        mkdir /build \
        && cp -R /source/frontend/package.json /source/frontend/package-lock.json /source/frontend/index.html \
                 /source/frontend/vite.config.ts /source/frontend/src /source/frontend/public /source/frontend/server /source/frontend/shared /build/ \
        && cd /build \
        && npm ci --no-audit --no-fund \
        && npm run build -- --outDir /site \
        && cd / && rm -rf /build ;; \
      *) printf '%s\n' 'VITE_NAVIS_DATA_SOURCE must be placeholder, fixture or http' >&2; exit 1 ;; \
    esac

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236 AS nginx-base

FROM nginx-base AS frontend
COPY backend/infra/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /site/ /usr/share/nginx/html/

FROM nginx-base AS edge
COPY backend/infra/edge/nginx.conf /etc/nginx/conf.d/default.conf
COPY backend/infra/edge/api-proxy.inc /etc/nginx/navis-api-proxy.inc
