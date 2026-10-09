#!/usr/bin/env node
// Live end-to-end checks against a running API + real Postgres.
//
//   node scripts/live-test.mjs
//
// Needs: the API on API_URL (default http://localhost:3000), migrations
// applied, DATABASE_URL (superuser) in .env for the few test-setup steps
// that can't happen through the API in a sandbox (force-verifying a domain,
// since there's no real DNS; expiring a rate-limit lock), and the API's log
// at API_LOG (default /tmp/api.log) to read invite links the dev mailer logs
// instead of sending. Creates fresh, uniquely-named orgs each run.
//
// Added 2026-10-07 alongside the reconstruction of the Step 2.3–3.1 files
// and the PATCH /me, PATCH /me/password, signup-409 and rate-limit work.
import 'dotenv/config';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { generate } from 'otplib';

const API = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
const API_LOG = process.env.API_LOG ?? '/tmp/api.log';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const run = Date.now().toString(36);
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}
const section = (t) => console.log(`\n# ${t}`);

/** Tiny client: bearer token + the refresh cookie, like a browser tab. */
class Client {
  token = null;
  refreshCookie = null;
  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (path === '/auth/refresh' && this.refreshCookie) h.Cookie = `refreshToken=${this.refreshCookie}`;
    const res = await fetch(API + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const m = /^refreshToken=([^;]*)/.exec(c);
      if (m) this.refreshCookie = m[1] || null;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (json?.accessToken) this.token = json.accessToken;
    return { status: res.status, body: json, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
}

const PW = 'correct horse battery';
const code = (r) => r.body?.error?.code;

// ADR-011 quota keys, same derivation as RateLimitService.key(). Requests
// from this script arrive from localhost under one of these spellings.
const LOCAL_IPS = ['::1', '::ffff:127.0.0.1', '127.0.0.1'];
const quotaKey = (scope, identifier, ip) =>
  createHash('sha256').update(`${scope}|${identifier.trim().toLowerCase()}|${ip}`).digest('hex');
const localKeys = (scope, identifier) => LOCAL_IPS.map((ip) => quotaKey(scope, identifier, ip));
/** This suite signs up many orgs from one IP — clear the signup quota first so a re-run within the hour works. */
async function clearSignupQuota() {
  await db.query('DELETE FROM control.auth_rate_limits WHERE key = ANY($1)', [localKeys('signup', '-')]);
}
/** Pre-fill a quota key as already used up (limit-agnostic: works whatever the configured limit is). */
async function exhaust(keys) {
  for (const k of keys) {
    await db.query(
      `INSERT INTO control.auth_rate_limits (key, failures, window_started_at, updated_at) VALUES ($1, 1000000, now(), now())
       ON CONFLICT (key) DO UPDATE SET failures = 1000000, window_started_at = now(), updated_at = now()`,
      [k],
    );
  }
}

async function signup(label) {
  await clearSignupQuota();
  const c = new Client();
  const email = `${label}-${run}@external.test`;
  const r = await c.post('/organizations', {
    organizationName: `${label} ${run}`,
    ownerContactEmail: email,
    ownerName: `${label} Owner`,
    password: PW,
  });
  if (r.status !== 201) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.body)}`);
  return { c, email, user: r.body.user };
}

async function forceVerifiedDomain(c, orgId, name) {
  const r = await c.post('/domains', { domainName: name });
  if (r.status !== 201) throw new Error(`domain create ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id ?? r.body.domainId;
  // Test setup only: no real DNS in a sandbox.
  await db.query(`UPDATE control.domains SET verification_status = 'verified', verified_at = now() WHERE id = $1`, [id]);
  return id;
}

// ---------------------------------------------------------------------------
section('Signup: duplicate email → 409 (was a raw 500)');
const A = await signup('alpha');
{
  const dup = await new Client().post('/organizations', {
    organizationName: `dup ${run}`, ownerContactEmail: A.email, ownerName: 'X', password: PW,
  });
  check('duplicate ownerContactEmail → 409', dup.status === 409, dup);
  check('code EMAIL_ALREADY_REGISTERED + field', code(dup) === 'EMAIL_ALREADY_REGISTERED' && dup.body.error.details?.field === 'ownerContactEmail', dup.body);
  const dupCase = await new Client().post('/organizations', {
    organizationName: `dup2 ${run}`, ownerContactEmail: A.email.toUpperCase(), ownerName: 'X', password: PW,
  });
  check('case-insensitive duplicate (CITEXT) → 409', dupCase.status === 409, dupCase);
  const n = await db.query('SELECT count(*)::int AS n FROM control.organizations WHERE name LIKE $1', [`dup% ${run}`]);
  check('no orphan organization rows left behind', n.rows[0].n === 0, n.rows);
}

// ---------------------------------------------------------------------------
section('PATCH /me (name)');
{
  const r = await A.c.patch('/me', { name: '  Alpha Renamed  ' });
  check('200 + trimmed name', r.status === 200 && r.body.name === 'Alpha Renamed', r);
  check('returns MeResult shape (mfaEnabled, email)', r.body.mfaEnabled === false && r.body.email === A.email, r.body);
  const me = await A.c.get('/me');
  check('GET /me reflects new name', me.body.name === 'Alpha Renamed', me.body);
  const empty = await A.c.patch('/me', { name: '   ' });
  check('blank name → 400', empty.status === 400, empty);
  const long = await A.c.patch('/me', { name: 'x'.repeat(201) });
  check('201-char name → 400', long.status === 400, long);
  const sneaky = await A.c.patch('/me', { name: 'Alpha Renamed', email: 'evil@x.test', role: 'member' });
  const me2 = await A.c.get('/me');
  check('extra fields (email/role) ignored', me2.body.email === A.email && me2.body.role === 'owner', me2.body);
  check('…and request still 200', sneaky.status === 200, sneaky);
  const anon = await new Client().patch('/me', { name: 'x' });
  check('unauthenticated → 401', anon.status === 401, anon);
}

