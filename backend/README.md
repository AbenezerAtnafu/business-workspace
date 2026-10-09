# Business Workspace Platform — Backend

NestJS API implementing the modules in `claude/srs.md` §7, following the
build order in `planning/implementation-plan.md` (see the project's Claude
Project docs — this repo doesn't duplicate them).

## Build order (see planning/implementation-plan.md for the full reasoning)

1. **Phase 1 — Foundation**: control/tenant schema + RLS (`src/database/migrations`),
   Owner bootstrap, Auth & Identity, Organizational Units & Groups, User
   Management, RBAC.
2. **Phase 2 — Domains & Email core**: mail infrastructure (external to this
   repo — see `architecture/domain-and-email-flow.md`), Custom Domains,
   Mailbox provisioning, Webmail app code.
3. **Phase 3 — Workspace features**: Notifications, Audit Logs, Admin Console.
4. **Phase 4 — optional**: per-domain TLS automation.

## Getting started

### With Docker (nothing else to install)

```bash
docker compose up --build          # Postgres + migrations + API on :3000
```

- The API runs `nest start --watch`; `./src` is mounted, so edits reload.
- Postgres is published on **5433** (not 5432), so it can't clash with one already on your machine:
  `psql postgres://postgres:postgres@localhost:5433/business_workspace`.
- App email (invites, password resets) is caught by Mailpit: http://localhost:8025.
- `docker compose run --rm migrate` applies new migrations; `docker compose down -v` wipes the database.
- `GET /api/v1/health` returns `{"status":"ok","database":"ok"}` (503 if Postgres is unreachable).

### Without Docker

```bash
cp .env.example .env    # DATABASE_URL, APP_DATABASE_URL, APP_BOOTSTRAP_DATABASE_URL, secrets
pnpm install
pnpm migrate            # applies src/database/migrations/*.sql in order (scripts/run-migrate.js)
pnpm start:dev
```

### Tests against a running API

- `pnpm test:live` runs the API suite. It reads invite links from the dev mailer log (`API_LOG`), or from Mailpit when `MAILPIT_URL` is set.
- `pnpm test:mail` runs the mail-server suite against the mail stack in `../infra`.

### Image

`Dockerfile` has two targets:

- `dev`: what `docker-compose.yml` uses.
- `prod` (default): compiled `dist` and production dependencies only, run as the `node` user, with a healthcheck.

The same prod image runs the one-shot jobs:

- `node scripts/run-migrate.js`
- `node scripts/export-dkim-keys.mjs`

Behind a reverse proxy, set `TRUST_PROXY` (see `.env.example`). Otherwise every client shares the proxy's IP for rate limiting.

The full stack with the mail server is in `../infra/compose`.

## Module map

Each folder under `src/modules/` corresponds to one SRS §7 module and one
`architecture/api-contract.md` section — see the comment at the top of each
module file.
