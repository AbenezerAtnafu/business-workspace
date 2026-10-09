import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrgUnitsModule } from './modules/org-units/org-units.module';
import { GroupsModule } from './modules/groups/groups.module';
import { UsersModule } from './modules/users/users.module';
import { DomainsModule } from './modules/domains/domains.module';
import { MailboxesModule } from './modules/mailboxes/mailboxes.module';
import { AutodiscoveryModule } from './modules/autodiscovery/autodiscovery.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';

// Role-based access control (RolesGuard, @Roles()) was built directly into
// AuthModule during Step 1.5 — there is no separate RbacModule.
//
// Step 2.4 (Webmail app code + attachment staging) was deliberately
// skipped, not just deferred silently — api-contract.md §8's endpoints
// are, by ADR-002's own design, a thin REST proxy in front of a live
// Dovecot/Postfix stack (Step 2.1, itself out of scope for this sandbox);
// there is no genuine, testable, non-mock slice of that step buildable
// without that infrastructure actually running. See claude/build-progress.md
// for the full note. Step 2.5 below has no such dependency — it's pure
// Postgres + HTTP, hence buildable now even with 2.4 skipped.
//
// Phase 2 (planning/implementation-plan.md §3):
// import { EmailModule } from './modules/email/email.module';
//
// Phase 3 (§4): NotificationsModule (Step 3.1), AuditLogsModule (Step 3.2,
// @Global() — see that module's own doc comment), and AdminModule (Step
// 3.3) are now imported above. Phase 3 is complete on the backend.

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
    OrganizationsModule,
    AuthModule,
    OrgUnitsModule,
    GroupsModule,
    UsersModule,
    DomainsModule,
    MailboxesModule,
    AutodiscoveryModule,
    NotificationsModule,
    AuditLogsModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
