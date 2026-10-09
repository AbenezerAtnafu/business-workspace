# infra — running Business Workspace

Everything needed to run the platform reproducibly, from a laptop to one
production VM (ADR-012). Two levels:

| What | Where | Use it for |
|---|---|---|
| One repo at a time | `backend/docker-compose.yml`, `frontend/docker-compose.yml` | day-to-day development with hot reload |
| The whole platform | `infra/compose/docker-compose.yml` | the mail server, a shared dev server, a single-VM deployment |
| Mail stack without Docker | `infra/scripts/native-up.sh` | an Ubuntu 24.04 VM or CI runner with no Docker |

Every way of running the mail daemons renders their config with
`infra/mail/render.sh` from `infra/mail/templates/`. That is why a test that
passes natively also holds in the images.

## Laptop: one repo at a time

```bash
cd backend  && docker compose up --build    # Postgres :5433, API :3000, Mailpit :8025
cd frontend && docker compose up --build    # web :3001 → API at localhost:3000
```

## Whole platform

```bash
cd infra/compose
cp .env.example .env            # every secret must change outside a throwaway laptop stack
docker compose up -d --build
docker compose ps               # api, web, postgres, postfix, dovecot report (healthy)
```

| Service | What it is |
|---|---|
| postgres | the one database. `migrate` runs all migrations once and exits; everything else waits for it |
| api | NestJS, prod image. App email goes through Postfix on the internal port 10025 |
| web | Next.js standalone server. `PUBLIC_API_URL` is baked in at build time |
| postfix / dovecot / rspamd / redis | the mail server. Ports 25, 587, 143, 993 and 995 are published; 10025 is internal only |
| dkim-sync | writes each verified domain's DKIM key for Rspamd every 60 s. Files are 0640, group 5001 = `_rspamd` |
| mailpit | development relay: catches all outbound mail. UI on :8025 |
| clamav | optional antivirus: `docker compose --profile av up -d` and set `CLAMAV_MILTER` (not yet tested) |

On a laptop, port 25 is often taken or blocked. Set `SMTP_PORT=2525` in `.env`.

### Verifying a running stack

From `backend/`:

```bash
# API suite (203 checks). Through a published port the API sees the Docker
# gateway address, hence LIVE_TEST_CLIENT_IPS.
API_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 \
LIVE_TEST_CLIENT_IPS=172.28.0.1,::ffff:172.28.0.1 \
DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@<postgres reachable from here>/business_workspace \
  pnpm test:live

# Mail suite (38 checks). It needs the internal port 10025, so it runs inside
# the compose network.
docker run --rm --network business-workspace_internal \
  -v business-workspace_dkim-keys:/dkim -v "$PWD/scripts:/app/scripts:ro" \
  -e API_URL=http://api:3000 -e MAIL_HOST=postfix -e MAIL_IMAP_HOST=dovecot \
  -e MAILPIT_URL=http://mailpit:8025 -e DKIM_KEY_DIR=/dkim -e DKIM_KEY_GROUP=5001 \
  -e DATABASE_URL=postgres://postgres:<pw>@postgres:5432/business_workspace \
  -e DKIM_EXPORT_DATABASE_URL=postgres://dkim_exporter:<pw>@postgres:5432/business_workspace \
  -e ENCRYPTION_KEY=<same as .env> -e DOVECOT_MASTER_PASSWORD=<same as .env> \
  "$(docker build -q --target dev .)" node scripts/mail-live-test.mjs
```

Postgres isn't published by default. For the API suite, add
`ports: ["5434:5432"]` to it in a `docker-compose.override.yml`, or run the
suite in the network like the mail suite.

## Going live (one VM)

1. **Server**: Ubuntu 24.04 with a static IPv4. Run
   `sudo MAIL_HOSTNAME=mail.example.com ACME_EMAIL=ops@example.com infra/server/bootstrap-ubuntu.sh`.
   It installs Docker, sets up ufw, gets a Let's Encrypt certificate and installs the renewal hook.
2. **Provider**:
   - Set reverse DNS (PTR) for the IP to `MAIL_HOSTNAME`.
   - Ask for outbound port 25 to be unblocked. Most clouds block it by default.
3. **Platform DNS**:
   - A record `MAIL_HOSTNAME` → server IP.
   - SPF for `MAIL_HOSTNAME` itself.
   - Customers' MX, SPF, DKIM and DMARC records are per domain; the app's DNS instructions screen gives them those.
4. **Relay** (the bootstrap period, ADR-002):
   - Create an SES (or similar) SMTP account.
   - Set `RELAY_HOST`, `RELAY_USER` and `RELAY_PASSWORD` in `.env`, with `RELAY_TLS_LEVEL=encrypt`.
   - Remove `mailpit` from the stack.
5. **Secrets**:
   - Generate every value in `.env` (`openssl rand -base64 32`).
   - Migrations create the DB roles with dev passwords, so run `ALTER ROLE … PASSWORD` for `app_user`, `app_bootstrap`, `mail_reader` and `dkim_exporter` to match `.env`.
   - `ENCRYPTION_KEY` can never change once data exists.
6. **HTTPS for the app**:
   - Put a reverse proxy (Caddy or nginx) on :443 in front of `web` and `api`. It is **not part of the compose file yet**.
   - Set `COOKIE_SECURE=true` and `TRUST_PROXY=1`.
   - The app and the API must be same-site, for example `app.example.com` and `api.example.com`.
7. **Reputation**:
   - Register the IP and domain with Google Postmaster Tools and Microsoft SNDS.
   - Warm the IP up gradually before moving off the relay.

## Images

| Dockerfile | Targets | Base |
|---|---|---|
| `backend/Dockerfile` | `dev`, `prod` (default) | `node:22-bookworm-slim` |
| `frontend/Dockerfile` | `dev`, `prod` (default) | `node:22-bookworm-slim` |
| `infra/mail/Dockerfile` | `postfix`, `dovecot`, `rspamd` | `ubuntu:24.04` |

Each base image is an argument: `NODE_IMAGE` or `UBUNTU_IMAGE`. Pass one only
to build against a registry mirror or a locally built base. All of them were
built and run on 2026-10-09 against locally built stand-in bases, because
Docker Hub was unreachable from the build environment. The first build
against the real Docker Hub bases should be checked the same way, with the
two test suites above.
