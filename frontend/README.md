# Business Workspace Platform — Frontend

Next.js 14 (App Router) + Tailwind CSS + shadcn/ui. Every route maps 1:1 to a
screen in `planning/screen-flow-inventory.md` — check that doc for the API
calls and key states each screen needs.

## Getting started

```bash
cp .env.example .env.local   # point NEXT_PUBLIC_API_BASE_URL at the backend (default http://localhost:3000)
npm install
npm run dev                  # http://localhost:3001 — matches the backend's APP_BASE_URL default
```

Other scripts: `npm run build`, `npm run lint`, `npm run typecheck`.

## Status

| Area | State |
|---|---|
| API client, auth/session handling, app shell | Built |
| Public auth screens: Sign Up, Log In, MFA Challenge, Force Password Change, Forgot Password (request/confirm), Accept Invite | Built |
| My Account: Profile, Change Password, Two-step verification, Sessions | Built |
| Users (Step 1.6): list, Invite (Path A), Create Directly (Path B, one-time temp password), Pending Invites, User Detail (role, org unit, suspend/reactivate, reissue, delete), Transfer Ownership | Built |
| Org Units & Groups (Step 1.5): Org Unit Tree (add/rename/move/delete with not-empty guidance), Group List, Group Detail (members, mailbox access) | Built |
| Domains (Step 2.2): list, Add Domain, Domain Detail / DNS instructions (per-record copy + live status, manual Verify now, set primary, remove with blocker links) | Built |
| Setup Checklist + Claim Your Mailbox (Flows 1–2): an Owner with no company mailbox lands here after login; claim = `POST /mailboxes {assignToSelf}` + `POST /me/primary-mailbox`, with a resume path if only the first call landed | Built |
| Mailboxes (Step 2.3): list (personal vs shared), Create Shared Mailbox, Mailbox Detail (quota, suspend/reactivate, delete, aliases, access grants to a user or group — Flow 11) | Built |
| Notifications bell (Step 3.1): unread badge (polled every minute and on tab focus), panel with All/Unread, mark read/unread, mark all read, load more; clicking opens what it's about | Built |
| Audit Logs (Step 3.2): Log Viewer with URL-backed filters (person, action, resource type, date range), cursor "Load more", readable descriptions, entry detail (`?entry=<id>`) | Built |
| Overview (Step 3.3): Owner/Admin landing — users, pending invites, mailboxes, domains tiles; domain status; recent activity linking into the Log Viewer | Built |
| Organization Settings: name, logo (https URL), default time zone and language for Owner/Admin; read-only "Organization" page for Members; org name/logo in the sidebar | Built |
| Rate-limit (429) messages: invite, password reissue, signup and password-reset request explain the hourly cap and when to retry | Built |
| Mail | Blocked: needs Step 2.1 mail infra and Step 2.4 |

## How auth works (architecture/api-contract.md §0–§1)

- **Access token**: kept only in memory in `lib/api/client.ts`, never in
  browser storage. Sent as `Authorization: Bearer …`.
- **Refresh token**: httpOnly, `SameSite=Strict` cookie set by the API and
  scoped to `/api/v1/auth/refresh`. On page load `AuthProvider` calls
  `/auth/refresh` and then `GET /me` to restore the session.
  **The app and the API must be same-site** (`localhost:3001`↔`localhost:3000`
  in dev, `app.example.com`↔`api.example.com` in prod). Otherwise the cookie is
  never sent and every reload logs the user out.
- **401 handling**: a 401 with code `UNAUTHENTICATED` triggers one refresh and
  one retry. Refreshes are single-flight because the backend rotates the
  refresh token on every use. A 401 `INVALID_CREDENTIALS` (wrong password in a
  request body, e.g. MFA disable) is treated as a form error, not an expired
  session.
- **Login branches**: `mfaChallengeToken` and `passwordChangeToken` are handed
  to their follow-up screens through `sessionStorage`
  (`lib/auth/pending-auth.ts`) with a 10-minute local expiry.
- Route guarding in `app/(app)/layout.tsx` is UX only. The API enforces auth
  and roles on every call.

## Layout

```
app/(public)/      Public screens. /reset-password redirects to /forgot-password/confirm
                   (the backend's reset email links to /reset-password?token=…)
app/(app)/         Authenticated screens inside AppShell (guarded layout)
components/ui/     shadcn/ui primitives (new-york style, Tailwind v3)
components/        common/ (shared bits), layout/ (shell, nav), auth/ (auth card)
lib/api/           client, error type, response types
lib/auth/          AuthProvider, pending-auth hand-off, navigation helpers
```
