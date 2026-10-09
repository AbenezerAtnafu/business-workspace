import { Module } from '@nestjs/common';
import { DomainsService } from './domains.service';
import { DomainsController } from './domains.controller';
import { EncryptionModule } from '../../common/encryption/encryption.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Custom Domains — claude/srs.md §7.5, architecture/api-contract.md §6.
 * Implementation-plan Step 2.2. Depends on EncryptionModule to encrypt
 * `control.domains.dkim_private_key` at rest, exactly as that service's own
 * doc comment anticipated (written back in Step 1.4, before this module
 * existed). Exports DomainsService: UsersModule needs
 * `findVerifiedDomainOrThrow`/`findPrimaryDomainName` for its two onboarding
 * paths, now that this module owns that logic instead of MailboxesService
 * (see domains.service.ts's doc comment).
 */
@Module({
  imports: [EncryptionModule, NotificationsModule],
  controllers: [DomainsController],
  providers: [DomainsService],
  exports: [DomainsService],
})
export class DomainsModule {}
