import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/** POST /invites/{token}/accept — "Invitee accepts, sets their own password." */
export class AcceptInviteDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @MinLength(10)
  password!: string;
}
