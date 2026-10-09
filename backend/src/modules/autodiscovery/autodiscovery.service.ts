import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../database/database.service';

// RFC 6186 / Mozilla Autoconfig / Microsoft Autodiscover conventional ports
// — fixed platform-wide, not customer-specific, same reasoning as the SRV
// targets (architecture/domain-and-email-flow.md "Autodiscovery"): one
// shared mail hostname, one TLS cert, one set of ports for every
// organization's domains. 993 = IMAPS (implicit TLS), matching the
// `_imaps._tcp` SRV service name Step 2.2 already publishes; 587 = SMTP
// submission over STARTTLS, matching `_submission._tcp`.
export const AUTODISCOVERY_IMAPS_PORT = 993;
export const AUTODISCOVERY_SUBMISSION_PORT = 587;

export interface ResolvedMailServer {
  host: string;
  imapsPort: number;
  submissionPort: number;
}

/**
 * Backend autodiscovery responder — architecture/domain-and-email-flow.md
 * "Autodiscovery": "One shared service implementing the three standard
 * protocols clients actually use ... Given an email address's domain, it
 * returns the correct IMAP/SMTP host, port, and security type. No
 * per-customer instance of this service — one responder serves every
 * organization's domains."
 *
 * This is the one piece of shared logic both XML responders (Autoconfig,
 * Autodiscover — see autodiscovery.controller.ts) build their response
 * from. The third protocol, DNS SRV, needs no code here at all: it's pure
 * DNS the customer publishes themselves, already checked read-only by
 * DomainsService.checkAutodiscovery (Step 2.2) and surfaced as the
 * 'autodiscovery' row in GET /domains/{id}/dns-records — there's nothing
 * for the app to serve at request time for that mechanism.
 */
@Injectable()
export class AutodiscoveryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Returns the platform's shared mail server settings iff `domainName` is
   * a verified domain on this platform — never fabricates settings for a
   * domain nobody has proven ownership of, the same posture
   * domain-and-email-flow.md requires of Postfix's own inbound rule
   * ("Unverified/unknown domains must be explicitly rejected, not silently
   * dropped"). `control.domains` has no RLS (it's control-plane), so a
   * plain query() is correct here — there's no tenant context to set up
   * for a lookup that, by definition, runs before any user is identified.
   */
  async resolveForDomain(domainName: string): Promise<ResolvedMailServer | null> {
    const normalized = domainName.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const { rows } = await this.db.query<{ domain_name: string }>(
      `SELECT domain_name FROM control.domains WHERE domain_name = $1 AND verification_status = 'verified'`,
      [normalized],
    );
    if (rows.length === 0) {
      return null;
    }

    const host = this.configService.get<string>('platformMail.autodiscoveryHost')!;
    return { host, imapsPort: AUTODISCOVERY_IMAPS_PORT, submissionPort: AUTODISCOVERY_SUBMISSION_PORT };
  }
}
