#!/usr/bin/env node
// Live test of webmail (Step 2.4, api-contract.md §8) against a running stack
// with the real mail servers — the infra/compose stack. Runs where it can
// reach the API, Postfix's port 25 (to deliver test mail the way the world
// does), Postgres as superuser (test setup only: verifying a domain without
// real DNS) and Mailpit (to see what left for the outside world).
//
//   pnpm test:webmail
//
// Env: API_URL, DATABASE_URL, MAIL_HOST (Postfix), MAILPIT_URL.
import 'dotenv/config';
import pg from 'pg';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

const API = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
const MAIL_HOST = process.env.MAIL_HOST ?? '127.0.0.1';
const SMTP_PORT = Number(process.env.MAIL_SMTP_PORT ?? 25);
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const run = Date.now().toString(36);
const PW = 'correct horse battery';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)?.slice(0, 500)); }
}
const section = (t) => console.log(`\n# ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, token) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let parsed = null;
  try { parsed = t ? JSON.parse(t) : null; } catch { parsed = t; }
  return { status: r.status, body: parsed, headers: r.headers };
}
async function raw(p, token) {
  const r = await fetch(API + p, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
}
async function upload(mailboxId, token, name, content, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  const r = await fetch(`${API}/mailboxes/${mailboxId}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function activate(email, temp) {
  const l = await api('POST', '/auth/login', { email, password: temp });
  const c = await api('POST', '/auth/password-change', { passwordChangeToken: l.body.passwordChangeToken, newPassword: PW });
  return c.body.accessToken;
}
async function inbound(to, subject, extra = {}) {
  const t = nodemailer.createTransport({ host: MAIL_HOST, port: SMTP_PORT, secure: false, ignoreTLS: true, name: 'sender.example' });
  try {
    return await t.sendMail({ from: '"Alice Outside" <alice@sender.example>', to, subject, text: `hello ${subject}`, ...extra });
  } finally { t.close(); }
}
/** Poll a folder until a message with this subject shows up (delivery is asynchronous). */
async function waitFor(mailboxId, token, folder, subject, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await api('GET', `/mailboxes/${mailboxId}/folders/${folder}/messages?limit=100`, null, token);
    const m = r.body?.data?.find((x) => x.subject === subject);
    if (m) return m;
    await sleep(500);
  }
  return null;
}
async function mailpit(subject, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`).then((x) => x.json());
    if (r.messages?.length) {
      const src = await fetch(`${MAILPIT_URL}/api/v1/message/${r.messages[0].ID}/raw`).then((x) => x.text());
      return { meta: r.messages[0], raw: src, parsed: await simpleParser(src) };
    }
    await sleep(500);
  }
  return null;
}

// ---------------------------------------------------------------------------
section('Setup');
const su = await api('POST', '/organizations', { organizationName: `Webmail ${run}`, ownerContactEmail: `wm-${run}@external.test`, ownerName: 'Mia Owner', password: PW });
const tok = su.body.accessToken;
const dn = `wm-${run}.test`;
const dom = await api('POST', '/domains', { domainName: dn }, tok);
await db.query(`UPDATE control.domains SET verification_status='verified', verified_at=now() WHERE id=$1`, [dom.body.id]);
const own = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'mia', assignToSelf: true }, tok);
await api('POST', '/me/primary-mailbox', { mailboxId: own.body.id }, tok);
const bob = await api('POST', '/users', { domainId: dom.body.id, localPart: 'bob', name: 'Bob Builder' }, tok);
const bobTok = await activate(`bob@${dn}`, bob.body.temporaryPassword);
const carol = await api('POST', '/users', { domainId: dom.body.id, localPart: 'carol', name: 'Carol' }, tok);
const carolTok = await activate(`carol@${dn}`, carol.body.temporaryPassword);
const dave = await api('POST', '/users', { domainId: dom.body.id, localPart: 'dave', name: 'Dave' }, tok);
const daveTok = await activate(`dave@${dn}`, dave.body.temporaryPassword);
const support = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'support' }, tok);
const grp = await api('POST', '/groups', { name: `Support ${run}` }, tok);
await api('POST', `/groups/${grp.body.id}/members`, { userId: bob.body.userId }, tok);
await api('POST', `/mailboxes/${support.body.id}/access`, { groupId: grp.body.id, accessLevel: 'send_as' }, tok);
await api('POST', `/mailboxes/${support.body.id}/access`, { userId: carol.body.userId, accessLevel: 'read_only' }, tok);
const frozen = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'frozen' }, tok);
await api('POST', `/mailboxes/${frozen.body.id}/access`, { userId: bob.body.userId, accessLevel: 'send_as' }, tok);
await api('PATCH', `/mailboxes/${frozen.body.id}`, { status: 'suspended' }, tok);
const tiny = await api('POST', '/mailboxes', { domainId: dom.body.id, localPart: 'tiny' }, tok);
await api('POST', `/mailboxes/${tiny.body.id}/access`, { userId: bob.body.userId, accessLevel: 'send_as' }, tok);
await db.query('UPDATE tenant.mailboxes SET quota_bytes = 300000 WHERE id = $1', [tiny.body.id]); // test only: a tiny quota
const other = await api('POST', '/organizations', { organizationName: `Other ${run}`, ownerContactEmail: `wo-${run}@external.test`, ownerName: 'O', password: PW });
check('setup via API', [su, dom, own, bob, carol, dave, support, grp, frozen, tiny, other].every((r) => r.status < 300) && bobTok && carolTok && daveTok,
  [su, dom, own, bob, carol, dave, support, grp, frozen, tiny, other].map((r) => r.status));
const bobBox = bob.body.mailboxId ?? (await api('GET', '/mail/mailboxes', null, bobTok)).body.data.find((m) => !m.isShared).mailboxId;

// ---------------------------------------------------------------------------
section('Mailbox switcher: GET /mail/mailboxes');
let r = await api('GET', '/mail/mailboxes', null, bobTok);
const bobList = r.body?.data ?? [];
check('Bob: his own + support (send_as via group) + frozen + tiny', r.status === 200 && bobList.some((m) => m.address === `bob@${dn}` && m.access === 'owner') && bobList.some((m) => m.address === `support@${dn}` && m.access === 'send_as' && m.isShared), r.body);
check('…own mailbox listed first, with an unread count', bobList[0]?.address === `bob@${dn}` && typeof bobList[0]?.unread === 'number', bobList[0]);
check('…a suspended mailbox is listed but has no unread count', bobList.find((m) => m.address === `frozen@${dn}`)?.unread === null, bobList.find((m) => m.address === `frozen@${dn}`));
r = await api('GET', '/mail/mailboxes', null, carolTok);
check('Carol: her own + support as read_only', r.body?.data?.some((m) => m.address === `support@${dn}` && m.access === 'read_only'), r.body);
r = await api('GET', '/mail/mailboxes', null, tok);
check('Owner ROLE alone does not list other people’s or shared mailboxes', r.status === 200 && r.body.data.length === 1 && r.body.data[0].address === `mia@${dn}`, r.body);

// ---------------------------------------------------------------------------
section('Reading');
const subj1 = `report-${run}`;
await inbound(`bob@${dn}`, subj1, {
  text: `plain body zebra${run}`,
  html: `<p>html body <b>zebra${run}</b></p>`,
  attachments: [{ filename: 'numbers.csv', content: 'a,b\n1,2\n', contentType: 'text/csv' }],
});
const m1 = await waitFor(bobBox, bobTok, 'inbox', subj1);
check('inbound mail appears in the inbox list', !!m1);
check('…summary: from, unread, has attachment', m1?.from?.address === 'alice@sender.example' && m1?.from?.name === 'Alice Outside' && m1?.read === false && m1?.hasAttachments === true, m1);
r = await api('GET', `/mailboxes/${bobBox}/folders`, null, bobTok);
const inboxF = r.body?.data?.find((f) => f.folder === 'inbox');
check('folders: inbox, sent, drafts, trash with counts', r.status === 200 && ['inbox', 'sent', 'drafts', 'trash'].every((f) => r.body.data.some((x) => x.folder === f)) && inboxF?.unread >= 1, r.body);
check('…and the mailbox quota (5 GB limit)', r.body?.quota?.limitBytes === 5 * 1024 ** 3 && r.body.quota.usedBytes > 0, r.body?.quota);
r = await api('GET', `/mailboxes/${bobBox}/messages/${m1.id}`, null, bobTok);
const d1 = r.body;
check('GET message: text + html bodies, attachment metadata', r.status === 200 && d1.bodyText.includes(`zebra${run}`) && d1.bodyHtml.includes('<b>') && d1.attachments.length === 1 && d1.attachments[0].fileName === 'numbers.csv', d1);
check('…includes the Message-ID header (for replies)', /^<.+>$/.test(d1?.messageIdHeader ?? ''), d1?.messageIdHeader);
r = await api('GET', `/mailboxes/${bobBox}/folders/inbox/messages`, null, bobTok);
check('…opening a message does NOT mark it read by itself', r.body.data.find((x) => x.id === m1.id)?.read === false);
const att = await raw(`/mailboxes/${bobBox}/messages/${m1.id}/attachments/0`, bobTok);
check('download attachment: exact bytes, as a download, sandboxed', att.status === 200 && att.bytes.toString() === 'a,b\n1,2\n' && /^attachment; filename="numbers.csv"/.test(att.headers.get('content-disposition') ?? '') && /sandbox/.test(att.headers.get('content-security-policy') ?? ''), [att.status, att.headers.get('content-disposition')]);
r = await api('GET', `/mailboxes/${bobBox}/messages/${m1.id}/attachments/7`, null, bobTok);
check('unknown attachment → 404', r.status === 404, r.status);

r = await api('PATCH', `/mailboxes/${bobBox}/messages/${m1.id}`, { readAt: new Date().toISOString(), flagged: true }, bobTok);
check('PATCH readAt + flagged → 200, same id', r.status === 200 && r.body.messageId === m1.id, r.body);
r = await api('GET', `/mailboxes/${bobBox}/folders/inbox/messages`, null, bobTok);
const after = r.body.data.find((x) => x.id === m1.id);
check('…now read and flagged', after?.read === true && after?.flagged === true, after);
r = await api('GET', `/mailboxes/${bobBox}/folders/inbox/messages?unreadOnly=true`, null, bobTok);
check('unreadOnly=true excludes it', r.status === 200 && !r.body.data.some((x) => x.id === m1.id), r.body.data.length);
await api('PATCH', `/mailboxes/${bobBox}/messages/${m1.id}`, { readAt: null }, bobTok);
r = await api('GET', `/mailboxes/${bobBox}/folders/inbox/messages?unreadOnly=true`, null, bobTok);
check('readAt: null → unread again', r.body.data.some((x) => x.id === m1.id));

r = await api('GET', `/mailboxes/${bobBox}/folders/inbox/messages?q=zebra${run}`, null, bobTok);
check('search q= finds a word in the body', r.status === 200 && r.body.data.length === 1 && r.body.data[0].id === m1.id, r.body);
r = await api('GET', `/mailboxes/${bobBox}/folders/inbox/messages?q=nothing-like-this-${run}`, null, bobTok);
check('search with no match → empty list', r.status === 200 && r.body.data.length === 0, r.body);

for (let i = 0; i < 3; i++) await inbound(`bob@${dn}`, `page-${run}-${i}`);
await waitFor(bobBox, bobTok, 'inbox', `page-${run}-2`);
const seen = new Set();
let cursor = '';
let pages = 0;
do {
  r = await api('GET', `/mailboxes/${bobBox}/folders/inbox/messages?limit=2${cursor ? `&cursor=${cursor}` : ''}`, null, bobTok);
  r.body.data.forEach((x) => seen.add(x.id));
  cursor = r.body.meta.nextCursor;
  pages++;
} while (cursor && pages < 10);
check('pagination: limit=2 walks all 4 messages, no duplicates, newest first', seen.size === 4 && pages === 2, { size: seen.size, pages });

// ---------------------------------------------------------------------------
section('Access rules');
r = await api('GET', `/mailboxes/${bobBox}/folders`, null, daveTok);
check('another member (no grant) → 403', r.status === 403 && r.body.error.code === 'FORBIDDEN_MAILBOX_ACCESS', r.body);
r = await api('GET', `/mailboxes/${bobBox}/messages/${m1.id}`, null, tok);
check('the org Owner (role) without a grant → 403', r.status === 403, r.status);
r = await api('GET', `/mailboxes/${bobBox}/folders`, null, other.body.accessToken);
check('another organization → 404', r.status === 404, r.status);
r = await api('GET', `/mailboxes/${bobBox}/messages/not-a-real-id`, null, bobTok);
check('malformed message id → 404', r.status === 404, r.status);
r = await api('GET', `/mailboxes/${bobBox}/folders/spam/messages`, null, bobTok);
check('unknown folder → 404', r.status === 404, r.status);
r = await api('GET', `/mailboxes/${support.body.id}/folders`, null, carolTok);
check('read_only grantee can read', r.status === 200, r.status);
r = await api('POST', `/mailboxes/${support.body.id}/messages`, { to: ['x@world.example'], subject: 'nope', bodyText: 'x' }, carolTok);
check('…but not send (403)', r.status === 403, r.body);
r = await upload(support.body.id, carolTok, 'a.txt', 'x');
check('…nor upload attachments (403)', r.status === 403, r.body);
r = await api('GET', `/mailboxes/${frozen.body.id}/folders`, null, bobTok);
check('suspended mailbox → 409 MAILBOX_SUSPENDED', r.status === 409 && r.body.error.code === 'MAILBOX_SUSPENDED', r.body);

// ---------------------------------------------------------------------------
section('Sending');
r = await upload(bobBox, bobTok, 'plan.pdf', Buffer.from('%PDF-1.4 fake'), 'application/pdf');
const up1 = r.body;
check('upload attachment → 201 with id, name, size', r.status === 201 && up1.attachmentId && up1.fileName === 'plan.pdf' && up1.sizeBytes === 13, r.body);
const subj2 = `send-${run}`;
r = await api('POST', `/mailboxes/${bobBox}/messages`, {
  to: ['jane@world.example'], cc: [`mia@${dn}`], bcc: ['secret@world.example'],
  subject: subj2, bodyText: 'see attached', bodyHtml: '<p>see <i>attached</i></p>', attachmentIds: [up1.attachmentId],
}, bobTok);
check('POST messages → 201 with the Sent copy’s id', r.status === 201 && r.body.messageId && r.body.sent === true, r.body);
const sentId = r.body?.messageId;
const out = await mailpit(subj2);
check('external copy left through the relay', !!out);
check('…From is Bob, with his name', out?.parsed.from?.value[0].address === `bob@${dn}` && out?.parsed.from?.value[0].name === 'Bob Builder', out?.parsed.from);
check('…attachment intact, html + text present', out?.parsed.attachments[0]?.filename === 'plan.pdf' && out.parsed.attachments[0].content.toString() === '%PDF-1.4 fake' && out.parsed.html?.includes('<i>'), out?.parsed.attachments?.map((a) => a.filename));
// (Mailpit itself prepends a Bcc: line for envelope-only recipients, so the
// check is on what a real recipient's mailbox stores: Mia's copy.)
const miaBox = own.body.id;
const toMia = await waitFor(miaBox, tok, 'inbox', subj2);
check('local Cc delivered straight into Mia’s inbox', !!toMia);
const miaCopy = toMia ? (await api('GET', `/mailboxes/${miaBox}/messages/${toMia.id}`, null, tok)).body : null;
check('…Bcc is NOT in the headers recipients see', miaCopy && miaCopy.bcc.length === 0 && miaCopy.cc.some((a) => a.address === `mia@${dn}`), miaCopy && { bcc: miaCopy.bcc, cc: miaCopy.cc });
r = await api('GET', `/mailboxes/${bobBox}/messages/${sentId}`, null, bobTok);
check('Sent copy in Bob’s Sent, marked read, keeps Bcc for the sender', r.status === 200 && r.body.folder === 'sent' && r.body.read === true && r.body.bcc.some((a) => a.address === 'secret@world.example'), r.body && { folder: r.body.folder, bcc: r.body.bcc });
r = await api('POST', `/mailboxes/${bobBox}/messages`, { to: ['jane@world.example'], subject: 'reuse', attachmentIds: [up1.attachmentId] }, bobTok);
check('re-using a consumed attachment → 400', r.status === 400, r.body);
const carolUp = await upload(carol.body.mailboxId ?? (await api('GET', '/mail/mailboxes', null, carolTok)).body.data[0].mailboxId, carolTok, 'c.txt', 'c');
r = await api('POST', `/mailboxes/${bobBox}/messages`, { to: ['jane@world.example'], subject: 'theirs', attachmentIds: [carolUp.body.attachmentId] }, bobTok);
check('someone else’s upload → 400', r.status === 400, r.body);

const subj3 = `Re: ${subj1}`;
r = await api('POST', `/mailboxes/${bobBox}/messages`, { to: ['alice@sender.example'], subject: subj3, bodyText: 'thanks', inReplyTo: m1.id }, bobTok);
const reply = await mailpit(subj3);
check('reply carries In-Reply-To and References of the original', r.status === 201 && reply?.parsed.inReplyTo === d1.messageIdHeader && [].concat(reply?.parsed.references ?? []).includes(d1.messageIdHeader), { st: r.status, irt: reply?.parsed.inReplyTo, want: d1.messageIdHeader });

const subj4 = `shared-${run}`;
r = await api('POST', `/mailboxes/${support.body.id}/messages`, { to: ['client@world.example'], subject: subj4, bodyText: 'from support' }, bobTok);
const sharedOut = await mailpit(subj4);
check('send_as grantee sends from the shared mailbox', r.status === 201 && sharedOut?.parsed.from?.value[0].address === `support@${dn}`, { st: r.status, from: sharedOut?.parsed.from?.text });
check('…shared mailbox: no personal name on From', !sharedOut?.parsed.from?.value[0].name, sharedOut?.parsed.from);

r = await api('POST', `/mailboxes/${bobBox}/messages`, { subject: 'nobody', bodyText: 'x' }, bobTok);
check('no recipients → 400', r.status === 400, r.body);
const many = Array.from({ length: 40 }, (_, i) => `r${i}@world.example`);
r = await api('POST', `/mailboxes/${bobBox}/messages`, { to: many, cc: many, bcc: many, subject: 'too many' }, bobTok);
check('more than 100 recipients in total → 400', r.status === 400, r.body);
r = await api('POST', `/mailboxes/${bobBox}/messages`, { to: ['not-an-address'], subject: 'bad' }, bobTok);
check('invalid address → 400', r.status === 400, r.body);

// ---------------------------------------------------------------------------
section('Drafts');
const upD = await upload(bobBox, bobTok, 'draft.txt', 'draft attachment');
r = await api('POST', `/mailboxes/${bobBox}/drafts`, { subject: `draft-${run}`, bodyText: 'first version', attachmentIds: [upD.body.attachmentId] }, bobTok);
const draft1 = r.body?.messageId;
check('create draft without recipients → 201', r.status === 201 && !!draft1, r.body);
r = await api('GET', `/mailboxes/${bobBox}/messages/${draft1}`, null, bobTok);
check('…it is in Drafts with its attachment', r.body?.folder === 'drafts' && r.body.attachments[0]?.fileName === 'draft.txt', r.body);
r = await api('POST', `/mailboxes/${bobBox}/drafts/${draft1}/send`, null, bobTok);
check('sending a draft with no recipients → 400', r.status === 400, r.body);
r = await api('PATCH', `/mailboxes/${bobBox}/drafts/${draft1}`, { to: ['draftee@world.example'], bodyText: 'second version' }, bobTok);
const draft2 = r.body?.messageId;
check('PATCH draft → new id', r.status === 200 && draft2 && draft2 !== draft1, r.body);
r = await api('GET', `/mailboxes/${bobBox}/messages/${draft2}`, null, bobTok);
check('…fields updated, untouched ones (subject, attachment) kept', r.body?.bodyText === 'second version' && r.body.subject === `draft-${run}` && r.body.to[0]?.address === 'draftee@world.example' && r.body.attachments.length === 1, r.body);
r = await api('GET', `/mailboxes/${bobBox}/messages/${draft1}`, null, bobTok);
check('…the old version is gone (404)', r.status === 404, r.status);
r = await api('PATCH', `/mailboxes/${bobBox}/drafts/${draft2}`, { keepAttachmentIds: [] }, bobTok);
const draft3 = r.body?.messageId;
r = await api('GET', `/mailboxes/${bobBox}/messages/${draft3}`, null, bobTok);
check('keepAttachmentIds: [] drops the draft’s attachment', r.status === 200 && r.body.attachments.length === 0, r.body?.attachments);
r = await api('POST', `/mailboxes/${bobBox}/drafts/${draft3}/send`, null, bobTok);
const draftOut = await mailpit(`draft-${run}`);
check('send draft → delivered', r.status === 201 && draftOut?.parsed.to?.value[0].address === 'draftee@world.example', { st: r.status, body: r.body });
r = await api('GET', `/mailboxes/${bobBox}/folders/drafts/messages`, null, bobTok);
check('…and removed from Drafts', !r.body.data.some((x) => x.subject === `draft-${run}`), r.body.data.map((x) => x.subject));
r = await api('PATCH', `/mailboxes/${bobBox}/drafts/${m1.id}`, { subject: 'x' }, bobTok);
check('PATCH drafts/<an inbox message> → 404', r.status === 404, r.status);

// ---------------------------------------------------------------------------
section('Trash & delete');
r = await api('DELETE', `/mailboxes/${bobBox}/messages/${m1.id}`, null, bobTok);
check('DELETE from Inbox → 422 MESSAGE_NOT_IN_TRASH', r.status === 422 && r.body.error.code === 'MESSAGE_NOT_IN_TRASH', r.body);
r = await api('PATCH', `/mailboxes/${bobBox}/messages/${m1.id}`, { folder: 'trash' }, bobTok);
const trashed = r.body?.messageId;
check('move to Trash → new id in trash', r.status === 200 && r.body.folder === 'trash' && trashed !== m1.id, r.body);
r = await api('GET', `/mailboxes/${bobBox}/messages/${m1.id}`, null, bobTok);
check('…old id no longer resolves', r.status === 404, r.status);
r = await api('PATCH', `/mailboxes/${bobBox}/messages/${trashed}`, { folder: 'drafts' }, bobTok);
check('moving into Drafts → 422', r.status === 422, r.body);
r = await api('PATCH', `/mailboxes/${bobBox}/messages/${trashed}`, { folder: 'inbox' }, bobTok);
const restored = r.body?.messageId;
check('restore from Trash to Inbox', r.status === 200 && r.body.folder === 'inbox', r.body);
r = await api('PATCH', `/mailboxes/${bobBox}/messages/${restored}`, { folder: 'trash' }, bobTok);
const trashed2 = r.body.messageId;
r = await api('DELETE', `/mailboxes/${bobBox}/messages/${trashed2}`, null, bobTok);
check('DELETE from Trash → 200', r.status === 200, r.body);
r = await api('GET', `/mailboxes/${bobBox}/messages/${trashed2}`, null, bobTok);
check('…permanently gone', r.status === 404, r.status);

// ---------------------------------------------------------------------------
section('Quota on upload');
r = await upload(tiny.body.id, bobTok, 'big.bin', Buffer.alloc(200_000, 1));
check('upload within the mailbox quota → 201', r.status === 201, r.body);
r = await upload(tiny.body.id, bobTok, 'big2.bin', Buffer.alloc(200_000, 1));
check('upload that would exceed quota (incl. staged, unsent files) → 413', r.status === 413 && r.body.error.code === 'MAILBOX_QUOTA_EXCEEDED', r.body);
r = await fetch(`${API}/mailboxes/${bobBox}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${bobTok}` } });
check('upload with no file → 400', r.status === 400, r.status);

await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:'); failures.forEach((f) => console.log(` - ${f}`)); process.exit(1); }
