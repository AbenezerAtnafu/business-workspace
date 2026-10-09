/**
 * The local part of a company address ("john" in john@acme.com), shared by
 * every DTO that takes one (invites, direct user creation, mailboxes,
 * aliases) so they can't drift apart.
 *
 * Lowercase only, deliberately: tenant.mailboxes.local_part is plain TEXT,
 * not CITEXT, so "John" and "john" would otherwise be two different slots
 * that real mail delivery treats as the same address. Letters, digits and
 * . _ - ; must start and end with a letter or digit; max 64 chars (RFC 5321).
 * Clients should lowercase before sending.
 */
export const LOCAL_PART_REGEX = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const LOCAL_PART_MESSAGE =
  'localPart must be 1-64 lowercase letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit';
