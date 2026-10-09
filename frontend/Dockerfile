# Frontend image (ADR-012). Targets:
#   dev   — `next dev` with all dependencies; mount the source for hot reload
#           (docker-compose.yml in this repo does that)
#   prod  — Next.js standalone server only (no node_modules tree), runs as
#           `node` (default target; what infra/compose deploys)
#
# NEXT_PUBLIC_API_BASE_URL is inlined into the browser bundle at BUILD time
# (Next.js does that for every NEXT_PUBLIC_* value), so it is a build
# argument: the API origin as the browser reaches it, without /api/v1.
# Changing it means rebuilding the image, not just restarting it.
#
# NODE_IMAGE is an argument only so the image can be built against a mirror
# or a locally built base; leave it at the default otherwise.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm npm ci

# --- dev: source is bind-mounted at run time ---------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3001
# Port fixed here, not taken from package.json's "dev" script, so a local
# port choice there (e.g. -p 3004) can't break the compose port mapping.
CMD ["npx", "next", "dev", "-p", "3001"]

# --- build ---------------------------------------------------------------------
FROM deps AS build
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL NEXT_OUTPUT=standalone
COPY . .
RUN npm run build && mkdir -p public

# --- prod ----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
