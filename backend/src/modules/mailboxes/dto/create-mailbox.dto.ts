import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { LOCAL_PART_MESSAGE, LOCAL_PART_REGEX } from '../../../common/validation/local-part';

/** 1 MiB floor, 1 TiB ceiling — anything outside that is a typo, not a plan. Default (5 GB) lives in the schema. */
export const MIN_QUOTA_BYTES = 1024 * 1024;
export const MAX_QUOTA_BYTES = 1024 ** 4;

/**
 * POST /mailboxes — architecture/api-contract.md §7. No `userId`: a mailbox
 * is either shared (user-less, the default) or the caller's own via
 * `assignToSelf: true` (the one-time Owner-bootstrap case, §2). Personal
 * mailboxes for other users are created only by the onboarding paths (§3).
 */
export class CreateMailboxDto {
  @IsUUID('7')
  domainId!: string;

  @IsString()
  @Matches(LOCAL_PART_REGEX, { message: LOCAL_PART_MESSAGE })
  localPart!: string;

  @IsOptional()
  @IsBoolean()
  assignToSelf?: boolean;

  @IsOptional()
  @IsInt()
  @Min(MIN_QUOTA_BYTES)
  @Max(MAX_QUOTA_BYTES)
  quotaBytes?: number;
}
