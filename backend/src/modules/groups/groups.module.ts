import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/**
 * Organizational Units & Groups (groups half) — claude/srs.md §7.2,
 * architecture/api-contract.md §5. Implementation-plan Step 1.5: flat,
 * multi-membership groups whose only MVP function is as a mailbox_access
 * grant target (Phase 2, Step 2.3) — group CRUD + membership only, no
 * grant-management endpoints here (those live on tenant.mailbox_access,
 * §7, not yet built).
 */
@Module({
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
