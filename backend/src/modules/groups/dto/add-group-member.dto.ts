import { IsUUID } from 'class-validator';

// '7', not bare @IsUUID() — every PK in this schema is a UUIDv7
// (architecture/data-model.md); see create-org-unit.dto.ts for the bug in
// migration 000's generator (fixed by 007) that made this distinction matter.
export class AddGroupMemberDto {
  @IsUUID('7')
  userId!: string;
}
