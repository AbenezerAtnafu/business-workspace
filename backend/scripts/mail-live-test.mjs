#!/usr/bin/env node
// Live test of the mail infrastructure (Step 2.1, ADR-012) against a running
// stack — the Docker compose dev stack, infra/scripts/native-up.sh, or a real
// server. Drives it the way the world does: SMTP on 25, submission on 587,
// IMAP/POP3, the internal API port, and checks what reaches the outbound relay.
//
//   pnpm test:mail
//
// Needs: the API (API_URL), Postgres as superuser (DATABASE_URL, for test
// setup only: verifying a domain and installing a DKIM key, which need real
// DNS otherwise), and the mail host (MAIL_HOST). Outbound mail is checked in
// a Maildir (RELAY_SINK_DIR, e.g. the aiosmtpd sink) or in Mailpit
// (MAILPIT_URL). ENCRYPTION_KEY must match the API's, to install a DKIM key.
import 'dotenv/config';
import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { authenticate } from 'mailauth';

const API = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
const MAIL_HOST = process.env.MAIL_HOST ?? '127.0.0.1'; // Postfix
const IMAP_HOST = process.env.MAIL_IMAP_HOST ?? MAIL_HOST; // Dovecot (a separate container in compose)
const SMTP_PORT = Number(process.env.MAIL_SMTP_PORT ?? 25);
const SUBMIT_PORT = Number(process.env.MAIL_SUBMISSION_PORT ?? 587);
const INTERNAL_PORT = Number(process.env.MAIL_INTERNAL_PORT ?? 10025);
const IMAP_PORT = Number(process.env.MAIL_IMAP_PORT ?? 143);
const POP3_PORT = Number(process.env.MAIL_POP3_PORT ?? 110);
const MASTER_USER = process.env.DOVECOT_MASTER_USER ?? 'apimaster';
const MASTER_PASSWORD = process.env.DOVECOT_MASTER_PASSWORD ?? 'apimaster_dev_password';
const RELAY_SINK_DIR = process.env.RELAY_SINK_DIR;
const MAILPIT_URL = process.env.MAILPIT_URL;
const DKIM_KEY_DIR = process.env.DKIM_KEY_DIR;
const run = Date.now().toString(36);
const PW = 'correct horse battery';
const tls = { rejectUnauthorized: false }; // dev stack uses a self-signed certificate

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)?.slice(0, 400)); }
}
const section = (t) => console.log(`\n# ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, token) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function activate(email, temp) {
  const l = await api('POST', '/auth/login', { email, password: temp });
  const c = await api('POST', '/auth/password-change', { passwordChangeToken: l.body.passwordChangeToken, newPassword: PW });
  return c.body.accessToken;
}
/** Send one message; resolves { ok, response } or { ok:false, error, code, responseCode }. */
async function send({ port, auth, from, to, subject, text = 'hello', extra = {} }) {
  const t = nodemailer.createTransport({ host: MAIL_HOST, port, secure: false, auth, tls, name: 'tester.example', ignoreTLS: port === INTERNAL_PORT, requireTLS: port === SUBMIT_PORT });
  try {
    const info = await t.sendMail({ from, to, subject, text, ...extra });
    return { ok: true, response: info.response, rejected: info.rejected };
  } catch (err) {
    return { ok: false, error: err.message, responseCode: err.responseCode };
  } finally {
    t.close();
  }
}
async function imap(user, pass) {
  const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user, pass }, tls, logger: false, doSTARTTLS: true });
  await c.connect();
  return c;
}
async function imapLoginOk(user, pass) {
  try { const c = await imap(user, pass); await c.logout(); return true; } catch { return false; }
}
async function findInInbox(user, pass, subject, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const c = await imap(user, pass);
    try {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const uids = await c.search({ subject }, { uid: true });
        if (uids.length) {
          const msg = await c.fetchOne(String(uids[uids.length - 1]), { source: true }, { uid: true });
          return msg.source.toString();
        }
      } finally { lock.release(); }
    } finally { await c.logout(); }
    await sleep(500);
  }
  return null;
}
/** Messages that reached the outbound relay, matching a subject. */
async function relayed(subject, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (MAILPIT_URL) {
      const r = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`).then((x) => x.json());
      if (r.messages?.length) return fetch(`${MAILPIT_URL}/api/v1/message/${r.messages[0].ID}/raw`).then((x) => x.text());
    } else if (RELAY_SINK_DIR) {
      for (const sub of ['new', 'cur']) {
        const dir = path.join(RELAY_SINK_DIR, sub);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8');
          if (raw.includes(`Subject: ${subject}`)) return raw;
        }
      }
    }
    await sleep(500);
  }
  return null;
}
function pop3Stat(user, pass) {
  return new Promise((resolve) => {
    const s = net.connect(POP3_PORT, IMAP_HOST);
    const steps = [null, `USER ${user}`, `PASS ${pass}`, 'STAT', 'QUIT'];
    const out = [];
    let i = 0;
    s.on('data', (d) => {
      out.push(d.toString().trim());
      i++;
      if (i < steps.length) s.write(steps[i] + '\r\n');
    });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    setTimeout(() => s.destroy(), 8000);
  });
}

