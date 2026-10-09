import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { UsersService } from './users.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { setRefreshCookie } from '../../common/auth/refresh-cookie.util';

/**
 * Invite-specific routes — architecture/api-contract.md §3. Split from
 * UsersController because two of these (`GET /invites/{token}`,
 * `POST /invites/{token}/accept`) are @Public() and token-scoped, not
 * Bearer-authenticated — keeping them on a separate controller makes that
 * split obvious at a glance rather than buried in a mix of @Roles()/
 * @Public() decorators on one big controller.
 */
@Controller('invites')
export class InvitesController {
  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  @Roles('owner', 'admin')
  @Get()
  async list(@CurrentUser() claims: AccessTokenClaims) {
    return { data: await this.usersService.listInvites(claims.organizationId) };
  }

  @Roles('owner', 'admin')
  @Delete(':inviteId')
  @HttpCode(HttpStatus.OK)
  async revoke(@CurrentUser() claims: AccessTokenClaims, @Param('inviteId', new ParseUUIDPipe()) inviteId: string) {
    await this.usersService.revokeInvite(claims.organizationId, inviteId);
    return {};
  }

  @Public()
  @Get(':token')
  async preview(@Param('token') token: string) {
    return this.usersService.previewInvite(token);
  }

  @Public()
  @Post(':token/accept')
  @HttpCode(HttpStatus.CREATED)
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInviteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.usersService.acceptInvite(
      token,
      dto,
      req.headers['user-agent'],
      req.ip,
    );
    setRefreshCookie(res, this.configService, refreshToken);
    return { accessToken, user };
  }
}
