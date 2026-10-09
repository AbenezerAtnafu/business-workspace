import { Module } from '@nestjs/common';

/**
 * Roles & Permissions — claude/srs.md §7.4, architecture/api-contract.md §4.
 * Implementation-plan Step 1.6 (built alongside User Management): role
 * assignment (owner/admin/member) and permission middleware. Independent of
 * Organizational Unit / Group membership — see srs.md §7.4's note.
 */
@Module({})
export class RbacModule {}
