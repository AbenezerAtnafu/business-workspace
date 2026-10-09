import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * architecture/api-contract.md §5: "Omitting parentOrgUnitId is rejected
 * (400) — every unit except the one auto-created root must have a parent;
 * there's no endpoint to create a second root." @IsUUID (not @IsOptional)
 * is what enforces that 400 here — a missing or non-UUID value fails
 * class-validator before the service layer even runs.
 *
 * @IsUUID('7') (not the bare, version-agnostic @IsUUID()) because every PK
 * in this schema is a UUIDv7 (architecture/data-model.md) — found necessary
 * after migration 007 fixed a real bug in uuidv7() (migration 000) that had
 * been producing ids with a correct version nibble but a non-conformant
 * variant nibble, which even bare @IsUUID() rejects.
 */
export class CreateOrgUnitDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsUUID('7')
  parentOrgUnitId!: string;
}
