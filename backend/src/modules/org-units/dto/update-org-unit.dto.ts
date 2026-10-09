import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * architecture/api-contract.md §5: "PATCH /org-units/{orgUnitId} — Rename /
 * reparent." Both fields optional (a rename-only or reparent-only call is
 * fine), but note what's deliberately NOT offered: a way to set
 * parentOrgUnitId to null. The contract and data-model.md are explicit that
 * there is exactly one root unit, auto-created at signup, with "no endpoint
 * to create a second root" — allowing PATCH to null a unit's parent would
 * silently create one. OrgUnitsService additionally rejects reparenting the
 * existing root unit itself (its parent must never become non-null) and any
 * reparent that would introduce a cycle (neither is spelled out in the
 * docs, but both are needed to keep the tree a tree).
 */
export class UpdateOrgUnitDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsUUID('7')
  parentOrgUnitId?: string;
}
