import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { AuditLogsService } from './audit-logs.service';

/**
 * Audit Logs — architecture/api-contract.md §11. Owner/Admin only on both
 * routes (business-rules-and-defaults.md's permission matrix: "Audit logs |
 * Read | Read | —" — Members have no access at all, not even read).
 */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Roles('owner', 'admin')
  @Get()
  async list(
    @CurrentUser() claims: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.auditLogs.list(claims.organizationId, {
      limit,
      cursor,
      actorUserId,
      action,
      resourceType,
      from,
      to,
    });
  }

  @Roles('owner', 'admin')
  @Get(':id')
  async getById(@CurrentUser() claims: AccessTokenClaims, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.auditLogs.getById(claims.organizationId, id);
  }
}
