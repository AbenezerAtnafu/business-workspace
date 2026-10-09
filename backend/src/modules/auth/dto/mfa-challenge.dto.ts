import { IsString, Matches } from 'class-validator';

export class MfaChallengeDto {
  @IsString()
  mfaChallengeToken!: string;

  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code!: string;
}
