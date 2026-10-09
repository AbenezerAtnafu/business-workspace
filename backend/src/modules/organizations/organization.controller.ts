import { Body, Controller, Get, Patch } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

/**
 * The caller's own organization — architecture/api-contract.md §2.
 * Singular path, no id: a token belongs to exactly one org, so there is
 * nothing to choose (and no way to reach another org's profile).
 * GET is open to every member (permission matrix: Settings read for
 * Member); PATCH is Owner/Admin.
 */
@Controller('organization')
export class OrganizationController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  async get(@CurrentUser() claims: AccessTokenClaims) {
    return this.organizations.getCurrent(claims.organizationId);
  }

  @Roles('owner', 'admin')
  @Patch()
  async update(@CurrentUser() claims: AccessTokenClaims, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(claims.organizationId, claims.userId, dto);
  }
}