// ---------------------------------------------------------------------------
section('PATCH /me/password');
{
  // Second session for the same user, to prove "revoke every other session".
  const other = new Client();
  const lo = await other.post('/auth/login', { email: A.email, password: PW });
  check('second session logs in', lo.status === 200 && !!other.refreshCookie, lo);

  const wrong = await A.c.patch('/me/password', { currentPassword: 'not it at all', newPassword: 'a brand new password' });
  check('wrong current → 401 INVALID_CREDENTIALS', wrong.status === 401 && code(wrong) === 'INVALID_CREDENTIALS', wrong);
  const stillIn = await A.c.get('/me');
  check('…and the caller is still signed in', stillIn.status === 200, stillIn);
  const same = await A.c.patch('/me/password', { currentPassword: PW, newPassword: PW });
  check('same as current → 422 PASSWORD_UNCHANGED', same.status === 422 && code(same) === 'PASSWORD_UNCHANGED', same);
  const short = await A.c.patch('/me/password', { currentPassword: PW, newPassword: 'short' });
  check('new < 10 chars → 400', short.status === 400, short);

  const NEW = 'a brand new password';
  const ok = await A.c.patch('/me/password', { currentPassword: PW, newPassword: NEW });
  check('correct → 200', ok.status === 200, ok);

  const otherRefresh = await other.post('/auth/refresh');
  check('other session can no longer refresh (revoked)', otherRefresh.status === 401, otherRefresh);
  const selfRefresh = await A.c.post('/auth/refresh');
  check('current session still refreshes', selfRefresh.status === 200, selfRefresh);

  const oldLogin = await new Client().post('/auth/login', { email: A.email, password: PW });
  check('old password no longer logs in', oldLogin.status === 401, oldLogin);
  const newLogin = await new Client().post('/auth/login', { email: A.email, password: NEW });
  check('new password logs in', newLogin.status === 200 && !!newLogin.body.accessToken, newLogin);

  const n = await A.c.get('/notifications');
  check('password_changed notification created', n.body.data?.some((x) => x.type === 'password_changed'), n.body);
  const audit = await A.c.get('/audit-logs?action=user.password_changed');
  check('user.password_changed audit entry', audit.body.data?.length === 1 && audit.body.data[0].resourceId === A.user.id, audit.body);
  const pwRow = await db.query(`SELECT metadata::text FROM tenant.audit_logs WHERE action = 'user.password_changed' AND actor_user_id = $1`, [A.user.id]);
  check('audit metadata contains no password', !pwRow.rows[0].metadata.includes(NEW) && !pwRow.rows[0].metadata.includes(PW), pwRow.rows);

  // Restore the shared password so later sections keep using PW.
  await A.c.patch('/me/password', { currentPassword: NEW, newPassword: PW });
}

// ---------------------------------------------------------------------------
section('Login rate limiting (10 failures / 15 min per account+IP, exponential backoff)');
{
  const B = await signup('bravo');
  const anon = new Client();
  let last;
  for (let i = 1; i <= 9; i++) last = await anon.post('/auth/login', { email: B.email, password: `wrong-${i}` });
  check('failures 1–9 → 401', last.status === 401 && code(last) === 'INVALID_CREDENTIALS', last);
  const tenth = await anon.post('/auth/login', { email: B.email, password: 'wrong-10' });
  check('10th failure → 429 RATE_LIMITED', tenth.status === 429 && code(tenth) === 'RATE_LIMITED', tenth);
  const ra = Number(tenth.headers.get('retry-after'));
  check('Retry-After ≈ 900s', ra > 890 && ra <= 900, ra);
  const right = await anon.post('/auth/login', { email: B.email, password: PW });
  check('correct password while locked → still 429', right.status === 429, right);
  const caseVariant = await anon.post('/auth/login', { email: B.email.toUpperCase(), password: PW });
  check('email case doesn\'t dodge the lock', caseVariant.status === 429, caseVariant);
  const otherAcct = await anon.post('/auth/login', { email: A.email, password: PW });
  check('a different account from the same IP is unaffected', otherAcct.status === 200, otherAcct);

  // Expire the lock (test setup), fail 10 more → second lockout doubles.
  await db.query(`UPDATE control.auth_rate_limits SET locked_until = now() - interval '1 second'`);
  const afterExpiry = await anon.post('/auth/login', { email: B.email, password: 'wrong-again' });
  check('after lock expires, a wrong password is a normal 401', afterExpiry.status === 401, afterExpiry);
  for (let i = 0; i < 8; i++) await anon.post('/auth/login', { email: B.email, password: `w${i}` });
  const second = await anon.post('/auth/login', { email: B.email, password: 'w-last' });
  const ra2 = Number(second.headers.get('retry-after'));
  check('second lockout → 429 with Retry-After ≈ 1800s (doubled)', second.status === 429 && ra2 > 1790 && ra2 <= 1800, { s: second.status, ra2 });

  // Success clears the counter.
  await db.query(`UPDATE control.auth_rate_limits SET locked_until = NULL`);
  const good = await anon.post('/auth/login', { email: B.email, password: PW });
  check('successful login → 200', good.status === 200, good);
  const rows = await db.query('SELECT count(*)::int AS n FROM control.auth_rate_limits');
  const after = await anon.post('/auth/login', { email: B.email, password: 'one-more-wrong' });
  check('…and resets the count (next failure is a plain 401)', after.status === 401, after);

  const ghost = `nobody-${run}@nowhere.test`;
  for (let i = 0; i < 9; i++) await anon.post('/auth/login', { email: ghost, password: 'x' });
  const ghost10 = await anon.post('/auth/login', { email: ghost, password: 'x' });
  check('unknown emails are limited the same way (no enumeration via the limiter)', ghost10.status === 429, ghost10);
  const raw = await db.query('SELECT key FROM control.auth_rate_limits');
  check('rate-limit keys are hashes, never raw emails', raw.rows.every((r) => /^[0-9a-f]{64}$/.test(r.key)), raw.rows.length);
  void rows;
}

