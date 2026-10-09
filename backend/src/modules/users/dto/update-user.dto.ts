import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * PATCH /users/{userId} — architecture/api-contract.md §3: "Change role /
 * suspend / reactivate / move Org Unit." `role` accepts 'owner' at the DTO
 * level (unlike invite/create) deliberately — the contract calls for a
 * specific 422 ("Assigning 'owner' through this endpoint is rejected"), not
 * a generic 400, so UsersService needs to see the value to produce that
 * message rather than class-validator rejecting it first. `status` only
 * ever moves between 'active'/'suspended' here — 'invited' isn't reachable
 * post-creation and 'deleted' is DELETE /users/{userId}'s job, not PATCH's.
 */
export class UpdateUserDto {
  @IsOptional()
  @IsIn(['owner', 'admin', 'member'])
  role?: 'owner' | 'admin' | 'member';

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';

  @IsOptional()
  @IsUUID('7')
  orgUnitId?: string;
}
