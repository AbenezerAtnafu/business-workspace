import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { LOCAL_PART_MESSAGE, LOCAL_PART_REGEX } from '../../../common/validation/local-part';

/**
 * POST /users — architecture/api-contract.md §3, "Path B — admin-issued
 * credentials." No contactEmail (unlike InviteUserDto) — this path exists
 * precisely for when there's no reachable contact email at all.
 */
export class CreateUserDto {
  @IsUUID('7')
  domainId!: string;

  @IsString()
  @Matches(LOCAL_PART_REGEX, { message: LOCAL_PART_MESSAGE })
  localPart!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsIn(['admin', 'member'])
  role?: 'admin' | 'member';

  @IsOptional()
  @IsUUID('7')
  orgUnitId?: string;
}
