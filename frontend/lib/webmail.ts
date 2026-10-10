import type { MailAddress, MailFolderId, MailMessageDetail } from '@/lib/api/types';

export const FOLDER_ORDER: MailFolderId[] = ['inbox', 'sent', 'drafts', 'trash'];

export const FOLDER_LABEL: Record<MailFolderId, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
};

export const EMPTY_FOLDER: Record<MailFolderId, string> = {
  inbox: 'No messages in your Inbox.',
  sent: 'Nothing sent yet.',
  drafts: 'No drafts.',
  trash: 'No messages in Trash.',
};

export function isFolder(v: string | null): v is MailFolderId {
  return v !== null && (FOLDER_ORDER as string[]).includes(v);
}

/** "Jane Doe" if there's a name, else the address. */
export function displayName(a: MailAddress | null | undefined): string {
  if (!a) return '(unknown sender)';
  return a.name?.trim() || a.address;
}

/** "Jane Doe <jane@acme.com>" — for headers in the reader and quoted replies. */
export function fullAddress(a: MailAddress): string {
  return a.name?.trim() ? `${a.name} <${a.address}>` : a.address;
}

export function addressList(list: MailAddress[]): string {
  return list.map(fullAddress).join(', ');
}

/** List-row date: time for today, "Mon 3" this year, full date otherwise. */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * "a@x.com, Bob <b@y.com>; c@z.com" → addresses + anything that isn't one.
 * Names in angle-bracket form are accepted and dropped (the API takes plain
 * addresses).
 */
export function parseRecipients(input: string): { addresses: string[]; invalid: string[] } {
  const addresses: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[,;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const angle = /<([^>]+)>\s*$/.exec(part);
    const addr = (angle ? angle[1] : part).trim().toLowerCase();
    if (EMAIL.test(addr)) {
      if (!addresses.includes(addr)) addresses.push(addr);
    } else invalid.push(part);
  }
  return { addresses, invalid };
}

function prefixed(prefix: 'Re' | 'Fwd', subject: string): string {
  const s = subject.trim();
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`;
}

function quote(m: MailMessageDetail): string {
  const when = m.date ? new Date(m.date).toLocaleString() : 'an earlier date';
  const body = (m.bodyText ?? '').replace(/\s+$/, '');
  return `\n\nOn ${when}, ${m.from ? fullAddress(m.from) : 'someone'} wrote:\n${body
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}`;
}

/** Prefill for Reply / Reply all / Forward (plain text). */
export function replyDraft(
  m: MailMessageDetail,
  mode: 'reply' | 'replyAll' | 'forward',
  ownAddress: string,
): { to: string; cc: string; subject: string; body: string; inReplyTo: string | null } {
  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ----------',
      `From: ${m.from ? fullAddress(m.from) : ''}`,
      `Date: ${m.date ? new Date(m.date).toLocaleString() : ''}`,
      `Subject: ${m.subject}`,
      `To: ${addressList(m.to)}`,
      m.cc.length ? `Cc: ${addressList(m.cc)}` : null,
    ]
      .filter((l) => l !== null)
      .join('\n');
    return { to: '', cc: '', subject: prefixed('Fwd', m.subject), body: `\n\n${header}\n\n${m.bodyText ?? ''}`, inReplyTo: null };
  }
  const own = ownAddress.toLowerCase();
  // Replying to your own sent message goes to its original recipients.
  const fromSelf = m.from?.address.toLowerCase() === own;
  const replyTarget = m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  const primary = fromSelf ? m.to : replyTarget;
  const to = primary.map((a) => a.address);
  const cc =
    mode === 'replyAll'
      ? [...(fromSelf ? [] : m.to), ...m.cc].map((a) => a.address).filter((a) => a.toLowerCase() !== own && !to.includes(a))
      : [];
  return { to: to.join(', '), cc: [...new Set(cc)].join(', '), subject: prefixed('Re', m.subject), body: quote(m), inReplyTo: m.id };
}

/**
 * The document an HTML email is shown in: a sandboxed iframe (no scripts, no
 * same-origin), with a CSP that blocks remote content unless the user asks
 * for it — remote images are how senders track opens. Links open in a new tab.
 */
export function emailSrcDoc(html: string, allowRemote: boolean): string {
  const img = allowRemote ? 'img-src data: cid: https: http:;' : 'img-src data: cid:;';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${img} font-src data:;`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#111;word-wrap:break-word}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}

/** True when the HTML references remote images/backgrounds we'd block. */
export function hasRemoteContent(html: string): boolean {
  return /(src|background)\s*=\s*["']?\s*https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html);
}
