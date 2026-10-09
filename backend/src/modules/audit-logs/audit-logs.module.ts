import { Global, Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';

/**
 * Audit Logs — claude/srs.md §7.10, implementation-plan Step 3.2.
 * `@Global()` deliberately, unlike NotificationsModule (Step 3.1, an
 * ordinarily-imported module with 3 consumers): AuditLogsService is called
 * from every mutating service in the app (org-units, groups, domains,
 * mailboxes, users, auth, organizations — 7+ consumers and growing), and
 * NestJS's own docs name exactly this shape ("a provider needed almost
 * everywhere") as the intended use for `@Global()`. Making it global means
 * none of those seven-plus modules need `AuditLogsModule` added to their own
 * `imports` array just to inject `AuditLogsService` — only this module
 * needs to be imported once, here, into AppModule.
 */
@Global()
@Module({
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
