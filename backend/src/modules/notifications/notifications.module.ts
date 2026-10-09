import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Notifications — claude/srs.md §7.9, architecture/api-contract.md §10,
 * implementation-plan Step 3.1. In-app only. Invite delivery and
 * password-reset links are the documented email exceptions and go through
 * MailerService (Step 1.4/1.6), not this module.
 *
 * An ordinary (not @Global) module: imported explicitly by its three
 * consumers — AuthModule, UsersModule and DomainsModule.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
