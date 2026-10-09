import { IsUUID } from 'class-validator';

/** POST /me/primary-mailbox — architecture/api-contract.md §2 ("Owner signup"). */
export class ClaimPrimaryMailboxDto {
  @IsUUID('7')
  mailboxId!: string;
}