// ---------------------------------------------------------------------------
section('Setup (API + test-only SQL: verify domain, install DKIM key)');
const enc = createHash('sha256').update(process.env.ENCRYPTION_KEY ?? '').digest();
const encrypt = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', enc, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
};
const ownerContact = `mt-${run}@external.test`;
const su = await api('POST', '/organizations', { organizationName: `Mail ${run}`, ownerContactEmail: ownerContact, ownerName: 'Mia Owner', password: PW });
const tok = su.body.accessToken;
const dn = `mail-${run}.test`;
const dom = await api('POST', '/domains', { domainName: dn }, tok);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const pubB64 = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const selector = `s${run}`;
await db.query(
  `UPDATE control.domains SET verification_status='verified', verified_at=now(), dkim_selector=$2, dkim_private_key=$3, dkim_public_key=$4 WHERE id=$1`,
  [dom.body.id, selector, encrypt(privateKey), pubB64],
);
// Owner claims owner@ so they have a login mailbox.
const own = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'mia', assignToSelf: true }, tok);
await api('POST', '/me/primary-mailbox', { mailboxId: own.body.id }, tok);
const bob = await api('POST', '/users', { domainId: dom.body.id, localPart: 'bob', name: 'Bob' }, tok);
await activate(`bob@${dn}`, bob.body.temporaryPassword);
const carol = await api('POST', '/users', { domainId: dom.body.id, localPart: 'carol', name: 'Carol' }, tok); // never changes her temp password
const dave = await api('POST', '/users', { domainId: dom.body.id, localPart: 'dave', name: 'Dave' }, tok);
await activate(`dave@${dn}`, dave.body.temporaryPassword);
await db.query('UPDATE tenant.users SET mfa_enabled = true WHERE id = $1', [dave.body.userId]);
const erin = await api('POST', '/users', { domainId: dom.body.id, localPart: 'erin', name: 'Erin' }, tok);
await activate(`erin@${dn}`, erin.body.temporaryPassword);
await api('PATCH', `/users/${erin.body.userId}`, { status: 'suspended' }, tok);
const support = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'support' }, tok);
await api('POST', `/mailboxes/${support.body.id}/aliases`, { localPart: 'help' }, tok);
const grp = await api('POST', '/groups', { name: `Support ${run}` }, tok);
await api('POST', `/groups/${grp.body.id}/members`, { userId: bob.body.userId }, tok);
await api('POST', `/mailboxes/${support.body.id}/access`, { groupId: grp.body.id, accessLevel: 'send_as' }, tok);
const frozen = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'frozen' }, tok);
await api('PATCH', `/mailboxes/${frozen.body.id}`, { status: 'suspended' }, tok);
const tiny = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'tiny' }, tok);
const other = await api('POST', '/organizations', { organizationName: `Other ${run}`, ownerContactEmail: `mo-${run}@external.test`, ownerName: 'O', password: PW });
const pendingDomain = `pending-${run}.test`;
await api('POST', '/domains', { domainName: pendingDomain }, other.body.accessToken);
check('setup via API', [su, dom, own, bob, carol, dave, erin, support, grp, frozen, tiny, other].every((r) => r.status < 300), [su.status, dom.status, own.status, bob.status]);

