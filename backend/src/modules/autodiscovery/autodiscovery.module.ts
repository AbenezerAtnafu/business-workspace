import { Module } from '@nestjs/common';
import { AutodiscoveryController } from './autodiscovery.controller';
import { AutodiscoveryService } from './autodiscovery.service';

/**
 * Step 2.5 — SRV autodiscovery tier (planning/implementation-plan.md).
 * Despite the step's short name, the code here builds the OTHER two
 * protocols domain-and-email-flow.md's "Autodiscovery" section describes
 * (Mozilla Autoconfig XML, Microsoft Autodiscover XML) — the SRV mechanism
 * itself needed no application code: it's pure DNS the customer publishes,
 * already checked read-only by DomainsService.checkAutodiscovery (Step 2.2)
 * and surfaced as the 'autodiscovery' row in GET /domains/{id}/dns-records.
 *
 * No module dependencies: AutodiscoveryService reads control.domains
 * directly via DatabaseService (global) and platformMail.autodiscoveryHost
 * via ConfigService (global) — it doesn't need DomainsModule's own
 * tenant-scoped DomainsService, since this lookup deliberately runs before
 * any organization/tenant context exists at all.
 *
 * See architecture/decisions.md ADR-008 for the honest scoping note on how
 * each of the three protocols is actually reached by a real client.
 */
@Module({
  controllers: [AutodiscoveryController],
  providers: [AutodiscoveryService],
})
export class AutodiscoveryModule {}
