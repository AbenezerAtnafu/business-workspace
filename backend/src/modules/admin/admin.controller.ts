import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { AdminService } from './admin.service';

/**
 * Admin Console: Overview — architecture/api-contract.md §12. One route;
 * the rest of the Admin Console (Users, Org Units & Groups, Domains, Email,
 * Audit Logs, Security, Settings) is the existing per-module controllers,
 * not new surface (api-contract.md §12's own closing note).
 */
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Roles('owner', 'admin')
  @Get('overview')
  async getOverview(@CurrentUser() claims: AccessTokenClaims) {
    return this.admin.getOverview(claims.organizationId);
  }
}
