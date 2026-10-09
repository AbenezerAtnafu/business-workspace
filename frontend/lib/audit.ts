import type { AuditLogEntry } from '@/lib/api/types';
import { ACCESS_LEVEL_LABEL, formatQuota } from '@/lib/mail';

/**
 * The tenant audit-action taxonomy (backend AuditLogsService's AuditAction,
 * ADR-009), grouped the way the filter dropdown shows it. Platform-level
 * actions (organization.created, domain.verification_outcome) live in
 * control.audit_logs and never appear in GET /audit-logs.
 */
export const ACTION_GROUPS: { label: string; actions: [string, string][] }[] = [
  {
    label: 'Sign-in & passwords',
    actions: [
      ['user.login', 'Signed in'],
      ['user.logout', 'Signed out'],
      ['user.password_changed', 'Changed own password'],
      ['user.password_reset', 'Reset password (forgot password)'],
      ['user.password_reissued', 'Issued temporary password'],
    ],
  },
  {
    label: 'Users',
    actions: [
      ['user.created', 'Created user'],
      ['user.deleted', 'Deleted user'],
      ['user.role_changed', 'Changed role'],
      ['user.status_changed', 'Suspended / reactivated'],
      ['user.ownership_transferred', 'Transferred ownership'],
    ],
  },
  {
    label: 'Org units & groups',
    actions: [
      ['org_unit.created', 'Created org unit'],
      ['org_unit.updated', 'Updated org unit'],
      ['org_unit.deleted', 'Deleted org unit'],
      ['group.created', 'Created group'],
      ['group.updated', 'Updated group'],
      ['group.deleted', 'Deleted group'],
      ['group.member_added', 'Added group member'],
      ['group.member_removed', 'Removed group member'],
    ],
  },
  {
    label: 'Domains',
    actions: [
      ['domain.added', 'Added domain'],
      ['domain.verified', 'Domain verified'],
      ['domain.primary_set', 'Set primary domain'],
      ['domain.removed', 'Removed domain'],
    ],
  },
  {
    label: 'Organization',
    actions: [['organization.updated', 'Changed organization settings']],
  },
  {
    label: 'Mailboxes',
    actions: [
      ['mailbox.created', 'Created mailbox'],
      ['mailbox.updated', 'Changed mailbox quota/status'],
      ['mailbox.deleted', 'Deleted mailbox'],
      ['mailbox.alias_added', 'Added alias'],
      ['mailbox.alias_removed', 'Removed alias'],
      ['mailbox.access_granted', 'Granted access'],
      ['mailbox.access_updated', 'Changed access level'],
      ['mailbox.access_revoked', 'Revoked access'],
    ],
  },
];

export const ACTION_LABEL: Record<string, string> = Object.fromEntries(ACTION_GROUPS.flatMap((g) => g.actions));

export const RESOURCE_TYPES: [string, string][] = [
  ['user', 'User'],
  ['org_unit', 'Org unit'],
  ['group', 'Group'],
  ['domain', 'Domain'],
  ['mailbox', 'Mailbox'],
  ['organization', 'Organization'],
];
export const RESOURCE_LABEL: Record<string, string> = Object.fromEntries(RESOURCE_TYPES);

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** Page for a resource, if it has one. Deleted resources still link; their page shows "not found". */
export function resourceHref(e: Pick<AuditLogEntry, 'resourceType' | 'resourceId'>): string | undefined {
  if (!e.resourceId) return undefined;
  switch (e.resourceType) {
    case 'user':
      return `/admin/users/${e.resourceId}`;
    case 'domain':
      return `/admin/domains/${e.resourceId}`;
    case 'mailbox':
      return `/admin/mailboxes/${e.resourceId}`;
    case 'group':
      return `/admin/org-units-groups/groups/${e.resourceId}`;
    case 'org_unit':
      return '/admin/org-units-groups';
    case 'organization':
      return '/admin/settings';
    default:
      return undefined;
  }
}

/** Every user id an entry mentions, so the viewer can resolve names in one pass. */
export function userIdsIn(e: AuditLogEntry): string[] {
  const m = e.metadata ?? {};
  return [
    e.actorUserId,
    e.resourceType === 'user' ? e.resourceId : null,
    typeof m.userId === 'string' ? m.userId : null,
    typeof m.toUserId === 'string' ? m.toUserId : null,
    typeof m.fromUserId === 'string' ? m.fromUserId : null,
  ].filter((x): x is string => !!x);
}

const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * One-line, human description of what happened, built from the action and
 * its metadata (which never contains a password — enforced at write time).
 * `ctx.name(id)` resolves a user id to a display name; `ctx.domain(id)` a
 * domain id to its name.
 */
export interface DescribeContext {
  name: (userId: string | null | undefined) => string;
  domain: (domainId: string | null | undefined) => string | undefined;
  /** Current name of the entry's resource (group name, mailbox address…), if it still exists. */
  resource?: (type: string | null, id: string | null) => string | undefined;
}