// ---------------------------------------------------------------------------
section('Domains, mailboxes (DTO validation, 011 slot reuse), primary-mailbox claim');
let domainId;
let ownerCompanyEmail;
{
  domainId = await forceVerifiedDomain(A.c, A.user.organizationId, `alpha-${run}.test`);
  const upper = await A.c.post('/mailboxes', { domainId, localPart: 'Support' });
  check('uppercase localPart → 400', upper.status === 400, upper);
  const bad = await A.c.post('/mailboxes', { domainId, localPart: '.dot' });
  check('leading dot → 400', bad.status === 400, bad);
  const badQuota = await A.c.post('/mailboxes', { domainId, localPart: 'tiny', quotaBytes: 10 });
  check('quota below 1 MiB → 400', badQuota.status === 400, badQuota);

  const support = await A.c.post('/mailboxes', { domainId, localPart: 'support' });
  check('shared mailbox → 201', support.status === 201 && support.body.userId === null, support);
  const dupSupport = await A.c.post('/mailboxes', { domainId, localPart: 'support' });
  check('same live slot → 409', dupSupport.status === 409, dupSupport);
  const del = await A.c.del(`/mailboxes/${support.body.id}`);
  check('delete → 200', del.status === 200, del);
  const again = await A.c.post('/mailboxes', { domainId, localPart: 'support' });
  check('recreate deleted slot → 201 (migration 011)', again.status === 201, again);

  const patch = await A.c.patch(`/mailboxes/${again.body.id}`, { status: 'suspended', quotaBytes: 2 * 1024 ** 3 });
  check('PATCH quota/status → 200', patch.status === 200 && patch.body.status === 'suspended' && Number(patch.body.quotaBytes) === 2 * 1024 ** 3, patch);
  const patchDel = await A.c.patch(`/mailboxes/${again.body.id}`, { status: 'deleted' });
  check('PATCH status=deleted → 400 (DELETE does that)', patchDel.status === 400, patchDel);

  const alias = await A.c.post(`/mailboxes/${again.body.id}/aliases`, { localPart: 'help' });
  check('alias → 201', alias.status === 201 && alias.body.email === `help@alpha-${run}.test`, alias);
  const aliasCollide = await A.c.post('/mailboxes', { domainId, localPart: 'help' });
  check('mailbox colliding with alias → 409', aliasCollide.status === 409, aliasCollide);

  const both = await A.c.post(`/mailboxes/${again.body.id}/access`, { userId: A.user.id, groupId: A.user.id, accessLevel: 'send_as' });
  check('grant with both userId+groupId → 400', both.status === 400, both);
  const neither = await A.c.post(`/mailboxes/${again.body.id}/access`, { accessLevel: 'send_as' });
  check('grant with neither → 400', neither.status === 400, neither);
  const noLevel = await A.c.post(`/mailboxes/${again.body.id}/access`, { userId: A.user.id });
  check('grant without accessLevel → 400', noLevel.status === 400, noLevel);
  const grant = await A.c.post(`/mailboxes/${again.body.id}/access`, { userId: A.user.id, accessLevel: 'read_only' });
  check('grant to user → 201', grant.status === 201, grant);
  const upd = await A.c.patch(`/mailboxes/${again.body.id}/access/${grant.body.id}`, { accessLevel: 'manage' });
  check('update grant level → 200', upd.status === 200 && upd.body.accessLevel === 'manage', upd);
  const updBad = await A.c.patch(`/mailboxes/${again.body.id}/access/${grant.body.id}`, { accessLevel: 'owner' });
  check('invalid level → 400', updBad.status === 400, updBad);

  // Owner bootstrap: assignToSelf → claim.
  const mine = await A.c.post('/mailboxes', { domainId, localPart: 'alpha' });
  void mine;
  const self = await A.c.post('/mailboxes', { domainId, localPart: 'owner', assignToSelf: true });
  check('assignToSelf mailbox → 201, userId = caller', self.status === 201 && self.body.userId === A.user.id, self);
  const notMine = await A.c.post('/me/primary-mailbox', { mailboxId: again.body.id });
  check('claim a shared mailbox → 422 MAILBOX_NOT_OWNED_BY_CALLER', notMine.status === 422 && code(notMine) === 'MAILBOX_NOT_OWNED_BY_CALLER', notMine);
  const badId = await A.c.post('/me/primary-mailbox', { mailboxId: 'not-a-uuid' });
  check('claim with bad id → 400', badId.status === 400, badId);
  const claim = await A.c.post('/me/primary-mailbox', { mailboxId: self.body.id });
  ownerCompanyEmail = `owner@alpha-${run}.test`;
  check('claim → 200 with company email', claim.status === 200 && claim.body.email === ownerCompanyEmail, claim);
  const twice = await A.c.post('/me/primary-mailbox', { mailboxId: self.body.id });
  check('claim again → 409 PRIMARY_MAILBOX_ALREADY_SET', twice.status === 409 && code(twice) === 'PRIMARY_MAILBOX_ALREADY_SET', twice);
  const oldEmail = await new Client().post('/auth/login', { email: A.email, password: PW });
  check('old external email no longer logs in', oldEmail.status === 401, oldEmail);
  const newEmail = await new Client().post('/auth/login', { email: ownerCompanyEmail, password: PW });
  check('company email logs in', newEmail.status === 200, newEmail);
  const me = await A.c.get('/me');
  check('GET /me shows company email', me.body.email === ownerCompanyEmail, me.body);
  const secondSelf = await A.c.post('/mailboxes', { domainId, localPart: 'owner2', assignToSelf: true });
  check('second assignToSelf → 409', secondSelf.status === 409, secondSelf);
  const reuse = await new Client().post('/organizations', { organizationName: `reuse ${run}`, ownerContactEmail: A.email, ownerName: 'R', password: PW });
  check('freed external email can sign up a new org after the claim', reuse.status === 201, reuse);
}

