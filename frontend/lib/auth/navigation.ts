import type { Role } from '@/lib/api/types';

/**
 * Where a freshly signed-in user lands. An Owner who hasn't claimed a
 * company mailbox yet goes to the Setup Checklist (Flow 1 → Flow 2);
 * otherwise Owner/Admin go to the Admin Console overview and Members to
 * their account (Mail is their natural home, but it's blocked on Step
 * 2.1/2.4 — swap this to '/mail' once it exists).
 */
export function homePathFor(user: { role: Role; primaryMailboxId?: string | null }): string {
  if (user.role === 'member') return '/account/profile';
  if (user.role === 'owner' && user.primaryMailboxId === null) return '/setup-checklist';
  return '/admin/overview';
}

/**
 * Only allow same-app relative paths as a post-login `next` target — never
 * `//evil.com` or `https://…` (open-redirect guard).
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}

/** Login-page reasons we can explain to the user (?reason=…). */
export const LOGIN_REASONS: Record<string, string> = {
  'session-expired': 'Your session has ended. Please log in again.',
  'mfa-expired': 'Your verification step expired. Please log in again.',
  'password-change-expired': 'Your password-change link expired. Please log in again.',
  'logged-out': 'You’ve been logged out.',
};
