import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AtSign,
  Building2,
  ClipboardCheck,
  Globe,
  Inbox,
  KeyRound,
  LayoutDashboard,
  MonitorSmartphone,
  Network,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react';
import type { Role } from '@/lib/api/types';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Roles that see this item. Omit = everyone. Server re-enforces regardless (api-contract.md §4). */
  roles?: Role[];
  /** Shown but marked unavailable (blocked on backend/infra, not just unbuilt UI). */
  unavailable?: string;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

const ADMINS: Role[] = ['owner', 'admin'];

/**
 * Mirrors planning/screen-flow-inventory.md §1's site map. Members keep
 * read-only access to Users (directory), Org Units & Groups and Domains per
 * the permission matrix, so those three stay visible to them under a
 * "Directory" heading instead of "Admin Console".
 */
export function navFor(role: Role): NavSection[] {
  const isAdmin = ADMINS.includes(role);
  const sections: NavSection[] = [
    {
      items: [
        { label: 'Setup checklist', href: '/setup-checklist', icon: ClipboardCheck, roles: ADMINS },
        {
          label: 'Mail',
          href: '/mail',
          icon: Inbox,
          unavailable: 'Webmail needs the mail servers (Step 2.1) and Step 2.4, both not built yet.',
        },
      ],
    },
    {
      title: isAdmin ? 'Admin Console' : 'Directory',
      items: [
        { label: 'Overview', href: '/admin/overview', icon: LayoutDashboard, roles: ADMINS },
        { label: isAdmin ? 'Users' : 'People', href: '/admin/users', icon: Users },
        { label: 'Org units & groups', href: '/admin/org-units-groups', icon: Network },
        { label: 'Domains', href: '/admin/domains', icon: Globe },
        { label: 'Mailboxes', href: '/admin/mailboxes', icon: AtSign, roles: ADMINS },
        { label: 'Audit logs', href: '/admin/audit-logs', icon: Activity, roles: ADMINS },
        // Members can read the org profile (permission matrix: Settings read).
        { label: isAdmin ? 'Organization settings' : 'Organization', href: '/admin/settings', icon: Building2 },
      ],
    },
    {
      title: 'My account',
      items: [
        { label: 'Profile', href: '/account/profile', icon: User },
        { label: 'Password', href: '/account/password', icon: KeyRound },
        { label: 'Two-step verification', href: '/account/mfa', icon: ShieldCheck },
        { label: 'Sessions', href: '/account/sessions', icon: MonitorSmartphone },
      ],
    },
  ];

  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.roles || i.roles.includes(role)) }))
    .filter((s) => s.items.length > 0);
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