// ---------------------------------------------------------------------------
section('Notifications (user_joined, password_reissued, list/paginate/read)');
{
  // Path B: create a member directly → admins get user_joined.
  const created = await A.c.post('/users', { domainId, localPart: 'sara', name: 'Sara T', role: 'member' });
  check('POST /users (Path B) → 201', created.status === 201 && !!created.body.temporaryPassword, created);
  const memberId = created.body.userId;

  // Path A: invite → accept → admins get user_joined.
  const inv = await A.c.post('/users/invite', { domainId, localPart: 'john', contactEmail: `john-${run}@external.test`, role: 'admin' });
  check('POST /users/invite → 201', inv.status === 201, inv);
  await new Promise((r) => setTimeout(r, 300));
  const log = fs.existsSync(API_LOG) ? fs.readFileSync(API_LOG, 'utf8') : '';
  const token = [...log.matchAll(/accept-invite\?token=([0-9a-f]{64})/g)].pop()?.[1];
  check('invite link found in dev mailer log', !!token, API_LOG);
  const john = new Client();
  const acc = await john.post(`/invites/${token}/accept`, { name: 'John D', password: PW });
  check('invite accept → 201', acc.status === 201, acc);

  const list = await A.c.get('/notifications');
  const joined = list.body.data.filter((n) => n.type === 'user_joined');
  check('owner has 2 user_joined (Path A + Path B)', joined.length === 2, list.body);
  check('payload has no secrets', joined.every((n) => !JSON.stringify(n.payload).includes(created.body.temporaryPassword)), joined);
  const johnList = await john.get('/notifications');
  check('new admin John got none for his own join', johnList.body.data.length === 0, johnList.body);

  // Reissue → the member is notified.
  const re = await A.c.post(`/users/${memberId}/password/reissue`, {});
  check('reissue → 200', re.status === 200, re);
  const sara = new Client();
  const s1 = await sara.post('/auth/login', { email: `sara@alpha-${run}.test`, password: re.body.temporaryPassword });
  const s2 = await sara.post('/auth/password-change', { passwordChangeToken: s1.body.passwordChangeToken, newPassword: PW });
  check('member completes forced change', s2.status === 200, s2);
  const saraN = await sara.get('/notifications');
  check('member sees password_reissued', saraN.body.data.some((n) => n.type === 'password_reissued'), saraN.body);
  const saraAdmin = await sara.get('/audit-logs');
  check('member can read own notifications but audit logs → 403', saraAdmin.status === 403, saraAdmin);

  // Ownership: someone else's notification → 404.
  const ownersFirst = list.body.data[0];
  const steal = await sara.patch(`/notifications/${ownersFirst.id}`, { readAt: new Date().toISOString() });
  check('marking another user\'s notification → 404', steal.status === 404, steal);

  // Pagination with seeded rows.
  await db.query(
    `INSERT INTO tenant.notifications (organization_id, user_id, type, payload)
     SELECT $1, $2, 'user_joined', jsonb_build_object('seq', g) FROM generate_series(1, 30) g`,
    [A.user.organizationId, A.user.id],
  );
  const p1 = await A.c.get('/notifications?limit=10');
  check('limit=10 → 10 items, hasMore, nextCursor', p1.body.data.length === 10 && p1.body.meta.hasMore && !!p1.body.meta.nextCursor, p1.body.meta);
  const seen = new Set(p1.body.data.map((n) => n.id));
  let cursor = p1.body.meta.nextCursor;
  let pages = 1;
  while (cursor) {
    const p = await A.c.get(`/notifications?limit=10&cursor=${encodeURIComponent(cursor)}`);
    p.body.data.forEach((n) => seen.add(n.id));
    cursor = p.body.meta.nextCursor;
    pages++;
    if (pages > 10) break;
  }
  const total = await db.query('SELECT count(*)::int AS n FROM tenant.notifications WHERE user_id = $1', [A.user.id]);
  check('walking all pages sees every row exactly once', seen.size === total.rows[0].n, { seen: seen.size, total: total.rows[0].n });
  const ordered = p1.body.data.every((n, i, a) => i === 0 || a[i - 1].id > n.id);
  check('newest first (id DESC)', ordered);
  check('limit=0 → 400', (await A.c.get('/notifications?limit=0')).status === 400);
  check('limit=101 → 400', (await A.c.get('/notifications?limit=101')).status === 400);
  check('garbage cursor → 400', (await A.c.get('/notifications?cursor=garbage')).status === 400);
  check('unreadOnly=maybe → 400', (await A.c.get('/notifications?unreadOnly=maybe')).status === 400);

  const count1 = await A.c.get('/notifications/unread-count');
  check('unread-count = total (nothing read yet)', count1.body.unreadCount === total.rows[0].n, count1.body);
  const target = p1.body.data[0];
  const mark = await A.c.patch(`/notifications/${target.id}`, { readAt: new Date().toISOString() });
  check('PATCH readAt → 200, readAt set', mark.status === 200 && !!mark.body.readAt, mark);
  const unread = await A.c.get('/notifications?unreadOnly=true&limit=100');
  check('unreadOnly excludes it', !unread.body.data.some((n) => n.id === target.id), unread.body.meta);
  const unmark = await A.c.patch(`/notifications/${target.id}`, { readAt: null });
  check('readAt: null → unread again', unmark.status === 200 && unmark.body.readAt === null, unmark);
  check('missing readAt → 400', (await A.c.patch(`/notifications/${target.id}`, {})).status === 400);
  check('bad readAt → 400', (await A.c.patch(`/notifications/${target.id}`, { readAt: 'yesterday' })).status === 400);
  const all = await A.c.post('/notifications/read-all');
  check('read-all → 200 with updated count', all.status === 200 && all.body.updated === total.rows[0].n, all.body);
  const count2 = await A.c.get('/notifications/unread-count');
  check('unread-count → 0', count2.body.unreadCount === 0, count2.body);

  // Cross-org isolation.
  const C = await signup('charlie');
  const cList = await C.c.get('/notifications');
  check('another org sees none of these', cList.body.data.length === 0, cList.body);
  const cSteal = await C.c.patch(`/notifications/${target.id}`, { readAt: null });
  check('another org\'s id → 404', cSteal.status === 404, cSteal);
}

// ---------------------------------------------------------------------------
section('MFA challenge rate limiting (5 wrong codes per challenge)');
{
  const D = await signup('delta');
  const setup = await D.c.post('/me/mfa/setup');
  const v = await D.c.post('/me/mfa/verify-setup', { code: await generate({ secret: setup.body.secret }) });
  check('MFA enabled', v.status === 200, v);
  const t = new Client();
  const lo = await t.post('/auth/login', { email: D.email, password: PW });
  check('login → mfaChallengeToken', !!lo.body.mfaChallengeToken, lo);
  let r;
  for (let i = 0; i < 4; i++) r = await t.post('/auth/mfa/challenge', { mfaChallengeToken: lo.body.mfaChallengeToken, code: '000000' });
  check('wrong codes 1–4 → 400 INVALID_CODE', r.status === 400 && code(r) === 'INVALID_CODE', r);
  const fifth = await t.post('/auth/mfa/challenge', { mfaChallengeToken: lo.body.mfaChallengeToken, code: '000000' });
  check('5th wrong code → 429', fifth.status === 429 && !!fifth.headers.get('retry-after'), fifth);
  const right = await t.post('/auth/mfa/challenge', { mfaChallengeToken: lo.body.mfaChallengeToken, code: await generate({ secret: setup.body.secret }) });
  check('right code on the locked challenge → 429', right.status === 429, right);
  const lo2 = await t.post('/auth/login', { email: D.email, password: PW });
  const fresh = await t.post('/auth/mfa/challenge', { mfaChallengeToken: lo2.body.mfaChallengeToken, code: await generate({ secret: setup.body.secret }) });
  check('a fresh challenge (new login) works', fresh.status === 200 && !!fresh.body.accessToken, fresh);
}

// ---------------------------------------------------------------------------
section('User management guards (2026-10-07: reissue/owner, reissue revokes sessions, deleted is final, list fields)');
{
  const E = await signup('echo');
  const dom = await forceVerifiedDomain(E.c, E.user.organizationId, `echo-${run}.test`);
  const mk = await E.c.post('/users', { domainId: dom, localPart: 'adam', name: 'Adam Admin', role: 'admin' });
  const adam = new Client();
  const a1 = await adam.post('/auth/login', { email: `adam@echo-${run}.test`, password: mk.body.temporaryPassword });
  await adam.post('/auth/password-change', { passwordChangeToken: a1.body.passwordChangeToken, newPassword: PW });

  const list = await E.c.get('/users');
  const adamRow = list.body.data.find((u) => u.id === mk.body.userId);
  check('GET /users exposes mustChangePassword + lastLoginAt', adamRow && adamRow.mustChangePassword === false && !!adamRow.lastLoginAt, adamRow);
  const ownerRow = list.body.data.find((u) => u.id === E.user.id);
  check('Owner signup counts as a sign-in (lastLoginAt set)', !!ownerRow.lastLoginAt, ownerRow);
  const fresh = await E.c.post('/users', { domainId: dom, localPart: 'newbie', name: 'New B' });
  const nb = await E.c.get(`/users/${fresh.body.userId}`);
  check('fresh Path B account → mustChangePassword true, lastLoginAt null', nb.body.mustChangePassword === true && nb.body.lastLoginAt === null, nb.body);

  const takeover = await adam.post(`/users/${E.user.id}/password/reissue`, {});
  check('Admin reissuing the Owner’s password → 403 CANNOT_REISSUE_OWNER', takeover.status === 403 && code(takeover) === 'CANNOT_REISSUE_OWNER', takeover);
  const ownerStill = await new Client().post('/auth/login', { email: E.email, password: PW });
  check('…and the Owner’s password is unchanged', ownerStill.status === 200, ownerStill);

  // Reissue cuts off existing sessions.
  const victim = new Client();
  await victim.post('/auth/login', { email: `adam@echo-${run}.test`, password: PW });
  const re = await E.c.post(`/users/${mk.body.userId}/password/reissue`, {});
  check('Owner reissues Adam → 200', re.status === 200, re);
  const vr = await victim.post('/auth/refresh');
  check('Adam’s existing session can no longer refresh', vr.status === 401, vr);
  const ar = await adam.post('/auth/refresh');
  check('…including his other session', ar.status === 401, ar);

  const del = await E.c.del(`/users/${fresh.body.userId}`);
  check('delete Path B user → 200', del.status === 200, del);
  const revive = await E.c.patch(`/users/${fresh.body.userId}`, { status: 'active' });
  check('PATCH on a deleted user → 404 (no resurrection)', revive.status === 404, revive);
  const reDeleted = await E.c.post(`/users/${fresh.body.userId}/password/reissue`, {});
  check('reissue on a deleted user → 404', reDeleted.status === 404, reDeleted);
  const getDeleted = await E.c.get(`/users/${fresh.body.userId}`);
  check('GET deleted user still readable (status deleted)', getDeleted.status === 200 && getDeleted.body.status === 'deleted', getDeleted.body);
}

