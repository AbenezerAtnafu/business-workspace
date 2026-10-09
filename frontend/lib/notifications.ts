import type { AppNotification } from '@/lib/api/types';

export interface NotificationView {
  title: string;
  body?: string;
  /** Where clicking it goes; undefined = nothing to open. */
  href?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Human text for each system notification (api-contract.md §10). Payloads
 * never carry secrets (NotificationsService), so everything here is safe to
 * render. Unknown types fall back to a readable version of the type so a
 * newer backend never shows a blank row.
 */
export function describeNotification(n: AppNotification): NotificationView {
  const p = n.payload ?? {};
  switch (n.type) {
    case 'domain_verified':
      return {
        title: `${str(p.domainName) ?? 'A domain'} is verified`,
        body: 'You can now create addresses on it. Publish the DKIM record next.',
        href: str(p.domainId) ? `/admin/domains/${p.domainId}` : '/admin/domains',
      };
    case 'user_joined':
      return {
        title: `${str(p.name) ?? 'Someone'} joined`,
        body: [str(p.email), str(p.role) && `as ${p.role === 'admin' ? 'an Admin' : 'a Member'}`]
          .filter(Boolean)
          .join(' '),
        href: str(p.userId) ? `/admin/users/${p.userId}` : '/admin/users',
      };
    case 'password_reissued':
      return {
        title: 'An admin issued you a new temporary password',
        body: 'Your other sessions were signed out. If you didn’t expect this, contact your admin.',
        href: '/account/sessions',
      };
    case 'password_reset':
      return {
        title: 'Your password was reset',
        body: 'Done through “Forgot password”. If this wasn’t you, change your password now.',
        href: '/account/password',
      };
    case 'password_changed':
      return {
        title: 'Your password was changed',
        body: 'Your other sessions were signed out. If this wasn’t you, contact your admin.',
        href: '/account/sessions',
      };
    case 'mfa_disabled':
      return {
        title: 'Two-step verification was turned off',
        body: 'If this wasn’t you, turn it back on and change your password.',
        href: '/account/mfa',
      };
    default: {
      const t = n.type.replace(/[_.]/g, ' ');
      return { title: t.charAt(0).toUpperCase() + t.slice(1) };
    }
  }
}
