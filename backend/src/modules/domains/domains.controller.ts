import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { DomainsService } from './domains.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import { SetPrimaryDomainDto } from './dto/set-primary-domain.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

@Controller('domains')
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @Get()
  async list(@CurrentUser() claims: AccessTokenClaims) {
    return { data: await this.domainsService.list(claims.organizationId) };
  }

  @Get(':domainId')
  async getById(@CurrentUser() claims: AccessTokenClaims, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return this.domainsService.getById(claims.organizationId, domainId);
  }

  @Get(':domainId/dns-records')
  async getDnsRecords(@CurrentUser() claims: AccessTokenClaims, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return { records: await this.domainsService.getDnsRecords(claims.organizationId, domainId) };
  }

  @Roles('owner', 'admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() claims: AccessTokenClaims, @Body() dto: CreateDomainDto) {
    return this.domainsService.create(claims.organizationId, claims.userId, dto);
  }

  @Roles('owner', 'admin')
  @Post(':domainId/verify')
  // 200, not Nest's POST default of 201: a verification check creates nothing.
  @HttpCode(HttpStatus.OK)
  async verify(@CurrentUser() claims: AccessTokenClaims, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return this.domainsService.verify(claims.organizationId, claims.userId, domainId);
  }

  @Roles('owner', 'admin')
  @Patch(':domainId')
  async setPrimary(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
    @Body() dto: SetPrimaryDomainDto,
  ) {
    return this.domainsService.setPrimary(claims.organizationId, claims.userId, domainId, dto);
  }

  @Roles('owner', 'admin')
  @Delete(':domainId')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() claims: AccessTokenClaims, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    await this.domainsService.remove(claims.organizationId, claims.userId, domainId);
    return {};
  }
}