// ---------------------------------------------------------------------------
section('Org units & groups (2026-10-07: delete guards, deleted users, group mailbox reverse lookup)');
{
  const F = await signup('foxtrot');
  const dom = await forceVerifiedDomain(F.c, F.user.organizationId, `foxtrot-${run}.test`);
  const units = await F.c.get('/org-units');
  const root = units.body.data.find((u) => u.parentOrgUnitId === null);
  const eng = await F.c.post('/org-units', { name: 'Engineering', parentOrgUnitId: root.id });
  const be = await F.c.post('/org-units', { name: 'Backend', parentOrgUnitId: eng.body.id });
  check('create nested units → 201', eng.status === 201 && be.status === 201, [eng.status, be.status]);
  const noParent = await F.c.post('/org-units', { name: 'Orphan' });
  check('create without parent → 400', noParent.status === 400, noParent);
  const cycle = await F.c.patch(`/org-units/${eng.body.id}`, { parentOrgUnitId: be.body.id });
  check('reparent under own descendant → 422 ORG_UNIT_CYCLE', cycle.status === 422 && code(cycle) === 'ORG_UNIT_CYCLE', cycle);
  const rootDel = await F.c.del(`/org-units/${root.id}`);
  check('delete root → 422 ORG_UNIT_IS_ROOT', rootDel.status === 422 && code(rootDel) === 'ORG_UNIT_IS_ROOT', rootDel);

  // Member in Backend → blocked with memberUserIds.
  const u1 = await F.c.post('/users', { domainId: dom, localPart: 'amy', name: 'Amy', orgUnitId: be.body.id });
  const nonEmpty = await F.c.del(`/org-units/${be.body.id}`);
  check('delete unit with a member → 422 + memberUserIds', nonEmpty.status === 422 && nonEmpty.body.error.details.memberUserIds.includes(u1.body.userId), nonEmpty.body);
  const parentDel = await F.c.del(`/org-units/${eng.body.id}`);
  check('delete unit with a child → 422 + childOrgUnitIds', parentDel.status === 422 && parentDel.body.error.details.childOrgUnitIds.includes(be.body.id), parentDel.body);

  // Pending invite targeting Backend → blocked (was a raw FK 500).
  const inv = await F.c.post('/users/invite', { domainId: dom, localPart: 'ivy', contactEmail: `ivy-${run}@external.test`, orgUnitId: be.body.id });
  await F.c.del(`/users/${u1.body.userId}`);
  const withInvite = await F.c.del(`/org-units/${be.body.id}`);
  check('delete unit with only a pending invite → 422 + pendingInviteIds (not 500)', withInvite.status === 422 && withInvite.body.error.details.pendingInviteIds.includes(inv.body.inviteId), withInvite.body);
  check('…and the deleted member no longer counts', withInvite.body.error.details.memberUserIds.length === 0, withInvite.body);
  await F.c.del(`/invites/${inv.body.inviteId}`);

  // Accepted invite + deleted user still referencing the unit → delete now succeeds.
  const inv2 = await F.c.post('/users/invite', { domainId: dom, localPart: 'joe', contactEmail: `joe-${run}@external.test`, orgUnitId: be.body.id });
  await new Promise((r) => setTimeout(r, 300));
  const token = [...fs.readFileSync(API_LOG, 'utf8').matchAll(/accept-invite\?token=([0-9a-f]{64})/g)].map((m) => m[1]);
  let joeToken;
  for (const t of token.reverse()) {
    const pv = await new Client().get(`/invites/${t}`);
    if (pv.status === 200 && pv.body.localPart === 'joe' && pv.body.domainName === `foxtrot-${run}.test`) { joeToken = t; break; }
  }
  const joe = new Client();
  const acc = await joe.post(`/invites/${joeToken}/accept`, { name: 'Joe', password: PW });
  check('joe accepts into Backend', acc.status === 201 && acc.body.user.orgUnitId === be.body.id, acc.body);
  void inv2;
  await F.c.del(`/users/${acc.body.user.id}`);
  const finalDel = await F.c.del(`/org-units/${be.body.id}`);
  check('unit referenced only by a deleted user + accepted invite → deletes (was a raw FK 500)', finalDel.status === 200, finalDel);
  const deletedJoe = await F.c.get(`/users/${acc.body.user.id}`);
  check('deleted user moved up to the parent unit', deletedJoe.body.orgUnitId === eng.body.id, deletedJoe.body);

  // Groups
  const g = await F.c.post('/groups', { name: 'Support Team', description: 'Handles support@' });
  check('create group → 201', g.status === 201 && g.body.memberCount === 0, g);
  const dupG = await F.c.post('/groups', { name: 'Support Team' });
  check('duplicate group name → 409 GROUP_NAME_TAKEN', dupG.status === 409 && code(dupG) === 'GROUP_NAME_TAKEN', dupG);
  const u2 = await F.c.post('/users', { domainId: dom, localPart: 'bea', name: 'Bea' });
  const u3 = await F.c.post('/users', { domainId: dom, localPart: 'cal', name: 'Cal' });
  check('add member → 201', (await F.c.post(`/groups/${g.body.id}/members`, { userId: u2.body.userId })).status === 201);
  await F.c.post(`/groups/${g.body.id}/members`, { userId: u3.body.userId });
  const dupM = await F.c.post(`/groups/${g.body.id}/members`, { userId: u2.body.userId });
  check('add same member twice → 409', dupM.status === 409, dupM);
  const support = await F.c.post('/mailboxes', { domainId: dom, localPart: 'support' });
  await F.c.post(`/mailboxes/${support.body.id}/access`, { groupId: g.body.id, accessLevel: 'send_as' });
  const det = await F.c.get(`/groups/${g.body.id}`);
  check('group detail lists mailboxAccess (reverse lookup)', det.body.mailboxAccess?.length === 1 && det.body.mailboxAccess[0].email === `support@foxtrot-${run}.test` && det.body.mailboxAccess[0].accessLevel === 'send_as', det.body);
  await F.c.del(`/users/${u3.body.userId}`);
  const det2 = await F.c.get(`/groups/${g.body.id}`);
  check('deleted user leaves the group', det2.body.members.length === 1 && det2.body.members[0].userId === u2.body.userId, det2.body.members);
  const list = await F.c.get('/groups');
  check('memberCount reflects it', list.body.data.find((x) => x.id === g.body.id).memberCount === 1, list.body);
  const addDeleted = await F.c.post(`/groups/${g.body.id}/members`, { userId: u3.body.userId });
  check('adding a deleted user → 404', addDeleted.status === 404, addDeleted);
  const ren = await F.c.patch(`/groups/${g.body.id}`, { name: 'Customer Support', description: '' });
  check('rename + clear description → 200', ren.status === 200 && ren.body.name === 'Customer Support', ren.body);
  const gdel = await F.c.del(`/groups/${g.body.id}`);
  const grants = await F.c.get(`/mailboxes/${support.body.id}/access`);
  check('delete group → its mailbox grants go too', gdel.status === 200 && grants.body.data.length === 0, grants.body);
}

