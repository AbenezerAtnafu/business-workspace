import { IsString, Matches } from 'class-validator';
import { LOCAL_PART_MESSAGE, LOCAL_PART_REGEX } from '../../../common/validation/local-part';

/** POST /mailboxes/{mailboxId}/aliases — the alias lives on the target mailbox's own domain. */
export class CreateAliasDto {
  @IsString()
  @Matches(LOCAL_PART_REGEX, { message: LOCAL_PART_MESSAGE })
  localPart!: string;
}
