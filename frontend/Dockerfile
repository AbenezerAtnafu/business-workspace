# Frontend image (ADR-012). NEXT_PUBLIC_API_BASE_URL is baked in at build time
# (Next.js inlines NEXT_PUBLIC_* values), so pass it as a build argument.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app ./
USER node
EXPOSE 3001
CMD ["npx", "next", "start", "-p", "3001"]
