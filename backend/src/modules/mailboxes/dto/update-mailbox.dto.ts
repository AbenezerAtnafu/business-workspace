import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_QUOTA_BYTES, MIN_QUOTA_BYTES } from './create-mailbox.dto';

/**
 * PATCH /mailboxes/{mailboxId} — "Quota / status (suspend)". `status` only
 * moves between active and suspended; 'deleted' is DELETE's job.
 */
export class UpdateMailboxDto {
  @IsOptional()
  @IsInt()
  @Min(MIN_QUOTA_BYTES)
  @Max(MAX_QUOTA_BYTES)
  quotaBytes?: number;

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}
