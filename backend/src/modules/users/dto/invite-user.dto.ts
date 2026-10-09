import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { LOCAL_PART_MESSAGE, LOCAL_PART_REGEX } from '../../../common/validation/local-part';

/**
 * POST /users/invite — architecture/api-contract.md §3, "Path A — email
 * invite." `role` excludes 'owner' deliberately — ownership is assigned
 * only via POST /users/{userId}/transfer-ownership
 * (planning/business-rules-and-defaults.md: "New invites default to the
 * Member role unless the inviter explicitly sets Admin at invite time").
 * `orgUnitId` omitted/absent defaults to the org's root unit on acceptance.
 */
export class InviteUserDto {
  @IsUUID('7')
  domainId!: string;

  @IsString()
  @Matches(LOCAL_PART_REGEX, { message: LOCAL_PART_MESSAGE })
  localPart!: string;

  @IsEmail()
  contactEmail!: string;

  @IsOptional()
  @IsIn(['admin', 'member'])
  role?: 'admin' | 'member';

  @IsOptional()
  @IsUUID('7')
  orgUnitId?: string;
}
