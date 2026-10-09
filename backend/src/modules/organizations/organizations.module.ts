import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { TokensModule } from '../../common/tokens/tokens.module';
import { SessionsModule } from '../../common/sessions/sessions.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationController } from './organization.controller';
import { OrganizationsService } from './organizations.service';

/**
 * Organization Management — claude/srs.md §7.2, architecture/api-contract.md §2.
 * Implementation-plan Step 1.3 (Owner bootstrap transaction): POST /organizations
 * creates control.organizations + the root tenant.org_units row + the Owner's
 * tenant.users row + control.user_directory, all in one transaction.
 * See architecture/data-model.md ("Owner bootstrap (organization signup)")
 * and organizations.service.ts for the full ordering/RLS notes.
 *
 * GET/PATCH /organization (OrganizationController, added 2026-10-07) read
 * and edit the caller's own org. POST /me/primary-mailbox lives on
 * AuthController with the rest of /me/*.
 */
@Module({
  imports: [TokensModule, SessionsModule, RateLimitModule],
  controllers: [OrganizationsController, OrganizationController],
  providers: [OrganizationsService],
})
export class OrganizationsModule {}