// ---------------------------------------------------------------------------
section('Phase 2 lifecycle (2026-10-07: DNS entries, delete user→mailbox→reuse address→delete domain)');
{
  const G = await signup('golf');
  const dname = `golf-${run}.test`;
  const created = await G.c.post('/domains', { domainName: dname });
  const domId = created.body.id;
  const dns = await G.c.get(`/domains/${domId}/dns-records`);
  const byPurpose = Object.fromEntries(dns.body.records.map((r) => [r.purpose, r]));
  check('ownership entry: host @, fqdn = domain, value has token', byPurpose.ownership.entries[0].host === '@' && byPurpose.ownership.entries[0].fqdn === dname && byPurpose.ownership.entries[0].value.startsWith('workspace-verification='), byPurpose.ownership);
  check('MX entry has priority', byPurpose.inbound.entries[0].priority === 10, byPurpose.inbound);
  check('DMARC entry on _dmarc', byPurpose.dmarc.entries[0].fqdn === `_dmarc.${dname}`, byPurpose.dmarc);
  check('DKIM has no entry before key generation', byPurpose.dkim.status === 'pending-generation' && byPurpose.dkim.entries.length === 0, byPurpose.dkim);
  check('autodiscovery = 3 SRV entries', byPurpose.autodiscovery.entries.length === 3 && byPurpose.autodiscovery.entries[0].value.includes(' 993 '), byPurpose.autodiscovery);
  const ver = await G.c.post(`/domains/${domId}/verify`);
  check('verify against no real DNS → stays unverified (failed), 200', ver.status === 200 && ver.body.verificationStatus === 'failed', ver.body);
  const primUnverified = await G.c.patch(`/domains/${domId}`, { isPrimary: true });
  check('set unverified domain primary → 422 DOMAIN_NOT_VERIFIED', primUnverified.status === 422 && code(primUnverified) === 'DOMAIN_NOT_VERIFIED', primUnverified);
  const dupDomain = await (await signup('golf2')).c.post('/domains', { domainName: dname.toUpperCase() });
  check('domain claimed by another org (any case) → 409 DOMAIN_ALREADY_CLAIMED', dupDomain.status === 409 && code(dupDomain) === 'DOMAIN_ALREADY_CLAIMED', dupDomain);
  await db.query(`UPDATE control.domains SET verification_status='verified', verified_at=now() WHERE id=$1`, [domId]);
  const prim = await G.c.patch(`/domains/${domId}`, { isPrimary: true });
  check('set verified domain primary → 200', prim.status === 200 && prim.body.isPrimary === true, prim.body);

  const john = await G.c.post('/users', { domainId: domId, localPart: 'john', name: 'John' });
  const mbList = await G.c.get('/mailboxes');
  const johnMb = mbList.body.data.find((m) => m.email === `john@${dname}`);
  const blocked = await G.c.del(`/mailboxes/${johnMb.id}`);
  check('delete a live user’s primary mailbox → 422 MAILBOX_IS_PRIMARY', blocked.status === 422 && code(blocked) === 'MAILBOX_IS_PRIMARY', blocked);
  const al = await G.c.post(`/mailboxes/${johnMb.id}/aliases`, { localPart: 'jdoe' });
  check('alias on john → 201', al.status === 201, al);
  await G.c.del(`/users/${john.body.userId}`);
  const nowOk = await G.c.del(`/mailboxes/${johnMb.id}`);
  check('after deleting the user, their mailbox can be deleted (was blocked forever)', nowOk.status === 200, nowOk);
  const aliasFree = await G.c.post('/mailboxes', { domainId: domId, localPart: 'jdoe' });
  check('deleted mailbox’s alias address is free again', aliasFree.status === 201, aliasFree);
  const again = await G.c.post('/users', { domainId: domId, localPart: 'john', name: 'John Two' });
  check('recreate john@ as a new account → 201 (was a user_directory 500)', again.status === 201, again);
  const jl = await new Client().post('/auth/login', { email: `john@${dname}`, password: again.body.temporaryPassword });
  check('…and the new John can sign in', jl.status === 200 && !!jl.body.passwordChangeToken, jl);

  const domBlocked = await G.c.del(`/domains/${domId}`);
  check('delete domain with live mailboxes → 422 + mailboxIds', domBlocked.status === 422 && code(domBlocked) === 'DOMAIN_HAS_ACTIVE_MAILBOXES' && domBlocked.body.error.details.mailboxIds.length === 2, domBlocked.body);
  const inv = await G.c.post('/users/invite', { domainId: domId, localPart: 'kim', contactEmail: `kim-${run}@external.test` });
  await G.c.del(`/users/${again.body.userId}`);
  const mbs2 = (await G.c.get('/mailboxes')).body.data;
  for (const m of mbs2) await G.c.del(`/mailboxes/${m.id}`);
  const domInvite = await G.c.del(`/domains/${domId}`);
  check('then only a pending invite blocks → 422 DOMAIN_HAS_PENDING_INVITES', domInvite.status === 422 && code(domInvite) === 'DOMAIN_HAS_PENDING_INVITES', domInvite.body);
  await G.c.del(`/invites/${inv.body.inviteId}`);
  const domGone = await G.c.del(`/domains/${domId}`);
  check('domain whose mailboxes/aliases/users were all deleted → 200 (was a raw FK 500)', domGone.status === 200, domGone);
  const reclaim = await G.c.post('/domains', { domainName: dname });
  check('the domain name can be added again', reclaim.status === 201, reclaim);
}