export function describeEntry(e: AuditLogEntry, ctx: DescribeContext): string {
  const { name } = ctx;
  const m = e.metadata ?? {};
  const res = ctx.resource?.(e.resourceType, e.resourceId);
  const group = res ? `group “${res}”` : 'a group';
  const mailbox = res ?? 'a mailbox';
  const target = e.resourceType === 'user' ? name(e.resourceId) : undefined;
  switch (e.action) {
    case 'user.login':
      return 'Signed in';
    case 'user.logout':
      return 'Signed out';
    case 'user.password_changed':
      return 'Changed their own password';
    case 'user.password_reset':
      return 'Reset their password through “Forgot password”';
    case 'user.password_reissued':
      return `Issued a temporary password for ${target}`;
    case 'user.created':
      return `Created ${s(m.email) ?? target}${s(m.role) ? ` as ${m.role}` : ''}${s(m.invitedBy) ? ' (accepted invite)' : ''}`;
    case 'user.deleted':
      return `Deleted ${s(m.email) ?? target}`;
    case 'user.role_changed':
      return `Changed ${target}’s role from ${s(m.fromRole) ?? '?'} to ${s(m.toRole) ?? '?'}`;
    case 'user.status_changed':
      return m.toStatus === 'suspended'
        ? `Suspended ${target}`
        : m.toStatus === 'active'
          ? `Reactivated ${target}`
          : `Changed ${target}’s status to ${s(m.toStatus) ?? '?'}`;
    case 'user.ownership_transferred':
      return `Transferred ownership to ${name(s(m.toUserId) ?? e.resourceId)}`;
    case 'org_unit.created':
      return `Created org unit “${s(m.name) ?? '?'}”`;
    case 'org_unit.updated':
      return s(m.name) ? `Renamed or moved org unit to “${m.name}”` : 'Moved an org unit';
    case 'org_unit.deleted':
      return `Deleted org unit “${s(m.name) ?? '?'}”`;
    case 'group.created':
      return `Created group “${s(m.name) ?? '?'}”`;
    case 'group.updated':
      return s(m.name) ? `Updated group “${m.name}”` : 'Updated a group’s description';
    case 'group.deleted':
      return `Deleted group “${s(m.name) ?? '?'}”`;
    case 'group.member_added':
      return `Added ${name(s(m.userId))} to ${group}`;
    case 'group.member_removed':
      return `Removed ${name(s(m.userId))} from ${group}`;
    case 'domain.added':
      return `Added ${s(m.domainName) ?? 'a domain'}`;
    case 'domain.verified':
      return `${s(m.domainName) ?? 'A domain'} was verified`;
    case 'domain.primary_set':
      return m.isPrimary === false
        ? `Unset ${s(m.domainName) ?? 'a domain'} as primary`
        : `Made ${s(m.domainName) ?? 'a domain'} the primary domain`;
    case 'domain.removed':
      return `Removed ${s(m.domainName) ?? 'a domain'}`;
    case 'mailbox.created':
    {
      const domain = ctx.domain(s(m.domainId));
      const address = domain ? `${s(m.localPart) ?? '?'}@${domain}` : `“${s(m.localPart) ?? '?'}”`;
      return `Created mailbox ${address}${m.assignToSelf ? ' (their own sign-in mailbox)' : ''}`;
    }
    case 'mailbox.updated': {
      const parts = [
        typeof m.quotaBytes === 'number' ? `storage to ${formatQuota(m.quotaBytes)}` : null,
        m.status === 'suspended' ? 'suspended it' : m.status === 'active' ? 'reactivated it' : null,
      ].filter(Boolean);
      return parts.length ? `Changed ${mailbox}: ${parts.join(', ')}` : `Changed ${mailbox}`;
    }
    case 'mailbox.deleted':
      return res ? `Deleted mailbox ${res}` : 'Deleted a mailbox';
    case 'mailbox.alias_added':
      return `Added alias “${s(m.localPart) ?? '?'}” to ${mailbox}`;
    case 'mailbox.alias_removed':
      return `Removed alias “${s(m.localPart) ?? '?'}” from ${mailbox}`;
    case 'mailbox.access_granted': {
      const level = ACCESS_LEVEL_LABEL[m.accessLevel as keyof typeof ACCESS_LEVEL_LABEL] ?? s(m.accessLevel);
      return `Gave ${s(m.userId) ? name(s(m.userId)) : 'a group'} ${level ? `${level} ` : ''}access to ${mailbox}`;
    }
    case 'mailbox.access_updated': {
      const level = ACCESS_LEVEL_LABEL[m.accessLevel as keyof typeof ACCESS_LEVEL_LABEL] ?? s(m.accessLevel);
      return `Changed an access grant on ${mailbox} to ${level ?? '?'}`;
    }
    case 'mailbox.access_revoked':
      return `Revoked an access grant on ${mailbox}`;
    case 'organization.updated': {
      const changes = (m.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const FIELD: Record<string, string> = {
        name: 'name',
        logoUrl: 'logo',
        defaultTimezone: 'time zone',
        defaultLocale: 'language',
      };
      if (changes.name && Object.keys(changes).length === 1) {
        return `Renamed the organization from “${changes.name.from}” to “${changes.name.to}”`;
      }
      // Fixed order (JSONB doesn't keep the order fields were written in).
      const fields = [
        ...Object.keys(FIELD).filter((k) => k in changes).map((k) => FIELD[k]),
        ...Object.keys(changes).filter((k) => !(k in FIELD)),
      ];
      return fields.length ? `Changed organization settings: ${fields.join(', ')}` : 'Changed organization settings';
    }
    default:
      return actionLabel(e.action);
  }
}
