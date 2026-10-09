import type { MailboxAccessLevel } from '@/lib/api/types';

export const ACCESS_LEVEL_LABEL: Record<MailboxAccessLevel, string> = {
  read_only: 'Read only',
  send_as: 'Send as',
  manage: 'Manage',
};

export const ACCESS_LEVEL_HINT: Record<MailboxAccessLevel, string> = {
  read_only: 'Can read mail in this mailbox, but not send from it.',
  send_as: 'Can read mail and send as this address.',
  manage: 'Can read, send, and see who else has access.',
};

const GIB = 1024 ** 3;

/** 5368709120 → "5 GB". Quotas are set in whole or half GB in the UI. */
export function formatQuota(bytes: number): string {
  const gb = bytes / GIB;
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * GIB);
}

export function bytesToGb(bytes: number): number {
  return Math.round((bytes / GIB) * 10) / 10;
}
