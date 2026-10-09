import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordChangeDto } from './dto/password-change.dto';
import { MfaVerifySetupDto } from './dto/mfa-verify-setup.dto';
import { MfaDisableDto } from './dto/mfa-disable.dto';
import { MfaChallengeDto } from './dto/mfa-challenge.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangeOwnPasswordDto } from './dto/change-own-password.dto';
import { UsersService } from '../users/users.service';
import { ClaimPrimaryMailboxDto } from '../users/dto/claim-primary-mailbox.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../../common/auth/refresh-cookie.util';

@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.authService.login(dto, req.headers['user-agent'], req.ip);

    // "mfaEnabled = true → { mfaChallengeToken } (no access/refresh issued
    // yet)" — architecture/api-contract.md §1. No cookie is set on this
    // branch; there's no session yet to attach one to. Same reasoning for
    // mustChangePassword → { passwordChangeToken }.
    if ('mfaChallengeToken' in outcome) {
      return { mfaChallengeToken: outcome.mfaChallengeToken };
    }
    if ('passwordChangeToken' in outcome) {
      return { passwordChangeToken: outcome.passwordChangeToken };
    }

    setRefreshCookie(res, this.configService, outcome.refreshToken);
    return { accessToken: outcome.accessToken, user: outcome.user };
  }

  @Public()
  @Post('auth/password-change')
  @HttpCode(HttpStatus.OK)
  async passwordChange(
    @Body() dto: PasswordChangeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.authService.passwordChange(
      dto,
      req.headers['user-agent'],
      req.ip,
    );
    setRefreshCookie(res, this.configService, refreshToken);
    return { accessToken, user };
  }

  @Public()
  @Post('auth/mfa/challenge')
  @HttpCode(HttpStatus.OK)
  async mfaChallenge(
    @Body() dto: MfaChallengeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.authService.mfaChallenge(
      dto,
      req.headers['user-agent'],
      req.ip,
    );
    setRefreshCookie(res, this.configService, refreshToken);
    return { accessToken, user };
  }

  @Public()
  @Post('auth/password-reset/request')
  @HttpCode(HttpStatus.OK)
  async requestPasswordReset(@Body() dto: PasswordResetRequestDto, @Req() req: Request) {
    await this.authService.requestPasswordReset(dto, req.ip);
    // Always the same generic body — screen-flow-inventory.md §2.1: "Always
    // shows a generic check-your-email message, whether or not the address
    // exists — don't leak account existence."
    return { message: 'If an account exists for that email, a password reset link has been sent.' };
  }

  @Public()
  @Post('auth/password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.authService.confirmPasswordReset(
      dto,
      req.headers['user-agent'],
      req.ip,
    );
    setRefreshCookie(res, this.configService, refreshToken);
    return { accessToken, user };
  }

  @Post('me/mfa/setup')
  async setupMfa(@CurrentUser() claims: AccessTokenClaims) {
    return this.authService.setupMfa(claims);
  }

  @Post('me/mfa/verify-setup')
  @HttpCode(HttpStatus.OK)
  async verifyMfaSetup(@CurrentUser() claims: AccessTokenClaims, @Body() dto: MfaVerifySetupDto) {
    await this.authService.verifyMfaSetup(claims, dto);
    return {};
  }

  @Post('me/mfa/disable')
  @HttpCode(HttpStatus.OK)
  async disableMfa(@CurrentUser() claims: AccessTokenClaims, @Body() dto: MfaDisableDto) {
    await this.authService.disableMfa(claims, dto);
    return {};
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = readRefreshCookie(req.cookies as Record<string, string> | undefined);
    const { accessToken, refreshToken } = await this.authService.refresh(rawRefreshToken);

    setRefreshCookie(res, this.configService, refreshToken);

    return { accessToken };
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() claims: AccessTokenClaims, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(claims);
    clearRefreshCookie(res, this.configService);
    return {};
  }

  @Get('me')
  async me(@CurrentUser() claims: AccessTokenClaims) {
    return this.authService.getMe(claims);
  }

  /** PATCH /me — change own display name (screen-flow-inventory.md §2.11). */
  @Patch('me')
  async updateMe(@CurrentUser() claims: AccessTokenClaims, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(claims, dto);
  }

  /** PATCH /me/password — api-contract.md §1. Keeps this session, revokes every other one. */
  @Patch('me/password')
  async changePassword(
    @CurrentUser() claims: AccessTokenClaims,
    @Body() dto: ChangeOwnPasswordDto,
    @Req() req: Request,
  ) {
    await this.authService.changePassword(claims, dto, req.ip);
    return {};
  }

  /**
   * POST /me/primary-mailbox — api-contract.md §2 ("Owner signup"). Lives
   * here with the rest of /me/*, backed by UsersService.claimPrimaryMailbox
   * (Step 2.3). After this call the caller's external contact email stops
   * working for login; the company address is their identity from now on.
   */
  @Post('me/primary-mailbox')
  @HttpCode(HttpStatus.OK)
  async claimPrimaryMailbox(@CurrentUser() claims: AccessTokenClaims, @Body() dto: ClaimPrimaryMailboxDto) {
    return this.usersService.claimPrimaryMailbox(claims.organizationId, claims.userId, dto);
  }

  @Get('me/sessions')
  async listSessions(@CurrentUser() claims: AccessTokenClaims) {
    // No pagination here (unlike the general list-endpoint convention in
    // architecture/api-contract.md §0) — this endpoint has no `?cursor=` in
    // the contract, and a `meta` block claiming hasMore/nextCursor support
    // that doesn't exist would be misleading.
    return { data: await this.authService.listSessions(claims) };
  }

  @Delete('me/sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ) {
    await this.authService.revokeSession(claims, sessionId);
    return {};
  }

  @Delete('me/sessions')
  @HttpCode(HttpStatus.OK)
  async revokeAllSessions(@CurrentUser() claims: AccessTokenClaims) {
    await this.authService.revokeAllSessions(claims);
    return {};
  }

}
