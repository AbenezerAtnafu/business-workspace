import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { DomainsModule } from '../domains/domains.module';

/**
 * Admin Console: Overview — claude/srs.md §7.11, implementation-plan Step
 * 3.3. Imports DomainsModule for its exported DomainsService (reused
 * as-is for the `domains` tile). AuditLogsService needs no import here —
 * AuditLogsModule is @Global() (see its own doc comment), so it's already
 * available to this module's providers without being listed in `imports`.
 * UsersModule/MailboxesModule are deliberately NOT imported: the
 * totalUsers/activeUsers/mailboxCount tiles are computed with a direct
 * COUNT query in AdminService rather than through those services' own
 * list methods (see that service's doc comment for why).
 */
@Module({
  imports: [DomainsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
