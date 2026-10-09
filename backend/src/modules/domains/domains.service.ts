import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { promises as dns } from 'dns';
import type { MxRecord, SrvRecord } from 'dns';
import { generateKeyPair, randomBytes } from 'crypto';
import { promisify } from 'util';
import { DatabaseService } from '../../database/database.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { AppException } from '../../common/errors/app-exception';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import { SetPrimaryDomainDto } from './dto/set-primary-domain.dto';

const generateKeyPairAsync = promisify(generateKeyPair);

// planning/business-rules-and-defaults.md: "Up to 5 verified domains per
// organization in MVP (soft limit via application check, adjustable)."
// Enforced at creation time (counting ALL domains, any status) rather than
// only at the moment a 6th domain tries to transition into 'verified' —
// the literal rule counts verified domains, but rejecting late, only after
// the customer has already done the DNS legwork on a domain they were
// allowed to add, would be a worse experience than telling them up front.
const DOMAIN_LIMIT = 5;

interface DomainRow {
  id: string;
  organization_id: string;
  domain_name: string;
  verification_token: string;
  verification_status: 'pending' | 'verified' | 'failed';
  dkim_selector: string | null;
  dkim_private_key: string | null;
  dkim_public_key: string | null;
  dkim_verified_at: Date | null;
  is_primary: boolean;
  verified_at: Date | null;
  created_at: Date;
}

const DOMAIN_ROW_COLUMNS = `id, organization_id, domain_name, verification_token, verification_status,
       dkim_selector, dkim_private_key, dkim_public_key, dkim_verified_at,
       is_primary, verified_at, created_at`;

export interface VerifiedDomain {
  id: string;
  domainName: string;
}

export interface DomainDto {
  id: string;
  domainName: string;
  verificationStatus: 'pending' | 'verified' | 'failed';
  isPrimary: boolean;
  dkimSelector: string | null;
  dkimStatus: 'not_generated' | 'pending' | 'verified';
  verifiedAt: Date | null;
  createdAt: Date;
}

/**
 * One concrete record to publish at the DNS provider. Added 2026-10-07 for
 * the DNS Instructions screen: `expected` alone is a description, not
 * something a customer can paste — it doesn't say which host name the record
 * goes on, and the SRV row stands for three separate records.
 */
export interface DnsRecordEntryDto {
  /** Host relative to the domain: '@' for the domain itself, else e.g. '_dmarc'. */
  host: string;
  /** Fully qualified name, for providers that want the whole name. */
  fqdn: string;
  /** The record content to enter (TXT text, MX target, or SRV "priority weight port target"). */
  value: string;
  /** MX/SRV priority. */
  priority?: number;
}

export interface DnsRecordDto {
  type: 'TXT' | 'MX' | 'SRV';
  purpose: 'ownership' | 'inbound' | 'spf' | 'dkim' | 'dmarc' | 'autodiscovery';
  required: boolean;
  expected: string;
  status: 'matched' | 'missing' | 'pending-generation';
  /** Exactly what to publish. Empty only for DKIM before its key is generated. */
  entries: DnsRecordEntryDto[];
}

/**
 * Custom Domains — claude/srs.md §7.5, architecture/api-contract.md §6,
 * architecture/domain-and-email-flow.md's "Domain lifecycle".
 *
 * `control.domains` has no RLS (it's control-plane — architecture/
 * data-model.md), so `organization_id` is checked explicitly in every
 * WHERE clause rather than relying on tenant-context scoping — the same
 * reasoning the old MailboxesService.findVerifiedDomainOrThrow documented,
 * whose job this service now owns (see `findVerifiedDomainOrThrow` below).
 * This is also what makes the cross-org case collapse to the same 404 as
 * "doesn't exist" (api-contract.md §0), rather than ever confirming a
 * domain exists in someone else's org. Every method still opens a
 * transaction and calls setTenantContext — not because control.domains
 * needs it, but because remove() also touches tenant.mailboxes and
 * tenant.invites, which do, and because every other service in this
 * codebase does so uniformly rather than special-casing control-only reads.
 *
 * Live DNS checks (getDnsRecords, verify) are timeout-wrapped
 * (platformMail.dnsLookupTimeoutMs, default 5s) and run in parallel —
 * found necessary the hard way while building this: an unwrapped
 * dns.promises call against an unreachable or slow-to-answer resolver can
 * hang for upwards of two minutes (observed directly in this sandbox),
 * which is not an acceptable response time for a synchronous, user-facing
 * endpoint, nor an acceptable way to let one slow-to-resolve customer
 * domain tie up a connection. Every DNS failure mode (NXDOMAIN, timeout,
 * no records) is treated identically as "not matched" — never thrown —
 * so a customer's broken DNS is reported as an unmet checklist item, not
 * a 500.
 */