// ---------------------------------------------------------------------------
section('Audit logs pagination + admin overview still work');
{
  const p = await A.c.get('/audit-logs?limit=2');
  check('audit-logs limit=2 → 2 + cursor', p.body.data.length === 2 && p.body.meta.hasMore, p.body.meta);
  const p2 = await A.c.get(`/audit-logs?limit=2&cursor=${p.body.meta.nextCursor}`);
  check('next page continues below', p2.status === 200 && p2.body.data[0].id < p.body.data[1].id, p2.body);
  const ov = await A.c.get('/admin/overview');
  check('admin overview → 200', ov.status === 200 && typeof ov.body.totalUsers === 'number', ov.body);
  // Added with the Overview screen: ids to link from, full activity entries.
  const d0 = ov.body.domains[0];
  check('overview domains carry id + isPrimary', !!d0 && typeof d0.id === 'string' && typeof d0.isPrimary === 'boolean', d0);
  const a0 = ov.body.recentActivity[0];
  check(
    'overview activity entries are full audit entries (id, resource, metadata)',
    !!a0 && typeof a0.id === 'string' && 'resourceType' in a0 && typeof a0.metadata === 'object',
    a0,
  );
  const one = await A.c.get(`/audit-logs/${a0.id}`);
  check('activity entry opens via GET /audit-logs/{id}', one.status === 200 && one.body.id === a0.id, one.body);
  check('recentActivity is capped at 10', ov.body.recentActivity.length <= 10, ov.body.recentActivity.length);

  // Member: no audit logs, no overview.
  const dId = await forceVerifiedDomain(A.c, null, `p3-${run}.test`);
  const mu = await A.c.post('/users', { domainId: dId, localPart: 'mona', name: 'Mona Member' });
  const M = { c: new Client() };
  const ml0 = await M.c.post('/auth/login', { email: `mona@p3-${run}.test`, password: mu.body.temporaryPassword });
  await M.c.post('/auth/password-change', { passwordChangeToken: ml0.body.passwordChangeToken, newPassword: PW });
  check('member session for RBAC checks', !!M.c.token, ml0.body);
  const ml = await M.c.get('/audit-logs');
  check('member GET /audit-logs → 403', ml.status === 403, ml.body);
  const mo = await M.c.get('/admin/overview');
  check('member GET /admin/overview → 403', mo.status === 403, mo.body);
}

section('Notifications: unread-only filter, mark unread again');
{
  const n = await A.c.get('/notifications?limit=5');
  const first = n.body.data[0];
  check('owner has notifications', !!first, n.body);
  const read = await A.c.patch(`/notifications/${first.id}`, { readAt: new Date().toISOString() });
  check('mark one read → readAt set', read.status === 200 && read.body.readAt !== null, read.body);
  const unread = await A.c.patch(`/notifications/${first.id}`, { readAt: null });
  check('mark it unread again → readAt null', unread.status === 200 && unread.body.readAt === null, unread.body);
  const only = await A.c.get('/notifications?unreadOnly=true&limit=100');
  check('unreadOnly includes it', only.body.data.some((x) => x.id === first.id), only.body.meta);
  const cnt = await A.c.get('/notifications/unread-count');
  check('unread-count matches unreadOnly total (≤100)', cnt.body.unreadCount === only.body.data.length || only.body.meta.hasMore, cnt.body);
  const all = await A.c.post('/notifications/read-all');
  check('read-all → 200 with count', all.status === 200 && typeof all.body.updated === 'number', all.body);
  const cnt2 = await A.c.get('/notifications/unread-count');
  check('unread-count 0 after read-all', cnt2.body.unreadCount === 0, cnt2.body);
}

section('Organization settings (GET/PATCH /organization)');
{
  const O = await signup('settings');
  const g = await O.c.get('/organization');
  check('GET /organization → own org with defaults', g.status === 200 && g.body.name === `settings ${run}` && g.body.defaultTimezone === 'UTC' && g.body.defaultLocale === 'en' && g.body.logoUrl === null && g.body.ownerUserId === O.user.id, g.body);
  const p = await O.c.patch('/organization', { name: '  Settings Renamed  ', defaultTimezone: 'Africa/Addis_Ababa', defaultLocale: 'am-ET', logoUrl: 'https://cdn.example.com/logo.png' });
  check('PATCH → 200, trimmed, all four fields', p.status === 200 && p.body.name === 'Settings Renamed' && p.body.defaultTimezone === 'Africa/Addis_Ababa' && p.body.defaultLocale === 'am-ET' && p.body.logoUrl === 'https://cdn.example.com/logo.png', p.body);
  check('slug unchanged by rename', p.body.slug === g.body.slug, [g.body.slug, p.body.slug]);
  const sneaky = await O.c.patch('/organization', { slug: 'hijack', status: 'suspended', ownerUserId: '00000000-0000-7000-8000-000000000000' });
  const after = await O.c.get('/organization');
  check('slug/status/owner are not editable (ignored)', sneaky.status === 200 && after.body.slug === g.body.slug && after.body.status === 'active' && after.body.ownerUserId === O.user.id, after.body);
  for (const [body, label] of [
    [{ defaultTimezone: 'Mars/Olympus' }, 'unknown time zone'],
    [{ defaultLocale: 'EN_us' }, 'non-canonical locale'],
    [{ logoUrl: 'http://insecure.example.com/x.png' }, 'http (not https) logo'],
    [{ logoUrl: 'javascript:alert(1)' }, 'javascript: logo'],
    [{ name: ' ' }, 'blank name'],
  ]) {
    const r = await O.c.patch('/organization', body);
    check(`PATCH rejects ${label} → 400`, r.status === 400 && code(r) === 'VALIDATION_ERROR', r.body);
  }
  const clear = await O.c.patch('/organization', { logoUrl: null });
  check('logoUrl: null removes the logo', clear.status === 200 && clear.body.logoUrl === null, clear.body);
  const audits = await O.c.get('/audit-logs?action=organization.updated');
  const first = audits.body.data[audits.body.data.length - 1];
  check('organization.updated audited per real change (2: rename+…, logo removal)', audits.body.data.length === 2, audits.body.data.map((a) => a.metadata));
  check('audit records from/to per field', first?.resourceType === 'organization' && first.metadata.changes.name.from === `settings ${run}` && first.metadata.changes.name.to === 'Settings Renamed' && first.metadata.changes.defaultTimezone.to === 'Africa/Addis_Ababa', first);
  const noop = await O.c.patch('/organization', { name: 'Settings Renamed' });
  const audits2 = await O.c.get('/audit-logs?action=organization.updated');
  check('no-op PATCH → 200, no audit row', noop.status === 200 && audits2.body.data.length === 2, audits2.body.data.length);

  // Member: read yes, write no. Other orgs: unreachable by construction.
  const d = await forceVerifiedDomain(O.c, null, `settings-${run}.test`);
  const mu = await O.c.post('/users', { domainId: d, localPart: 'mia', name: 'Mia Member' });
  const M = new Client();
  const ml = await M.post('/auth/login', { email: `mia@settings-${run}.test`, password: mu.body.temporaryPassword });
  await M.post('/auth/password-change', { passwordChangeToken: ml.body.passwordChangeToken, newPassword: PW });
  const mg = await M.get('/organization');
  check('Member GET /organization → 200', mg.status === 200 && mg.body.name === 'Settings Renamed', mg.body);
  const mp = await M.patch('/organization', { name: 'Member Was Here' });
  check('Member PATCH /organization → 403', mp.status === 403, mp.body);
  const ag = await A.c.get('/organization');
  check('another org sees only its own', ag.body.id === A.user.organizationId && ag.body.id !== g.body.id, ag.body.id);
}

