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

```bash
cp .env.example .env    # fill in a real DATABASE_URL
npm install
npm run start:dev
```

Database schema is not yet wired to a migration runner —
`src/database/migrations/` holds the raw SQL in the order it must run (see
that folder's own README). Picking the actual migration tool
(node-pg-migrate, Prisma migrate, Flyway, plain `psql -f`, ...) is part of
Step 1.1 in the implementation plan and is still open.

## Module map

Each folder under `src/modules/` corresponds to one SRS §7 module and one
`architecture/api-contract.md` section — see the comment at the top of each
module file.
