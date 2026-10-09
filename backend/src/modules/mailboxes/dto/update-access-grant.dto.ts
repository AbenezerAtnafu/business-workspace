import { IsIn } from 'class-validator';

/** PATCH /mailboxes/{mailboxId}/access/{grantId} — "Change a grant's level." */
export class UpdateAccessGrantDto {
  @IsIn(['read_only', 'send_as', 'manage'])
  accessLevel!: 'read_only' | 'send_as' | 'manage';
}
