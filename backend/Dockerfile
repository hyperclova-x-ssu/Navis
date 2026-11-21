FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node-base

FROM node-base AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=navis-backend-npm,sharing=locked \
    npm ci --ignore-scripts --no-audit --no-fund

FROM backend-deps AS production-deps
RUN npm prune --omit=dev --offline --ignore-scripts --no-audit --no-fund

FROM node-base AS workload-source
COPY backend/services/ /runtime/services/
COPY backend/gateway/ /runtime/gateway/
COPY backend/relay/ /runtime/relay/
COPY backend/packages/streams/ /runtime/packages/streams/
RUN find /runtime -type d \( -name migrations -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find /runtime -type f \( -name '*.test.*' -o -name '*.test-cases.*' -o -name '*.spec.*' -o -name 'seed.ts' -o -name 'README.md' \) -delete

FROM node-base AS backend-runtime
WORKDIR /app/backend
ENV NODE_ENV=production
COPY --from=production-deps /app/backend/node_modules/ ./node_modules/
COPY backend/package.json ./
COPY backend/infra/http.ts ./infra/
COPY backend/packages/contracts/index.ts ./packages/contracts/index.ts
COPY backend/packages/db/index.ts ./packages/db/index.ts
USER node

FROM backend-runtime AS api-gateway
COPY backend/infra/entrypoint.ts ./infra/
COPY --from=workload-source /runtime/gateway/ ./gateway/
CMD ["node", "infra/entrypoint.ts", "api-gateway"]

FROM backend-runtime AS account
COPY backend/infra/entrypoint.ts ./infra/
COPY --from=workload-source /runtime/services/account/ ./services/account/
CMD ["node", "infra/entrypoint.ts", "account"]

FROM backend-runtime AS streams-runtime
COPY backend/packages/contracts/events.ts ./packages/contracts/events.ts
COPY --from=workload-source /runtime/packages/streams/ ./packages/streams/

FROM streams-runtime AS inventory
COPY backend/infra/entrypoint.ts ./infra/
COPY --from=workload-source /runtime/services/inventory/ ./services/inventory/
CMD ["node", "infra/entrypoint.ts", "inventory"]

FROM streams-runtime AS pos
COPY --from=workload-source /runtime/services/pos/ ./services/pos/
CMD ["node", "services/pos/index.ts"]

FROM streams-runtime AS customer
COPY --from=workload-source /runtime/services/customer/ ./services/customer/
CMD ["node", "services/customer/index.ts"]

FROM streams-runtime AS marketing
COPY --from=workload-source /runtime/services/marketing/ ./services/marketing/
CMD ["node", "services/marketing/index.ts"]

FROM streams-runtime AS insight
COPY --from=workload-source /runtime/services/insight/ ./services/insight/
CMD ["node", "services/insight/index.ts"]

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
RUN --mount=type=bind,target=/source \
    --mount=type=cache,target=/root/.npm,id=navis-backend-npm,sharing=locked \
    mkdir /site \
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
