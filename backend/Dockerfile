# Backend API image (ADR-012). Targets:
#   dev   — all dependencies, `nest start --watch`; mount ./src for hot reload
#           (docker-compose.yml in this repo does that)
#   prod  — compiled dist + production dependencies only, runs as `node`
#           (default target; what infra/compose deploys)
# One-shot jobs run from the same prod image with a different command:
#   migrate:   node scripts/run-migrate.js
#   dkim-sync: node scripts/export-dkim-keys.mjs --out /var/lib/rspamd/dkim --watch 60
#
# NODE_IMAGE is an argument only so the image can be built against a mirror
# or a locally built base; leave it at the default otherwise.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=10.28.0
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# --- all dependencies (cached until package.json / the lockfile change) -----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# --- dev: source is bind-mounted over /app/src at run time ------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
CMD ["pnpm", "start:dev"]

# --- build: compile, then drop dev dependencies -----------------------------
FROM deps AS build
COPY . .
RUN pnpm build && pnpm prune --prod

# --- prod ---------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src/database/migrations ./src/database/migrations
# Attachment staging (Step 2.4) — a volume in compose; owned by `node` so the
# API can write to it when the volume is first created from the image.
RUN mkdir -p /var/lib/bw/attachments && chown node:node /var/lib/bw/attachments
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main"]
