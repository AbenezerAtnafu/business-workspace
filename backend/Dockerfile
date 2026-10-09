# Backend API image (ADR-012). Also used for one-shot jobs from the same build:
#   migrate:   node scripts/run-migrate.js
#   dkim-sync: node scripts/export-dkim-keys.mjs --out /var/lib/rspamd/dkim --watch 60
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/database/migrations ./src/database/migrations
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
