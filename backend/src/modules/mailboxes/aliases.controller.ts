import { Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { MailboxesService } from './mailboxes.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

/**
 * Top-level `DELETE /aliases/{aliasId}` — architecture/api-contract.md §7
 * deliberately makes this a top-level resource rather than nesting it under
 * `/mailboxes/{mailboxId}/aliases/{aliasId}`: "{grantId} in the PATCH/DELETE
 * paths refers to the tenant.mailbox_access row's own id... since a grant
 * can target either" is the same reasoning extended to aliases — an
 * alias's own id is already globally unique within the org, so the caller
 * doesn't need to know (or re-fetch) its target mailbox just to remove it.
 */
@Controller('aliases')
export class AliasesController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  @Roles('owner', 'admin')
  @Delete(':aliasId')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() claims: AccessTokenClaims, @Param('aliasId', new ParseUUIDPipe()) aliasId: string) {
    await this.mailboxesService.removeAlias(claims.organizationId, claims.userId, aliasId);
    return {};
  }
}
