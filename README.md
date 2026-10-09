# Business Workspace Platform — workspace

Two independent repos, scaffolded per planning/implementation-plan.md's
Phase 1 build order (see that doc, and claude/srs.md / architecture/*.md,
in the project's Claude Project docs — this folder doesn't duplicate them):

- `backend/` — NestJS API. Start here: `backend/src/database/migrations/`
  is Step 1.1-1.2, `backend/src/modules/` is the rest of Phase 1 onward.
- `frontend/` — Next.js app. Route stubs mirror planning/screen-flow-inventory.md's
  site map; there's nothing real to build against until the backend's
  Owner-bootstrap endpoint (Step 1.3) exists.

Each has its own README with its own getting-started steps. Neither has
`node_modules` installed yet or a `git` history — run `git init` (or
`git clone` from wherever these end up hosted) and `npm install` in each
once you're ready to start.
