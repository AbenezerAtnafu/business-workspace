import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { UsersController } from './users.controller';
import { InvitesController } from './invites.controller';
import { UsersService } from './users.service';
import { MailboxesModule } from '../mailboxes/mailboxes.module';
import { DomainsModule } from '../domains/domains.module';
import { MailerModule } from '../../common/mailer/mailer.module';
import { SessionsModule } from '../../common/sessions/sessions.module';
import { TokensModule } from '../../common/tokens/tokens.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * User Management — claude/srs.md §7.3, architecture/api-contract.md §3.
 * Implementation-plan Step 1.6: both onboarding paths (email invite via
 * tenant.invites, and admin-issued temporary credentials), the generalized
 * admin-triggered password reissue (POST /users/{userId}/password/reissue),
 * GET /invites/{token} (public preview, 410 INVITE_NOT_ACTIVE on expiry),
 * role/status/org-unit changes, and ownership transfer.
 *
 * Depends on MailboxesModule for the narrow slot-check/mailbox-creation
 * surface Step 2.3 will later expand (see mailboxes.service.ts),
 * DomainsModule (Step 2.2) for domain lookup/verification and the org's
 * primary-domain name (invite-email `from` address), MailerModule for
 * invite delivery (the same outbound-email pre-cut Step 1.4's password
 * reset uses), SessionsModule (accept-invite issues a real session), and
 * TokensModule (signs its access token).
 */
@Module({
  imports: [MailboxesModule, DomainsModule, MailerModule, SessionsModule, TokensModule, NotificationsModule, RateLimitModule],
  controllers: [UsersController, InvitesController],
  providers: [UsersService],
  // Exported for AuthController's POST /me/primary-mailbox (Step 2.3).
  exports: [UsersService],
})
export class UsersModule {}
