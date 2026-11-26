# BizPilot AI — production image (app + PostgreSQL in docker-compose)
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Static pages read the plan catalogue, so a database must be reachable at build
# time; docker-compose passes it in. `|| true` keeps an offline build working and
# the pages then render on demand.
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* && useradd -m -u 1001 bizpilot
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/sql ./sql
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/public ./public
COPY --from=builder /app/tsconfig.json ./tsconfig.json
RUN mkdir -p data/uploads && chown -R bizpilot:bizpilot /app
USER bizpilot
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