if (DKIM_KEY_DIR) {
  execFileSync(process.execPath, ['scripts/export-dkim-keys.mjs', '--out', DKIM_KEY_DIR], { stdio: 'inherit', env: process.env });
  try { execFileSync('chown', ['-R', '_rspamd:_rspamd', DKIM_KEY_DIR]); } catch { /* not needed in containers */ }
  check('DKIM key exported for the domain', fs.existsSync(path.join(DKIM_KEY_DIR, `${dn}.${selector}.key`)), fs.readdirSync(DKIM_KEY_DIR));
}

// ---------------------------------------------------------------------------
section('Inbound (port 25, as the outside world)');
let r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `bob@${dn}`, subject: `in-${run}` });
check('to a mailbox → 250 accepted', r.ok, r);
const inbound = await findInInbox(`bob@${dn}`, PW, `in-${run}`);
check('…delivered to Bob’s INBOX (LMTP → Dovecot)', !!inbound);
check('…scanned by Rspamd on the way in', /X-Spamd-Result|Authentication-Results/i.test(inbound ?? ''), (inbound ?? '').slice(0, 600));
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `help@${dn}`, subject: `alias-${run}` });
check('to an alias → accepted', r.ok, r);
const viaMaster = await findInInbox(`support@${dn}*${MASTER_USER}`, MASTER_PASSWORD, `alias-${run}`);
check('…lands in the target shared mailbox', !!viaMaster);
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `nobody@${dn}`, subject: 'x' });
check('unknown address at a hosted domain → 550 at RCPT', !r.ok && r.responseCode === 550, r);
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `x@${pendingDomain}`, subject: 'x' });
check('domain not verified (another org) → rejected, relay access denied', !r.ok && /relay access denied/i.test(r.error), r);
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `frozen@${dn}`, subject: 'x' });
check('suspended mailbox → 550', !r.ok && r.responseCode === 550, r);
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: 'victim@elsewhere.example', subject: 'x' });
check('open relay attempt → rejected', !r.ok && /relay access denied/i.test(r.error), r);
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `bob@${dn}`, subject: `gtube-${run}`, text: 'XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X' });
check('spam (GTUBE) → rejected by Rspamd', !r.ok && r.responseCode >= 500, r);
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `tiny@${dn}`, subject: `fill-${run}`, text: 'x'.repeat(3000) });
check('a mailbox with room accepts mail', r.ok && !!(await findInInbox(`tiny@${dn}*${MASTER_USER}`, MASTER_PASSWORD, `fill-${run}`)), r);
// Shrink the quota below what's stored (test-only SQL: the API minimum is 1 MiB).
await db.query('UPDATE tenant.mailboxes SET quota_bytes = 1000 WHERE id = $1', [tiny.body.id]);
r = await send({ port: SMTP_PORT, from: 'alice@sender.example', to: `tiny@${dn}`, subject: 'x' });
check('full mailbox → 552 Mailbox is full at RCPT TO (no bounce later)', !r.ok && r.responseCode === 552 && /full/i.test(r.error), r);

// ---------------------------------------------------------------------------
section('Mail-client login (IMAP / POP3) with platform passwords');
check('IMAP: Bob, right password', await imapLoginOk(`bob@${dn}`, PW));
check('IMAP: Bob, wrong password → refused', !(await imapLoginOk(`bob@${dn}`, 'wrong password!')));
check('IMAP: login is case-insensitive', await imapLoginOk(`BOB@${dn.toUpperCase()}`, PW));
check('IMAP: Carol still on a temporary password → refused', !(await imapLoginOk(`carol@${dn}`, carol.body.temporaryPassword)));
check('IMAP: Dave has MFA on → refused (password alone must not bypass MFA)', !(await imapLoginOk(`dave@${dn}`, PW)));
check('IMAP: Erin is suspended → refused', !(await imapLoginOk(`erin@${dn}`, PW)));
check('IMAP: Owner’s old contact email → refused', !(await imapLoginOk(ownerContact, PW)));
check('IMAP: a shared mailbox has no password login', !(await imapLoginOk(`support@${dn}`, PW)));
check('IMAP: API master user can open the shared mailbox', await imapLoginOk(`support@${dn}*${MASTER_USER}`, MASTER_PASSWORD));
check('IMAP: master user with a wrong password → refused', !(await imapLoginOk(`support@${dn}*${MASTER_USER}`, 'nope')));
const folders = await (async () => { const c = await imap(`bob@${dn}`, PW); try { return (await c.list()).map((f) => f.specialUse || f.path); } finally { await c.logout(); } })();
check('fixed folders exist with SPECIAL-USE (Inbox, Sent, Drafts, Trash, Junk)', ['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk'].every((x) => folders.includes(x)), folders);
const q = await (async () => { const c = await imap(`bob@${dn}`, PW); try { return await c.getQuota('INBOX'); } finally { await c.logout(); } })();
check('IMAP quota reflects tenant.mailboxes.quota_bytes (5 GB)', q?.storage?.limit === 5 * 1024 ** 3, q);
const pop = await pop3Stat(`bob@${dn}`, PW);
check('POP3: Bob logs in and gets STAT', pop.some((l) => /^\+OK \d+ \d+/.test(l)), pop);

