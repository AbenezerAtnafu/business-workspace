import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { OrgUnitsService } from './org-units.service';
import { CreateOrgUnitDto } from './dto/create-org-unit.dto';
import { UpdateOrgUnitDto } from './dto/update-org-unit.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

@Controller('org-units')
export class OrgUnitsController {
  constructor(private readonly orgUnitsService: OrgUnitsService) {}

  @Get()
  async list(@CurrentUser() claims: AccessTokenClaims) {
    return { data: await this.orgUnitsService.listTree(claims.organizationId) };
  }

  @Roles('owner', 'admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() claims: AccessTokenClaims, @Body() dto: CreateOrgUnitDto) {
    return this.orgUnitsService.create(claims.organizationId, claims.userId, dto);
  }

  @Roles('owner', 'admin')
  @Patch(':orgUnitId')
  async update(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('orgUnitId', new ParseUUIDPipe()) orgUnitId: string,
    @Body() dto: UpdateOrgUnitDto,
  ) {
    return this.orgUnitsService.update(claims.organizationId, claims.userId, orgUnitId, dto);
  }

  @Roles('owner', 'admin')
  @Delete(':orgUnitId')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() claims: AccessTokenClaims, @Param('orgUnitId', new ParseUUIDPipe()) orgUnitId: string) {
    await this.orgUnitsService.remove(claims.organizationId, claims.userId, orgUnitId);
    return {};
  }
}
