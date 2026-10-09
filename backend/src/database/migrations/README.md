# Database migrations

Raw SQL, run in this numeric order against the single Postgres instance that
holds both the `control` and `tenant` schemas (architecture/data-model.md —
"Implementation note on two databases").

Run them with:

```bash
cp .env.example .env   # fill in a real DATABASE_URL first
npm run migrate
```

`DATABASE_URL` (superuser) is for this runner only. The app's own runtime
connection is `APP_DATABASE_URL` — a separate, non-superuser role that
migration `006` creates — see that file and `src/database/database.service.ts`
for why the two must never be the same role. A third role,
`APP_BOOTSTRAP_DATABASE_URL` (migration `008`), backs a narrow, read-only,
`BYPASSRLS` connection used only for the handful of lookups that must run
before the organization is known at all — see that migration and ADR-005.

`scripts/run-migrate.js` is a small custom runner, not node-pg-migrate or
Prisma migrate — those tools expect JS/TS migration files with a paired
up/down, which doesn't fit these plain, already-reviewed `.sql` files. It
tracks what's applied in `public.schema_migrations` and only runs what's
new, so it's safe to re-run. There's no rollback support, matching how these
files are written today — a schema change ships as a new forward migration,
not an edit to 002 or 003.

| File | Implementation-plan step | Contents |
|---|---|---|
| `000_extensions_and_uuidv7.sql` | 1.1 | `citext`/`pgcrypto` extensions + the `uuidv7()` function every table's PK depends on |
| `001_control_schema.sql` | 1.1 | `control` schema: organizations, user_directory, domains, subscriptions (placeholder), audit_logs |
| `002_tenant_org_units_and_users.sql` | 1.2 | `tenant` schema: org_units (before users, since users.org_unit_id is a mandatory FK), users, then the deferred control.organizations owner FK |
| `003_tenant_core_tables.sql` | 1.5 / 1.6 / 2.3 / 2.4 / 3.1 | invites, sessions, groups, group_members, mailboxes (+ deferred primary_mailbox FK), mailbox_aliases, mailbox_access, attachment_uploads, notifications, tenant.audit_logs |
| `004_tenant_rls.sql` | 1.2 | Row-Level Security: enable + `tenant_isolation` policy on every `tenant.*` table |
| `005_tenant_auth_tokens.sql` | 1.4 | `tenant.auth_tokens` — shared table for password-reset links and MFA challenge tokens (short-lived, single-use, looked up before tenant context exists, same as `tenant.sessions`) |
| `006_app_runtime_role.sql` | 1.5 (unplanned fix) | `app_user` — a non-superuser, non-BYPASSRLS role for the app's own runtime connection, + grants + `ALTER DEFAULT PRIVILEGES` so future tables stay covered automatically. Fixes a real gap: the app had been connecting as the `postgres` superuser, which bypasses RLS unconditionally — every `tenant.*` isolation guarantee since Step 1.3 was true only because application code happened to filter correctly, not because the database was enforcing anything |
| `007_fix_uuidv7_variant_bits.sql` | 1.5 (unplanned fix) | Corrects `uuidv7()` (from `000`): the variant-bits mask was landing on the wrong byte, so every minted id had a correct version nibble but an essentially random (usually non-conformant) variant nibble — silently broke every RFC-conformant UUID validator (class-validator's `@IsUUID()` among them), though not Postgres itself. Not retroactive — ids minted before this migration keep their old, variant-noncompliant value |
| `008_app_bootstrap_role.sql` | 1.6 (unplanned fix) | `app_bootstrap` — a THIRD role (read-only, `BYPASSRLS`), distinct from both `postgres` and `app_user`, for the handful of lookups that must query a `tenant.*` table before the organization is known (refresh-token lookup, MFA challenge lookup, invite-token preview). Fixes a bug `006` exposed: once the app moved off the superuser connection, these lookups started failing with a `500` (`invalid input syntax for type uuid: ''`), not just an empty result — see the migration file and ADR-005 for the exact Postgres mechanism (a locally-set GUC rests at `''`, not `NULL`, after commit) |
| `009_auth_tokens_password_change_purpose.sql` | 1.6 | Adds the `password_change` purpose to `tenant.auth_tokens` |
| `010_domains_dkim_verified_at.sql` | 2.2 (unplanned fix) | `control.domains.dkim_verified_at` — DKIM publication tracked separately from ownership verification |
| `011_mailboxes_partial_unique_local_part.sql` | 2.3 (unplanned fix) | Replaces `tenant.mailboxes`' table-wide `UNIQUE (domain_id, local_part)` with a partial unique index over non-deleted rows, so a soft-deleted mailbox's address can be reused (same shape as `invites_pending_unique`). Idempotent |
| `012_auth_rate_limits.sql` | 1.4 (added 2026-10-07) | `control.auth_rate_limits` — failure counters and lockouts for `/auth/login`, `/auth/mfa/challenge` and `PATCH /me/password` (keys are SHA-256 hashes, never raw emails or tokens) |
| `013_cleanup_deleted_user_directory.sql` | 2.3 (data fix, 2026-10-07) | Removes `control.user_directory` rows left behind by users deleted before `UsersService.remove()` started deleting them, so their addresses can be reused. Safe to re-run |
| `014_users_email_unique_live_only.sql` | 2.3 (unplanned fix, 2026-10-07) | Replaces `tenant.users`' table-wide `UNIQUE (organization_id, email)` with a partial unique index over non-deleted users (`users_organization_id_email_live_unique`) — same soft-delete gap ADR-007/`011` fixed for mailboxes. Idempotent |

`000` and `001` are both "Step 1.1" because the control-plane schema is pure
scaffolding with no RLS dependency — it can be stood up before the tenant/RLS
foundation. `002` is Step 1.2 proper: it's the file that has to get the
org_units-before-users ordering right, and `004` carries the RLS policies
that step calls for.

If you ever need to run them by hand instead of `npm run migrate` (debugging,
a one-off environment):

```bash
for f in 000_extensions_and_uuidv7.sql 001_control_schema.sql \
         002_tenant_org_units_and_users.sql 003_tenant_core_tables.sql \
         004_tenant_rls.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "src/database/migrations/$f"
done
```

(this skips the `public.schema_migrations` bookkeeping — re-sync it manually
if you mix the two approaches.)

**Before running `000` against anything real:** the UUIDv7 function in that
file is a standard reference implementation, not the project's own hardened
production generator (separate, ongoing work on entropy quality, bitwise
overflow safety, and monotonic clock guarantees). Migration `007` fixed one
concrete bug in it (variant-bit placement); that's a narrower, already-done
fix, not a substitute for the fuller hardening work — swap this function out
before this schema goes anywhere near production data.

See also `architecture/decisions.md` (ADR-004) for why `006` exists at all —
the app must never connect to Postgres with the migration runner's
superuser role — and ADR-005 for why `008` exists: fixing `006` is what
exposed it.
