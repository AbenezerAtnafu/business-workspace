// Central place for environment-derived config — see .env.example for the
// full list, grouped by which implementation-plan phase first needs it.
export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    // Superuser (`postgres`) — scripts/run-migrate.js ONLY. Never used for
    // the app's own runtime connection pool (see `appUrl` below and
    // migrations/006_app_runtime_role.sql for why that distinction matters:
    // superusers bypass every RLS policy unconditionally).
    url: process.env.DATABASE_URL,
    // The app's actual runtime connection — a dedicated non-superuser,
    // non-BYPASSRLS role so RLS (migrations/004) is actually enforced, not
    // just assumed. Required; DatabaseService refuses to silently fall
    // back to `url` above.
    appUrl: process.env.APP_DATABASE_URL,
    // A third, narrowly-scoped, read-only, BYPASSRLS role (migrations/008)
    // — used ONLY for lookups that must run before the organization is
    // known (refresh-token lookup, MFA challenge lookup, invite-token
    // preview). Never use this for anything else. Required, same fail-fast
    // reasoning as appUrl.
    bootstrapUrl: process.env.APP_BOOTSTRAP_DATABASE_URL,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
  },
  cookie: {
    domain: process.env.COOKIE_DOMAIN ?? 'localhost',
    secure: process.env.COOKIE_SECURE === 'true',
  },
  // Envelope-encryption key for columns marked "encrypted at rest" in
  // architecture/data-model.md (tenant.users.mfa_secret from Step 1.4;
  // control.domains.dkim_private_key from Step 2.2).
  encryptionKey: process.env.ENCRYPTION_KEY,
  smtpRelay: {
    host: process.env.SMTP_RELAY_HOST,
    port: parseInt(process.env.SMTP_RELAY_PORT ?? '587', 10),
    user: process.env.SMTP_RELAY_USER,
    password: process.env.SMTP_RELAY_PASSWORD,
    from: process.env.SMTP_RELAY_FROM ?? 'Business Workspace Platform <no-reply@example.com>',
  },
  // Used only to build links that get emailed out (password reset) — the
  // frontend's own public origin, not this API's.
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3001',
  // Step 2.2 (Custom Domains) — the platform's own mail infrastructure
  // hostnames, used as the "expected" values GET /domains/{id}/dns-records
  // tells customers to publish, and as what DomainsService's live DNS
  // checks compare against. Real values depend on Step 2.1's mail-stack
  // stand-up (not done yet); the defaults below intentionally match
  // architecture/api-contract.md §6 and planning/business-rules-and-
  // defaults.md's own placeholder examples verbatim ("mx.platform.example",
  // "include:amazonses.com include:platform.example"), so there is exactly
  // one place to update once that infrastructure is real.
  platformMail: {
    mxHost: process.env.PLATFORM_MX_HOST ?? 'mx.platform.example',
    // business-rules-and-defaults.md: SPF "must authorize both the relay
    // ... and the platform's own sending infrastructure from the start."
    spfInclude: process.env.PLATFORM_SPF_INCLUDE ?? 'include:amazonses.com include:platform.example',
    // architecture/domain-and-email-flow.md "Autodiscovery": SRV records
    // all target this one shared hostname, never a per-customer one.
    autodiscoveryHost: process.env.PLATFORM_AUTODISCOVERY_HOST ?? 'platform.example',
    // Per-lookup timeout for the live DNS checks GET /dns-records and
    // POST /verify perform. Found necessary the hard way: an unwrapped
    // dns.promises call against an unreachable or slow-to-answer resolver
    // can hang for upwards of two minutes (observed directly while
    // building this), which is not an acceptable response time for a
    // synchronous, user-facing endpoint — or an acceptable way to let one
    // slow-to-resolve customer domain tie up a connection.
    dnsLookupTimeoutMs: parseInt(process.env.DNS_LOOKUP_TIMEOUT_MS ?? '5000', 10),
  },
  // Webmail (Step 2.4, ADR-012): the API reads mailboxes over IMAP as the
  // Dovecot master user and sends through Postfix's internal port. Both are
  // reachable only on the internal network, so no TLS between them.
  mail: {
    imapHost: process.env.MAIL_IMAP_HOST ?? '127.0.0.1',
    imapPort: parseInt(process.env.MAIL_IMAP_PORT ?? '143', 10),
    submitHost: process.env.MAIL_SUBMIT_HOST ?? '127.0.0.1',
    submitPort: parseInt(process.env.MAIL_SUBMIT_PORT ?? '10025', 10),
    masterUser: process.env.DOVECOT_MASTER_USER ?? 'apimaster',
    masterPassword: process.env.DOVECOT_MASTER_PASSWORD ?? 'apimaster_dev_password',
    attachmentDir: process.env.ATTACHMENT_STORAGE_DIR ?? './var/attachments',
    maxAttachmentBytes: 100 * 1024 * 1024, // business-rules-and-defaults.md
    maxRecipients: 100,
  },
  // Volume quotas for abuse-prone, non-credential endpoints (ADR-011),
  // all per rolling-start fixed one-hour window. Defaults are the
  // production values; raise SIGNUPS_PER_IP locally if you sign up a lot of
  // test organizations from one machine (every signup from localhost shares
  // one IP).
  rateLimit: {
    signupsPerIpPerHour: intEnv('RATE_LIMIT_SIGNUPS_PER_IP_PER_HOUR', 10),
    invitesPerOrgPerHour: intEnv('RATE_LIMIT_INVITES_PER_ORG_PER_HOUR', 50),
    reissuesPerUserPerHour: intEnv('RATE_LIMIT_REISSUES_PER_USER_PER_HOUR', 5),
    reissuesPerOrgPerHour: intEnv('RATE_LIMIT_REISSUES_PER_ORG_PER_HOUR', 30),
    resetRequestsPerEmailPerHour: intEnv('RATE_LIMIT_RESET_REQUESTS_PER_EMAIL_PER_HOUR', 3),
    resetRequestsPerIpPerHour: intEnv('RATE_LIMIT_RESET_REQUESTS_PER_IP_PER_HOUR', 20),
    sendsPerMailboxPerHour: intEnv('RATE_LIMIT_SENDS_PER_MAILBOX_PER_HOUR', 200),
  },
});

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return n;
}