// ---------------------------------------------------------------------------
section('Submission (587, STARTTLS + AUTH) and DKIM signing');
r = await send({ port: SUBMIT_PORT, auth: { user: `bob@${dn}`, pass: PW }, from: `bob@${dn}`, to: 'friend@world.example', subject: `out-${run}` });
check('Bob sends as himself → accepted', r.ok, r);
const out = await relayed(`out-${run}`);
check('…handed to the outbound relay', !!out);
if (out) {
  const res = await authenticate(Buffer.from(out), {
    resolver: async (name, type) => {
      if (type === 'TXT' && name === `${selector}._domainkey.${dn}`) return [[`v=DKIM1; k=rsa; p=${pubB64}`]];
      const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e;
    },
    trustReceived: false, ip: '127.0.0.1', helo: 'mail.localhost', sender: `bob@${dn}`,
  });
  const dk = res.dkim?.results?.[0];
  check(`…DKIM-signed with the org’s own key (d=${dn}, s=${selector}) and the signature verifies`, dk?.signingDomain === dn && dk?.selector === selector && dk?.status?.result === 'pass', dk?.status);
}
r = await send({ port: SUBMIT_PORT, auth: { user: `bob@${dn}`, pass: PW }, from: `support@${dn}`, to: 'friend@world.example', subject: `asgroup-${run}` });
check('Bob sends as support@ (send_as through his group) → accepted', r.ok, r);
r = await send({ port: SUBMIT_PORT, auth: { user: `bob@${dn}`, pass: PW }, from: `help@${dn}`, to: 'friend@world.example', subject: `asalias-${run}` });
check('…and as its alias help@', r.ok, r);
r = await send({ port: SUBMIT_PORT, auth: { user: `bob@${dn}`, pass: PW }, from: `mia@${dn}`, to: 'friend@world.example', subject: 'x' });
check('Bob sends as the Owner (no grant) → 553 sender login mismatch', !r.ok && /not owned by user|login mismatch/i.test(r.error), r);
r = await send({ port: SUBMIT_PORT, auth: { user: `bob@${dn}`, pass: 'wrong password!' }, from: `bob@${dn}`, to: 'friend@world.example', subject: 'x' });
check('wrong password on 587 → authentication failed', !r.ok && /auth/i.test(r.error), r);
r = await send({ port: SUBMIT_PORT, from: `bob@${dn}`, to: 'friend@world.example', subject: 'x' });
check('no login on 587 → rejected', !r.ok, r);

// ---------------------------------------------------------------------------
section('Internal API submission (webmail send path)');
r = await send({ port: INTERNAL_PORT, from: `support@${dn}`, to: [`bob@${dn}`, 'customer@world.example'], subject: `api-${run}` });
check('API sends from support@ to a local and an external recipient', r.ok, r);
check('…local copy delivered to Bob', !!(await findInInbox(`bob@${dn}`, PW, `api-${run}`)));
const apiOut = await relayed(`api-${run}`);
check('…external copy relayed and DKIM-signed', !!apiOut && /DKIM-Signature:[^]*d=/.test(apiOut), (apiOut ?? '').slice(0, 300));

await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('Failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}
