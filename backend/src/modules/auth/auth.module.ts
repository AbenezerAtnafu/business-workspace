import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TokensModule } from '../../common/tokens/tokens.module';
import { SessionsModule } from '../../common/sessions/sessions.module';
import { AuthTokensModule } from '../../common/auth-tokens/auth-tokens.module';
import { EncryptionModule } from '../../common/encryption/encryption.module';
import { MailerModule } from '../../common/mailer/mailer.module';
import { MfaModule } from '../../common/mfa/mfa.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';

/**
 * Auth & Identity — claude/srs.md §7.1, architecture/api-contract.md §1.
 * Implementation-plan Step 1.4, now complete except PATCH /me/password
 * (self-service change while already authenticated — trivial, still not
 * built). The mustChangePassword login branch (POST /auth/password-change)
 * was completed in Step 1.6 once the Users module could actually produce
 * accounts in that state (Path B, admin-triggered reissue).
 *
 * JwtAuthGuard and RolesGuard are both registered globally (APP_GUARD —
 * every route authenticated by default, @Public() opts a handler out;
 * @Roles(...) further restricts an authenticated handler to specific
 * roles). Order matters and is NOT redundant with alphabetical/import
 * order: NestJS runs global guards in the order they're registered here,
 * so JwtAuthGuard (declared first) always attaches request.user before
 * RolesGuard (declared second) ever reads it. RolesGuard itself didn't
 * exist before Step 1.5 (Org Units & Groups) — every endpoint built in
 * Step 1.4 happened to be either @Public() or open to "Any" authenticated
 * role.
 *
 * Built across three sub-slices: auth guard + login (normal case) + GET
 * /me + the error-envelope filter; refresh/logout/session management;
 * self-service password reset (+ the outbound-email pre-cut the
 * implementation plan flagged) and TOTP-based MFA setup/verify/disable/
 * challenge.
 */
@Module({
  imports: [
    TokensModule,
    SessionsModule,
    AuthTokensModule,
    EncryptionModule,
    MailerModule,
    MfaModule,
    NotificationsModule,
    UsersModule,
    RateLimitModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
  exports: [],
})
export class AuthModule {}
