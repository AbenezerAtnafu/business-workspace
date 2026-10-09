import { Module } from '@nestjs/common';
import { MailboxesService } from './mailboxes.service';
import { MailboxesController } from './mailboxes.controller';
import { AliasesController } from './aliases.controller';
import { DomainsModule } from '../domains/domains.module';

/**
 * Business Email — provisioning — claude/srs.md §7.6, architecture/api-contract.md §7.
 * Implementation-plan Step 2.3: mailbox create/delete/suspend/quota, aliases,
 * and access grants to a user OR a group (tenant.mailbox_access). The group
 * grant path depends on Step 1.5's groups already existing.
 *
 * MailboxesService is also exported for Step 1.6's onboarding paths
 * (UsersService), which need "check a slot, create a mailbox row" inside
 * their own transactions. DomainsModule supplies DomainsService for the
 * verified-domain lookups.
 */
@Module({
  imports: [DomainsModule],
  controllers: [MailboxesController, AliasesController],
  providers: [MailboxesService],
  exports: [MailboxesService],
})
export class MailboxesModule {}
