import { AppException } from '../../common/errors/app-exception';

/** The fixed MVP folder set (api-contract.md §8) → Dovecot mailbox names (dovecot.conf). */
export const FOLDERS = {
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
} as const;
export type FolderId = keyof typeof FOLDERS;

export function folderPath(folder: string): string {
  if (!(folder in FOLDERS)) throw new AppException(404, 'NOT_FOUND', 'Unknown folder.');
  return FOLDERS[folder as FolderId];
}

/**
 * A message's API id: folder + UIDVALIDITY + UID, base64url. IMAP UIDs are
 * only unique per folder and only while UIDVALIDITY holds, so all three are
 * needed; a stale id (folder recreated) resolves to 404, never to a different
 * message.
 */
export function encodeMessageId(folder: FolderId, uidValidity: bigint | number | string, uid: number): string {
  return Buffer.from(`${folder}:${uidValidity}:${uid}`).toString('base64url');
}

export function decodeMessageId(id: string): { folder: FolderId; uidValidity: string; uid: number } {
  const raw = Buffer.from(id, 'base64url').toString('utf8');
  const m = /^(inbox|sent|drafts|trash):(\d+):(\d+)$/.exec(raw);
  if (!m) throw new AppException(404, 'NOT_FOUND', 'Message not found.');
  return { folder: m[1] as FolderId, uidValidity: m[2], uid: Number(m[3]) };
}
