import type { User } from '@/lib/api/types';

export type UserStatusTone = 'success' | 'warning' | 'secondary' | 'destructive';

/** One human label per account state, used by the list and detail screens alike. */
export function userStatusBadge(user: Pick<User, 'status' | 'mustChangePassword' | 'lastLoginAt'>): {
  label: string;
  tone: UserStatusTone;
  hint?: string;
} {
  if (user.status === 'deleted') return { label: 'Deleted', tone: 'destructive' };
  if (user.status === 'suspended') return { label: 'Suspended', tone: 'warning', hint: 'Can’t sign in' };
  if (user.mustChangePassword) {
    return { label: 'Temporary password', tone: 'secondary', hint: 'Must set their own password at next sign-in' };
  }
  return { label: 'Active', tone: 'success' };
}

/** Expiring within 24h gets flagged (screen-flow-inventory.md §2.3, Pending Invites). */
export function inviteExpiry(expiresAt: string, now = Date.now()): 'expired' | 'soon' | 'ok' {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return 'expired';
  if (ms < 24 * 60 * 60 * 1000) return 'soon';
  return 'ok';
}

export function relativeTime(value: string, now = Date.now()): string {
  const diff = new Date(value).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'minute');
}

/** Same rule as the backend's LOCAL_PART_REGEX (common/validation/local-part.ts). */
export const LOCAL_PART_REGEX = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const LOCAL_PART_HINT = 'Lowercase letters, digits, dots, hyphens or underscores.';
