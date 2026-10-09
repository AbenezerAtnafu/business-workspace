import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { MailboxesService } from './mailboxes.service';
import { CreateMailboxDto } from './dto/create-mailbox.dto';
import { UpdateMailboxDto } from './dto/update-mailbox.dto';
import { CreateAliasDto } from './dto/create-alias.dto';
import { CreateAccessGrantDto } from './dto/create-access-grant.dto';
import { UpdateAccessGrantDto } from './dto/update-access-grant.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

/**
 * Business Email — provisioning — architecture/api-contract.md §7.
 * GET /mailboxes and GET /mailboxes/{mailboxId} are open to "Any" (no
 * @Roles()) because their per-caller/per-resource filtering happens inside
 * MailboxesService itself (list() branches on role; getById() calls
 * assertReadAccess()) — a blanket @Roles('owner','admin') here would wrongly
 * 403 a Member looking at their own mailbox or a shared one they're granted
 * into. GET /mailboxes/{mailboxId}/access is the same story for the
 * manage-grantee case.
 */
@Controller('mailboxes')
export class MailboxesController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  @Roles('owner', 'admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() claims: AccessTokenClaims, @Body() dto: CreateMailboxDto) {
    return this.mailboxesService.create(claims.organizationId, claims.userId, dto);
  }

  @Get()
  async list(@CurrentUser() claims: AccessTokenClaims) {
    return { data: await this.mailboxesService.list(claims.organizationId, claims) };
  }

  @Get(':mailboxId')
  async getById(@CurrentUser() claims: AccessTokenClaims, @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string) {
    return this.mailboxesService.getById(claims.organizationId, claims, mailboxId);
  }

  @Roles('owner', 'admin')
  @Patch(':mailboxId')
  async update(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Body() dto: UpdateMailboxDto,
  ) {
    return this.mailboxesService.update(claims.organizationId, claims.userId, mailboxId, dto);
  }

  @Roles('owner', 'admin')
  @Delete(':mailboxId')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() claims: AccessTokenClaims, @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string) {
    await this.mailboxesService.remove(claims.organizationId, claims.userId, mailboxId);
    return {};
  }

  @Roles('owner', 'admin')
  @Post(':mailboxId/aliases')
  @HttpCode(HttpStatus.CREATED)
  async createAlias(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Body() dto: CreateAliasDto,
  ) {
    return this.mailboxesService.createAlias(claims.organizationId, claims.userId, mailboxId, dto);
  }

  @Get(':mailboxId/access')
  async listAccessGrants(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
  ) {
    return { data: await this.mailboxesService.listAccessGrants(claims.organizationId, claims, mailboxId) };
  }

  @Roles('owner', 'admin')
  @Post(':mailboxId/access')
  @HttpCode(HttpStatus.CREATED)
  async createAccessGrant(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Body() dto: CreateAccessGrantDto,
  ) {
    return this.mailboxesService.createAccessGrant(claims.organizationId, claims.userId, mailboxId, dto);
  }

  @Roles('owner', 'admin')
  @Patch(':mailboxId/access/:grantId')
  async updateAccessGrant(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body() dto: UpdateAccessGrantDto,
  ) {
    return this.mailboxesService.updateAccessGrant(claims.organizationId, claims.userId, mailboxId, grantId, dto);
  }

  @Roles('owner', 'admin')
  @Delete(':mailboxId/access/:grantId')
  @HttpCode(HttpStatus.OK)
  async removeAccessGrant(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
  ) {
    await this.mailboxesService.removeAccessGrant(claims.organizationId, claims.userId, mailboxId, grantId);
    return {};
  }
}
