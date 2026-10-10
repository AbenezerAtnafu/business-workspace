// Response/request shapes for architecture/api-contract.md, matched against
// what the NestJS backend actually returns (not only what the contract says)
// — where they differ, the comment says so.

export type Role = 'owner' | 'admin' | 'member';

/** §1 `user` object returned alongside an accessToken (login, MFA, reset, invite accept, signup). */
export interface SessionUser {
  id: string;
  organizationId: string;
  orgUnitId: string;
  email: string;
  name: string;
  role: Role;
}

/** GET /me — SessionUser plus mfaEnabled. */
export interface Me extends SessionUser {
  mfaEnabled: boolean;
  /** Null until the account has claimed a company mailbox (in MVP: the Owner right after signup). */
  primaryMailboxId: string | null;
}

export interface SessionResponse {
  accessToken: string;
  user: SessionUser;
}

/** POST /auth/login branches three ways (§1 "Login flow, in full"). */
export type LoginResponse =
  | SessionResponse
  | { mfaChallengeToken: string }
  | { passwordChangeToken: string };

/** GET /me/sessions → { data: ActiveSession[] } (not cursor-paginated). */
export interface ActiveSession {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

/** POST /me/mfa/setup */
export interface MfaSetupResponse {
  secret: string;
  otpauthUrl: string;
}

/** GET /invites/{token} (public, token-scoped preview). */
export interface InvitePreview {
  localPart: string;
  domainName: string;
  organizationName: string;
  invitedByName: string;
  expiresAt: string;
}

export interface ListResponse<T> {
  data: T[];
}

// --- User Management (api-contract.md §3) --------------------------------

export type UserStatus = 'invited' | 'active' | 'suspended' | 'deleted';

/** GET /users, GET /users/{id}, PATCH /users/{id}. */
export interface User {
  id: string;
  organizationId: string;
  orgUnitId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  /** True until a temporary (Path B / reissued) password has been replaced. */
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** GET /invites (pending only). */
export interface PendingInvite {
  id: string;
  domainId: string;
  domainName: string;
  localPart: string;
  contactEmail: string;
  role: 'admin' | 'member';
  orgUnitId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  invitedByName: string;
  createdAt: string;
}

/** POST /users/invite */
export interface InviteResult {
  inviteId: string;
  expiresAt: string;
}

/** POST /users (Path B) — temporaryPassword is shown ONCE and never stored client-side. */
export interface CreateUserResult {
  userId: string;
  email: string;
  temporaryPassword: string;
  mustChangePassword: true;
}

/** POST /users/{id}/password/reissue */
export interface ReissueResult {
  temporaryPassword: string;
  mustChangePassword: true;
}

// --- Domains & Org Units (read-only use here) -----------------------------

export interface Domain {
  id: string;
  domainName: string;
  verificationStatus: 'pending' | 'verified' | 'failed';
  isPrimary: boolean;
  dkimSelector: string | null;
  dkimStatus: 'not_generated' | 'pending' | 'verified';
  verifiedAt: string | null;
  createdAt: string;
}

export interface OrgUnit {
  id: string;
  organizationId: string;
  parentOrgUnitId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// --- Groups (api-contract.md §5) ------------------------------------------

export interface Group {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
}

export type MailboxAccessLevel = 'read_only' | 'send_as' | 'manage';

export interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  members: { userId: string; name: string; email: string; addedAt: string }[];
  /** Mailboxes this group grants access to (reverse lookup of mailbox_access). */
  mailboxAccess: { grantId: string; mailboxId: string; email: string; accessLevel: MailboxAccessLevel }[];
}

/** 422 ORG_UNIT_NOT_EMPTY details. */
export interface OrgUnitNotEmptyDetails {
  memberUserIds: string[];
  childOrgUnitIds: string[];
  pendingInviteIds?: string[];
}

// --- Domains: DNS checklist (api-contract.md §6) --------------------------

export type DnsRecordPurpose = 'ownership' | 'inbound' | 'spf' | 'dkim' | 'dmarc' | 'autodiscovery';

export interface DnsRecordEntry {
  /** '@' for the domain itself, else e.g. '_dmarc'. */
  host: string;
  fqdn: string;
  value: string;
  priority?: number;
}

export interface DnsRecord {
  type: 'TXT' | 'MX' | 'SRV';
  purpose: DnsRecordPurpose;
  required: boolean;
  expected: string;
  status: 'matched' | 'missing' | 'pending-generation';
  entries: DnsRecordEntry[];
}

// --- Mailboxes (api-contract.md §7) ----------------------------------------

export interface Mailbox {
  id: string;
  domainId: string;
  domainName: string;
  localPart: string;
  email: string;
  /** Null for a shared mailbox. */
  userId: string | null;
  userName: string | null;
  quotaBytes: number;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
}

export interface MailboxAlias {
  id: string;
  localPart: string;
  email: string;
  createdAt: string;
}

export interface MailboxDetail extends Mailbox {
  aliases: MailboxAlias[];
}

export interface AccessGrant {
  id: string;
  mailboxId: string;
  userId: string | null;
  groupId: string | null;
  targetName: string;
  accessLevel: MailboxAccessLevel;
  grantedAt: string;
}

// --- Cursor pagination (api-contract.md §0) --------------------------------

/** `{ data, meta: { nextCursor, hasMore } }` — pass `nextCursor` back as `?cursor=`. */
export interface CursorPage<T> {
  data: T[];
  meta: { nextCursor: string | null; hasMore: boolean };
}

// --- Notifications (api-contract.md §10) -----------------------------------

export type NotificationType =
  | 'domain_verified'
  | 'user_joined'
  | 'password_reissued'
  | 'password_reset'
  | 'mfa_disabled'
  | 'password_changed';

export interface AppNotification {
  id: string;
  /** A NotificationType today; typed as string so a newer backend type still renders. */
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

// --- Audit logs (api-contract.md §11) --------------------------------------

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// --- Admin overview (api-contract.md §12) ----------------------------------

export interface AdminOverview {
  totalUsers: number;
  activeUsers: number;
  mailboxCount: number;
  domains: {
    id: string;
    domainName: string;
    verificationStatus: Domain['verificationStatus'];
    dkimStatus: Domain['dkimStatus'];
    isPrimary: boolean;
  }[];
  recentActivity: AuditLogEntry[];
}

// --- Organization (api-contract.md §2) --------------------------------------

/** GET/PATCH /organization — the caller's own org. */
export interface Organization {
  id: string;
  name: string;
  /** Stable identifier; not editable. */
  slug: string;
  logoUrl: string | null;
  /** IANA zone, e.g. "Africa/Addis_Ababa". */
  defaultTimezone: string;
  /** BCP 47 tag, e.g. "en" or "am-ET". */
  defaultLocale: string;
  status: 'active' | 'suspended' | 'deleted';
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

// --- Webmail (api-contract.md §8) -------------------------------------------

export type MailFolderId = 'inbox' | 'sent' | 'drafts' | 'trash';
export type MailAccessLevel = 'owner' | 'manage' | 'send_as' | 'read_only';

/** GET /mail/mailboxes — what the caller can open in webmail. */
export interface MailMailbox {
  mailboxId: string;
  address: string;
  isShared: boolean;
  access: MailAccessLevel;
  status: 'active' | 'suspended';
  /** Unread messages in Inbox; null when it couldn't be read (suspended, server down). */
  unread: number | null;
}

/** GET /mailboxes/{id}/folders */
export interface MailFolders {
  data: { folder: MailFolderId; total: number; unread: number }[];
  quota: { usedBytes: number; limitBytes: number | null } | null;
  access: MailAccessLevel;
}

export interface MailAddress {
  name: string | null;
  address: string;
}

export interface MailMessageSummary {
  /** Opaque; changes when the message moves folder or a draft is saved again. */
  id: string;
  folder: MailFolderId;
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  date: string | null;
  read: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  sizeBytes: number;
}

export interface MailAttachmentMeta {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  inline: boolean;
}

export interface MailMessageDetail extends MailMessageSummary {
  bcc: MailAddress[];
  replyTo: MailAddress[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  bodyText: string | null;
  /** Untrusted HTML from the sender: only ever render it in a sandboxed iframe. */
  bodyHtml: string | null;
  attachments: MailAttachmentMeta[];
}

/** POST /mailboxes/{id}/attachments */
export interface StagedAttachment {
  attachmentId: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string | null;
}

export const MAIL_WRITE_ACCESS: MailAccessLevel[] = ['owner', 'manage', 'send_as'];
