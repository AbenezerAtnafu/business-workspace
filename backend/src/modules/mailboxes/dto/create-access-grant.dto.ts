import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * POST /mailboxes/{mailboxId}/access — exactly one of `userId` or `groupId`
 * (api-contract.md §7, data-model.md's CHECK ((user_id IS NOT NULL) <>
 * (group_id IS NOT NULL))). That XOR can't be expressed with stock
 * class-validator decorators, so MailboxesService.createAccessGrant enforces
 * it and returns a clean 400 for both-or-neither.
 */
export class CreateAccessGrantDto {
  @IsOptional()
  @IsUUID('7')
  userId?: string;

  @IsOptional()
  @IsUUID('7')
  groupId?: string;

  @IsIn(['read_only', 'send_as', 'manage'])
  accessLevel!: 'read_only' | 'send_as' | 'manage';
}