section('ADR-011 volume quotas (invite, reissue, signup, password-reset request)');
{
  const Q = await signup('quota');
  const d = await forceVerifiedDomain(Q.c, null, `quota-${run}.test`);
  const orgId = Q.user.organizationId;

  // Invite: per org. Exhaust the key, expect 429 + Retry-After, then other orgs unaffected.
  const ok1 = await Q.c.post('/users/invite', { domainId: d, localPart: 'i1', contactEmail: `i1-${run}@external.test`, role: 'member' });
  check('invite under quota → 201', ok1.status === 201, ok1.body);
  await exhaust([quotaKey('invite', orgId, 'org')]);
  const blocked = await Q.c.post('/users/invite', { domainId: d, localPart: 'i2', contactEmail: `i2-${run}@external.test`, role: 'member' });
  check('invite over quota → 429 RATE_LIMITED', blocked.status === 429 && code(blocked) === 'RATE_LIMITED', blocked.body);
  const ra = Number(blocked.headers.get('retry-after'));
  check('429 carries Retry-After within the hour', ra > 3000 && ra <= 3600, ra);
  const corsProbe = await fetch(`${API}/users/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Q.c.token}`, Origin: 'http://localhost:3001' },
    body: JSON.stringify({ domainId: d, localPart: 'i9', contactEmail: `i9-${run}@external.test`, role: 'member' }),
  });
  check(
    'CORS exposes Retry-After to the browser app',
    corsProbe.status === 429 && /retry-after/i.test(corsProbe.headers.get('access-control-expose-headers') ?? ''),
    [corsProbe.status, corsProbe.headers.get('access-control-expose-headers')],
  );
  check('429 body repeats it as details.retryAfterSeconds', blocked.body.error.details.retryAfterSeconds === ra, blocked.body.error.details);
  const pend = await Q.c.get('/invites');
  check('blocked invite created nothing', pend.body.data.length === 1, pend.body.data.length);
  const R = await signup('quota2');
  const d2 = await forceVerifiedDomain(R.c, null, `quota2-${run}.test`);
  const other = await R.c.post('/users/invite', { domainId: d2, localPart: 'x1', contactEmail: `x1-${run}@external.test`, role: 'member' });
  check('other orgs are not affected', other.status === 201, other.body);
  // Window expiry: an old window resets to a fresh count.
  await db.query(`UPDATE control.auth_rate_limits SET window_started_at = now() - interval '61 minutes' WHERE key = $1`, [quotaKey('invite', orgId, 'org')]);
  const ok2 = await Q.c.post('/users/invite', { domainId: d, localPart: 'i3', contactEmail: `i3-${run}@external.test`, role: 'member' });
  check('after the window ends → allowed again (count restarts)', ok2.status === 201, ok2.body);
  const row = await db.query('SELECT failures FROM control.auth_rate_limits WHERE key = $1', [quotaKey('invite', orgId, 'org')]);
  check('…and the counter restarted at 1', row.rows[0].failures === 1, row.rows[0]);

  // Reissue per target: real counting against the configured limit.
  const mk = await Q.c.post('/users', { domainId: d, localPart: 'rex', name: 'Rex Reissue' });
  const limit = Number(process.env.RATE_LIMIT_REISSUES_PER_USER_PER_HOUR ?? 5);
  let statuses = [];
  for (let i = 0; i < limit; i++) statuses.push((await Q.c.post(`/users/${mk.body.userId}/password/reissue`, {})).status);
  check(`${limit} reissues for one user → all 200`, statuses.every((x) => x === 200), statuses);
  const over = await Q.c.post(`/users/${mk.body.userId}/password/reissue`, {});
  check(`reissue #${limit + 1} for the same user → 429`, over.status === 429 && code(over) === 'RATE_LIMITED', over.body);
  const mk2 = await Q.c.post('/users', { domainId: d, localPart: 'rita', name: 'Rita Reissue' });
  const otherTarget = await Q.c.post(`/users/${mk2.body.userId}/password/reissue`, {});
  check('a different user can still be reissued', otherTarget.status === 200, otherTarget.body);
  await exhaust([quotaKey('reissue-org', orgId, 'org')]);
  const orgCap = await Q.c.post(`/users/${mk2.body.userId}/password/reissue`, {});
  check('per-org reissue cap → 429', orgCap.status === 429, orgCap.body);

  // Signup per IP (public).
  await exhaust(localKeys('signup', '-'));
  const s = await new Client().post('/organizations', { organizationName: `blocked ${run}`, ownerContactEmail: `blocked-${run}@external.test`, ownerName: 'B', password: PW });
  check('signup over per-IP quota → 429 + Retry-After', s.status === 429 && code(s) === 'RATE_LIMITED' && Number(s.headers.get('retry-after')) > 0, s.body);
  const created = await db.query('SELECT 1 FROM control.user_directory WHERE email = $1', [`blocked-${run}@external.test`]);
  check('blocked signup created nothing', created.rowCount === 0, created.rowCount);
  await clearSignupQuota();

  // Password-reset request: per email+IP, then per IP — same 429 for known and unknown emails.
  const knownEmail = Q.email;
  const unknownEmail = `nobody-${run}@external.test`;
  await exhaust([...localKeys('reset-request', knownEmail), ...localKeys('reset-request', unknownEmail)]);
  const rk = await new Client().post('/auth/password-reset/request', { email: knownEmail });
  const ru = await new Client().post('/auth/password-reset/request', { email: unknownEmail });
  check('reset request over quota → 429 for a known email', rk.status === 429, rk.body);
  check('…and identically for an unknown one (no account enumeration)', ru.status === 429 && JSON.stringify(ru.body) === JSON.stringify(rk.body), [rk.body, ru.body]);
  await db.query('DELETE FROM control.auth_rate_limits WHERE key = ANY($1)', [[...localKeys('reset-request', knownEmail), ...localKeys('reset-request', unknownEmail)]]);
  await exhaust(localKeys('reset-request-ip', '-'));
  const rip = await new Client().post('/auth/password-reset/request', { email: `fresh-${run}@external.test` });
  check('reset request over per-IP quota → 429', rip.status === 429, rip.body);
  await db.query('DELETE FROM control.auth_rate_limits WHERE key = ANY($1)', [localKeys('reset-request-ip', '-')]);
  const fine = await new Client().post('/auth/password-reset/request', { email: `fresh-${run}@external.test` });
  check('after clearing → generic 200 again', fine.status === 200, fine.body);
}

await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}
