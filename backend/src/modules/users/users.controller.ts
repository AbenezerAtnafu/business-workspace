import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { UsersService } from './users.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

/**
 * User Management — architecture/api-contract.md §3. Invite-specific routes
 * (GET /invites, DELETE /invites/{inviteId}, and the two public token-scoped
 * ones) live in InvitesController, not here — see that file.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async list(@CurrentUser() claims: AccessTokenClaims) {
    // No pagination meta — same precedent as GET /org-units, GET /groups.
    return { data: await this.usersService.list(claims.organizationId) };
  }

  @Get(':userId')
  async getById(@CurrentUser() claims: AccessTokenClaims, @Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.usersService.getById(claims.organizationId, userId);
  }

  @Roles('owner', 'admin')
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  async invite(@CurrentUser() claims: AccessTokenClaims, @Body() dto: InviteUserDto) {
    return this.usersService.invite(claims.organizationId, claims.userId, dto);
  }

  @Roles('owner', 'admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDirect(@CurrentUser() claims: AccessTokenClaims, @Body() dto: CreateUserDto) {
    return this.usersService.createDirect(claims.organizationId, claims.userId, dto);
  }

  @Roles('owner', 'admin')
  @Patch(':userId')
  async update(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(claims.organizationId, claims.userId, userId, dto);
  }

  @Roles('owner', 'admin')
  @Post(':userId/password/reissue')
  @HttpCode(HttpStatus.OK)
  async reissuePassword(@CurrentUser() claims: AccessTokenClaims, @Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.usersService.reissuePassword(claims.organizationId, claims.userId, userId);
  }

  @Roles('owner')
  @Post(':userId/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  async transferOwnership(@CurrentUser() claims: AccessTokenClaims, @Param('userId', new ParseUUIDPipe()) userId: string) {
    await this.usersService.transferOwnership(claims.organizationId, claims.userId, userId);
    return {};
  }

  @Roles('owner', 'admin')
  @Delete(':userId')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() claims: AccessTokenClaims, @Param('userId', new ParseUUIDPipe()) userId: string) {
    await this.usersService.remove(claims.organizationId, claims.userId, userId);
    return {};
  }
}