@Injectable()
export class DomainsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly configService: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly notifications: NotificationsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** GET /domains — list, no pagination (same reasoning as org units/groups: small, per-org lists). */
  async list(organizationId: string): Promise<DomainDto[]> {
    const rows = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const { rows } = await client.query<DomainRow>(
        `SELECT ${DOMAIN_ROW_COLUMNS} FROM control.domains WHERE organization_id = $1 ORDER BY created_at`,
        [organizationId],
      );
      return rows;
    });
    return rows.map((row) => this.toDto(row));
  }

  /** GET /domains/{domainId} — "Domain detail incl. DKIM status" (api-contract.md §6). */
  async getById(organizationId: string, domainId: string): Promise<DomainDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      return this.findByIdOrThrow(client, organizationId, domainId);
    });
    return this.toDto(row);
  }

  /**
   * POST /domains. Rejects a domain already claimed by any organization on
   * the platform (`control.domains.domain_name` is globally UNIQUE — see
   * domain-and-email-flow.md: "cross-organization mailbox collisions are
   * structurally impossible" depends on this) with `409
   * DOMAIN_ALREADY_CLAIMED` rather than letting the raw unique-violation
   * surface as a 500. `domain_name` is plain TEXT, not CITEXT (unlike
   * `control.user_directory.email`), so case-insensitive uniqueness is
   * enforced here by lowercasing before every insert/lookup.
   */
  async create(organizationId: string, actorUserId: string, dto: CreateDomainDto): Promise<DomainDto> {
    const domainName = dto.domainName.toLowerCase();
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);

      const { rows: countRows } = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM control.domains WHERE organization_id = $1',
        [organizationId],
      );
      if (countRows[0].count >= DOMAIN_LIMIT) {
        throw new AppException(
          422,
          'DOMAIN_LIMIT_REACHED',
          `This organization already has the maximum of ${DOMAIN_LIMIT} domains.`,
        );
      }

      const verificationToken = randomBytes(24).toString('base64url');
      let row: DomainRow;
      try {
        const { rows } = await client.query<DomainRow>(
          `INSERT INTO control.domains (organization_id, domain_name, verification_token)
           VALUES ($1, $2, $3)
           RETURNING ${DOMAIN_ROW_COLUMNS}`,
          [organizationId, domainName, verificationToken],
        );
        row = rows[0];
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new AppException(
            409,
            'DOMAIN_ALREADY_CLAIMED',
            'This domain is already claimed by an organization on this platform.',
          );
        }
        throw err;
      }

      // Step 3.2: claude/srs.md §7.10 MVP event "Domain changes."
      await this.auditLogs.record(client, organizationId, actorUserId, 'domain.added', {
        resourceType: 'domain',
        resourceId: row.id,
        metadata: { domainName: row.domain_name },
      });

      return row;
    });
    return this.toDto(row);
  }

  /**
   * GET /domains/{domainId}/dns-records — "the full record checklist + live
   * status per record" (api-contract.md §6). Read-only: unlike `verify()`,
   * this never writes verification_status/dkim_verified_at — it's purely a
   * live snapshot for the domain-setup wizard screen, matching the record
   * set in domain-and-email-flow.md step 4.
   */
  async getDnsRecords(organizationId: string, domainId: string): Promise<DnsRecordDto[]> {
    const domain = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      return this.findByIdOrThrow(client, organizationId, domainId);
    });

    const timeoutMs = this.configService.get<number>('platformMail.dnsLookupTimeoutMs')!;
    const mxHost = this.configService.get<string>('platformMail.mxHost')!;
    const spfInclude = this.configService.get<string>('platformMail.spfInclude')!;
    const autodiscoveryHost = this.configService.get<string>('platformMail.autodiscoveryHost')!;

    const [ownershipMatched, mxMatched, spfMatched, dmarcMatched, autodiscoveryMatched, dkimMatched] =
      await Promise.all([
        this.checkOwnershipTxt(domain.domain_name, domain.verification_token, timeoutMs),
        this.checkMx(domain.domain_name, mxHost, timeoutMs),
        this.checkSpf(domain.domain_name, spfInclude, timeoutMs),
        this.checkDmarc(domain.domain_name, timeoutMs),
        this.checkAutodiscovery(domain.domain_name, autodiscoveryHost, timeoutMs),
        domain.dkim_public_key && domain.dkim_selector
          ? this.checkDkim(domain.domain_name, domain.dkim_selector, domain.dkim_public_key, timeoutMs)
          : Promise.resolve(false),
      ]);

    const entry = (host: string, value: string): DnsRecordEntryDto => ({
      host,
      fqdn: host === '@' ? domain.domain_name : `${host}.${domain.domain_name}`,
      value,
    });

    return [
      {
        type: 'TXT',
        purpose: 'ownership',
        required: true,
        expected: `workspace-verification=${domain.verification_token}`,
        status: ownershipMatched ? 'matched' : 'missing',
        entries: [entry('@', `workspace-verification=${domain.verification_token}`)],
      },
      {
        type: 'MX',
        purpose: 'inbound',
        required: true,
        expected: mxHost,
        status: mxMatched ? 'matched' : 'missing',
        entries: [{ ...entry('@', mxHost), priority: 10 }],
      },
      {
        type: 'TXT',
        purpose: 'spf',
        required: true,
        expected: `v=spf1 ${spfInclude} ~all`,
        status: spfMatched ? 'matched' : 'missing',
        entries: [entry('@', `v=spf1 ${spfInclude} ~all`)],
      },
      {
        type: 'TXT',
        purpose: 'dkim',
        required: true,
        expected: domain.dkim_public_key
          ? `${domain.dkim_selector}._domainkey: v=DKIM1; k=rsa; p=${domain.dkim_public_key}`
          : '<selector>._domainkey ... (generated automatically once ownership is verified)',
        status: !domain.dkim_public_key ? 'pending-generation' : dkimMatched ? 'matched' : 'missing',
        entries:
          domain.dkim_public_key && domain.dkim_selector
            ? [entry(`${domain.dkim_selector}._domainkey`, `v=DKIM1; k=rsa; p=${domain.dkim_public_key}`)]
            : [],
      },
      {
        type: 'TXT',
        purpose: 'dmarc',
        required: false,
        expected: 'v=DMARC1; p=none',
        status: dmarcMatched ? 'matched' : 'missing',
        entries: [entry('_dmarc', 'v=DMARC1; p=none')],
      },
      {
        type: 'SRV',
        purpose: 'autodiscovery',
        required: false,
        expected: `_imaps._tcp, _submission._tcp, _autodiscover._tcp → ${autodiscoveryHost}`,
        status: autodiscoveryMatched ? 'matched' : 'missing',
        // IMAPS 993 and submission 587 match AutodiscoveryService's fixed
        // ports; Autodiscover is served over HTTPS (443).
        entries: [
          { ...entry('_imaps._tcp', `0 1 993 ${autodiscoveryHost}`), priority: 0 },
          { ...entry('_submission._tcp', `0 1 587 ${autodiscoveryHost}`), priority: 0 },
          { ...entry('_autodiscover._tcp', `0 1 443 ${autodiscoveryHost}`), priority: 0 },
        ],
      },
    ];
  }

  /**
   * POST /domains/{domainId}/verify — "manual-trigger ownership check"
   * (business-rules-and-defaults.md), the only way verification_status
   * advances in MVP (no background re-checking). On a transition into
   * 'verified', DKIM key generation "fires automatically server-side ...
   * the moment ownership verifies" (domain-and-email-flow.md step 3) —
   * exactly once; a key pair is never regenerated by a later call.
   *
   * `verification_status` is sticky once 'verified': a later call whose
   * live TXT lookup no longer matches (DNS record removed, transient
   * resolver hiccup) does NOT regress it back to 'failed'. Postfix gates
   * inbound mail acceptance directly on verification_status = 'verified'
   * (domain-and-email-flow.md's inbound path), so silently flipping a
   * live, mail-accepting domain back out of that state from an on-demand
   * re-check would be actively harmful, and nothing in the docs asks for
   * that regression path. `dkim_verified_at`, by contrast, is kept fully
   * live on every call (set or cleared) — DKIM absence never gates mail
   * acceptance (a domain "can be verified ... before DKIM propagates"),
   * so there's no equivalent downside to reporting it accurately.
   */
  async verify(organizationId: string, actorUserId: string, domainId: string): Promise<DomainDto> {
    const timeoutMs = this.configService.get<number>('platformMail.dnsLookupTimeoutMs')!;

    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const domain = await this.findByIdOrThrow(client, organizationId, domainId);

      const ownershipMatched = await this.checkOwnershipTxt(
        domain.domain_name,
        domain.verification_token,
        timeoutMs,
      );

      let verificationStatus = domain.verification_status;
      let verifiedAt = domain.verified_at;
      let dkimSelector = domain.dkim_selector;
      let dkimPrivateKeyEncrypted = domain.dkim_private_key;
      let dkimPublicKey = domain.dkim_public_key;

      // Captured before verificationStatus is mutated below — Step 3.1's
      // notification should fire exactly once, on the actual transition
      // into 'verified', never on a later re-verify of an already-verified
      // domain (ADR-006: verification_status is sticky, so there's no
      // "re-verified" event to notify about either).
      const justVerified = ownershipMatched && domain.verification_status !== 'verified';

      if (ownershipMatched) {
        if (verificationStatus !== 'verified') {
          verificationStatus = 'verified';
          verifiedAt = new Date();
        }
        if (!dkimPublicKey) {
          const keyPair = await this.generateDkimKeyPair();
          dkimSelector = keyPair.selector;
          dkimPublicKey = keyPair.publicKeyBase64;
          dkimPrivateKeyEncrypted = this.encryption.encrypt(keyPair.privateKeyPem);
        }
      } else if (verificationStatus !== 'verified') {
        verificationStatus = 'failed';
      }

      let dkimVerifiedAt: Date | null = domain.dkim_verified_at;
      if (dkimPublicKey && dkimSelector) {
        const dkimMatched = await this.checkDkim(domain.domain_name, dkimSelector, dkimPublicKey, timeoutMs);
        dkimVerifiedAt = dkimMatched ? new Date() : null;
      }

      const { rows } = await client.query<DomainRow>(
        `UPDATE control.domains
         SET verification_status = $1, verified_at = $2, dkim_selector = $3,
             dkim_private_key = $4, dkim_public_key = $5, dkim_verified_at = $6
         WHERE id = $7
         RETURNING ${DOMAIN_ROW_COLUMNS}`,
        [verificationStatus, verifiedAt, dkimSelector, dkimPrivateKeyEncrypted, dkimPublicKey, dkimVerifiedAt, domainId],
      );

      if (justVerified) {
        await this.notifications.notifyAdmins(client, organizationId, 'domain_verified', {
          domainId,
          domainName: domain.domain_name,
        });

        // Step 3.2: tenant-plane "Domain changes" event — only on the real
        // transition into 'verified', same justVerified guard the Step 3.1
        // notification uses and for the same reason (verification_status is
        // sticky per this method's own doc comment, so a later re-verify of
        // an already-verified domain isn't a new event).
        await this.auditLogs.record(client, organizationId, actorUserId, 'domain.verified', {
          resourceType: 'domain',
          resourceId: domainId,
          metadata: { domainName: domain.domain_name },
        });
      }

      // Step 3.2: claude/srs.md §7.10 — "Platform-level events (e.g.,
      // organization creation, domain verification outcomes) are indexed in
      // the control-plane database." Unlike the tenant-plane write above,
      // this one is unconditional: every verify() call (success or failure,
      // transition or not) is itself a "domain verification outcome," not
      // only the moments it flips sticky status. actor_type is 'system',
      // not 'platform_admin' — this build has no platform-admin-accounts
      // module (see AuditLogsService.recordPlatform's own doc comment), so
      // there's no other value this could legitimately be yet.
      await this.auditLogs.recordPlatform(client, 'system', 'domain.verification_outcome', organizationId, {
        domainId,
        domainName: domain.domain_name,
        outcome: verificationStatus,
      });

      return rows[0];
    });
    return this.toDto(row);
  }

  /**
   * PATCH /domains/{domainId} { isPrimary }. Setting `true` requires the
   * domain already be verified (it becomes the "from" address for
   * system-sent email like invites — business-rules-and-defaults.md's
   * invite-delivery exception — so an unverified domain would send invite
   * mail that can't be authenticated). The partial unique index
   * `domains_one_primary_per_org` means at most one row can have
   * `is_primary = true` at a time, so the previous primary (if any) is
   * cleared first as a plain two-statement UPDATE rather than an upsert.
   */
  async setPrimary(organizationId: string, actorUserId: string, domainId: string, dto: SetPrimaryDomainDto): Promise<DomainDto> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const domain = await this.findByIdOrThrow(client, organizationId, domainId);

      if (dto.isPrimary) {
        if (domain.verification_status !== 'verified') {
          throw new AppException(
            422,
            'DOMAIN_NOT_VERIFIED',
            'Only a verified domain can be set as primary.',
          );
        }
        await client.query(
          'UPDATE control.domains SET is_primary = false WHERE organization_id = $1 AND is_primary = true',
          [organizationId],
        );
      }

      const { rows } = await client.query<DomainRow>(
        `UPDATE control.domains SET is_primary = $1 WHERE id = $2 RETURNING ${DOMAIN_ROW_COLUMNS}`,
        [dto.isPrimary, domainId],
      );
      const row = rows[0];

      await this.auditLogs.record(client, organizationId, actorUserId, 'domain.primary_set', {
        resourceType: 'domain',
        resourceId: domainId,
        metadata: { domainName: domain.domain_name, isPrimary: dto.isPrimary },
      });

      return row;
    });
    return this.toDto(row);
  }

  /**
   * DELETE /domains/{domainId}. Blocked on active mailboxes (`422
   * DOMAIN_HAS_ACTIVE_MAILBOXES`, api-contract.md §6) — the documented
   * guard. Also blocked on pending invites (`422 DOMAIN_HAS_PENDING_INVITES`)
   * — not in api-contract.md's documented error list for this endpoint, but
   * a real gap found while building this: `tenant.invites.domain_id`
   * references `control.domains(id)` with no `ON DELETE` action (default
   * RESTRICT), so a domain with an outstanding invite would otherwise fail
   * this DELETE with a raw foreign-key-violation 500 instead of a clean,
   * actionable error — exactly the failure mode the documented mailboxes
   * guard exists to avoid, just for the other table that FKs this one.
   */
  async remove(organizationId: string, actorUserId: string, domainId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      const domain = await this.findByIdOrThrow(client, organizationId, domainId);

      const { rows: mailboxRows } = await client.query<{ id: string }>(
        `SELECT id FROM tenant.mailboxes WHERE domain_id = $1 AND status <> 'deleted'`,
        [domainId],
      );
      if (mailboxRows.length > 0) {
        throw new AppException(
          422,
          'DOMAIN_HAS_ACTIVE_MAILBOXES',
          'This domain still has active mailboxes — reassign or delete them first.',
          { mailboxIds: mailboxRows.map((r) => r.id) },
        );
      }

      const { rows: inviteRows } = await client.query<{ id: string }>(
        `SELECT id FROM tenant.invites WHERE domain_id = $1 AND accepted_at IS NULL`,
        [domainId],
      );
      if (inviteRows.length > 0) {
        throw new AppException(
          422,
          'DOMAIN_HAS_PENDING_INVITES',
          'This domain still has pending invites — revoke them first.',
          { inviteIds: inviteRows.map((r) => r.id) },
        );
      }

      // Added 2026-10-07. Soft-deleted mailboxes, their aliases and accepted
      // invites all still reference this domain, and none of those foreign
      // keys has an ON DELETE action — so any domain that ever had a
      // mailbox failed to delete with a raw FK 500. All of it is history the
      // guards above have already established is dead; the audit log keeps
      // the record. A deleted user whose primary mailbox goes away here
      // simply loses that pointer.
      await client.query(
        `UPDATE tenant.users SET primary_mailbox_id = NULL
         WHERE status = 'deleted'
           AND primary_mailbox_id IN (SELECT id FROM tenant.mailboxes WHERE domain_id = $1)`,
        [domainId],
      );
      await client.query('DELETE FROM tenant.mailbox_aliases WHERE domain_id = $1', [domainId]);
      await client.query("DELETE FROM tenant.mailboxes WHERE domain_id = $1 AND status = 'deleted'", [domainId]);
      await client.query('DELETE FROM tenant.invites WHERE domain_id = $1 AND accepted_at IS NOT NULL', [domainId]);

      await client.query('DELETE FROM control.domains WHERE id = $1', [domainId]);

      await this.auditLogs.record(client, organizationId, actorUserId, 'domain.removed', {
        resourceType: 'domain',
        resourceId: domainId,
        metadata: { domainName: domain.domain_name },
      });
    });
  }

  /**
   * Replaces MailboxesService's former `findVerifiedDomainOrThrow` (Step
   * 1.6) now that a real Domains module exists to own it. Signature
   * unchanged on purpose — takes a `PoolClient` because mailbox/invite
   * creation (UsersService's onboarding paths) always calls this as one
   * step inside a larger transaction that already called
   * `setTenantContext`, never as its own standalone transaction.
   */
  async findVerifiedDomainOrThrow(client: PoolClient, organizationId: string, domainId: string): Promise<VerifiedDomain> {
    const domain = await this.findByIdOrThrow(client, organizationId, domainId);
    if (domain.verification_status !== 'verified') {
      throw new AppException(
        422,
        'DOMAIN_NOT_VERIFIED',
        'This domain has not been verified yet — verify ownership before inviting or creating users on it.',
      );
    }
    return { id: domain.id, domainName: domain.domain_name };
  }

  /**
   * Used by UsersService.invite to source the `invitations@<org's primary
   * domain>` sender address (business-rules-and-defaults.md's invite-
   * delivery exception). Returns `null` when the org has no primary domain
   * yet (e.g. a domain exists but hasn't been explicitly set primary) so
   * the caller can fall back to the platform's own default sender.
   */
  async findPrimaryDomainName(client: PoolClient, organizationId: string): Promise<string | null> {
    const { rows } = await client.query<{ domain_name: string }>(
      'SELECT domain_name FROM control.domains WHERE organization_id = $1 AND is_primary = true',
      [organizationId],
    );
    return rows[0]?.domain_name ?? null;
  }

  /** 404s, never a bare empty result — a cross-org id is indistinguishable from a missing one (api-contract.md §0). */
  private async findByIdOrThrow(client: PoolClient, organizationId: string, domainId: string): Promise<DomainRow> {
    const { rows } = await client.query<DomainRow>(
      `SELECT ${DOMAIN_ROW_COLUMNS} FROM control.domains WHERE id = $1 AND organization_id = $2`,
      [domainId, organizationId],
    );
    if (rows.length === 0) {
      throw new AppException(404, 'NOT_FOUND', 'Domain not found.');
    }
    return rows[0];
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
  }

  // ---- Live DNS checks ----------------------------------------------------
  // Every raw dns.promises call is wrapped twice: `.catch(() => [])` turns
  // any resolution failure (NXDOMAIN, ENODATA, SERVFAIL, ...) into "no
  // records" rather than a rejection, and withTimeout bounds how long a
  // slow/unreachable resolver can hang the request. Neither path ever
  // throws — a broken customer DNS setup is reported as an unmet checklist
  // item, never a 500.

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer!: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveTxtSafe(hostname: string, timeoutMs: number): Promise<string[][]> {
    return this.withTimeout(dns.resolveTxt(hostname).catch(() => []), timeoutMs, []);
  }

  private async checkOwnershipTxt(domainName: string, token: string, timeoutMs: number): Promise<boolean> {
    const expected = `workspace-verification=${token}`;
    const records = await this.resolveTxtSafe(domainName, timeoutMs);
    return records.some((chunks) => chunks.join('').trim() === expected);
  }

  private async checkSpf(domainName: string, spfInclude: string, timeoutMs: number): Promise<boolean> {
    const records = await this.resolveTxtSafe(domainName, timeoutMs);
    return records.some((chunks) => {
      const value = chunks.join('');
      return value.startsWith('v=spf1') && value.includes(spfInclude);
    });
  }

  private async checkDmarc(domainName: string, timeoutMs: number): Promise<boolean> {
    const records = await this.resolveTxtSafe(`_dmarc.${domainName}`, timeoutMs);
    return records.some((chunks) => chunks.join('').trim().startsWith('v=DMARC1'));
  }

  private async checkDkim(domainName: string, selector: string, publicKeyBase64: string, timeoutMs: number): Promise<boolean> {
    const records = await this.resolveTxtSafe(`${selector}._domainkey.${domainName}`, timeoutMs);
    return records.some((chunks) => chunks.join('').includes(`p=${publicKeyBase64}`));
  }

  private async checkMx(domainName: string, expectedHost: string, timeoutMs: number): Promise<boolean> {
    const records = await this.withTimeout<MxRecord[]>(dns.resolveMx(domainName).catch(() => []), timeoutMs, []);
    const normalizedExpected = expectedHost.toLowerCase().replace(/\.$/, '');
    return records.some((r) => r.exchange.toLowerCase().replace(/\.$/, '') === normalizedExpected);
  }

  private async checkAutodiscovery(domainName: string, expectedHost: string, timeoutMs: number): Promise<boolean> {
    const serviceNames = ['_imaps._tcp', '_submission._tcp', '_autodiscover._tcp'];
    const normalizedExpected = expectedHost.toLowerCase().replace(/\.$/, '');
    const results = await Promise.all(
      serviceNames.map((service) =>
        this.withTimeout<SrvRecord[]>(dns.resolveSrv(`${service}.${domainName}`).catch(() => []), timeoutMs, []),
      ),
    );
    // All three must resolve to the platform host — matches the single
    // combined checklist row api-contract.md documents for "autodiscovery".
    return results.every((records) => records.some((r) => r.name.toLowerCase().replace(/\.$/, '') === normalizedExpected));
  }

  /**
   * RSA-2048 via the async (non-blocking) generateKeyPair — NOT
   * generateKeyPairSync, which would stall the event loop for the
   * ~100-500ms RSA generation takes. The public key is PEM-stripped
   * (headers/whitespace removed) to the raw base64 DER value DKIM's own
   * `p=` DNS tag needs; the private key is handed back as full PEM for the
   * caller to encrypt via EncryptionService before storage.
   */
  private async generateDkimKeyPair(): Promise<{ selector: string; publicKeyBase64: string; privateKeyPem: string }> {
    const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const publicKeyBase64 = publicKey
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s+/g, '');
    const selector = `s1${randomBytes(4).toString('hex')}`;
    return { selector, publicKeyBase64, privateKeyPem: privateKey };
  }

  private toDto(row: DomainRow): DomainDto {
    return {
      id: row.id,
      domainName: row.domain_name,
      verificationStatus: row.verification_status,
      isPrimary: row.is_primary,
      dkimSelector: row.dkim_selector,
      dkimStatus: !row.dkim_public_key ? 'not_generated' : row.dkim_verified_at ? 'verified' : 'pending',
      verifiedAt: row.verified_at,
      createdAt: row.created_at,
    };
  }
}
