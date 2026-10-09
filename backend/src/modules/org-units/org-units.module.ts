import { Module } from '@nestjs/common';
import { OrgUnitsController } from './org-units.controller';
import { OrgUnitsService } from './org-units.service';

/**
 * Organizational Units & Groups (org-unit half) — claude/srs.md §7.2,
 * architecture/api-contract.md §5. Implementation-plan Step 1.5: tree CRUD,
 * reparent/delete guard (422 ORG_UNIT_NOT_EMPTY). The root unit itself is
 * created in Step 1.3's Owner bootstrap transaction, not here.
 */
@Module({
  controllers: [OrgUnitsController],
  providers: [OrgUnitsService],
})
export class OrgUnitsModule {}
