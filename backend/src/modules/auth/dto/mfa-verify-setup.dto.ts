import { Matches } from 'class-validator';

export class MfaVerifySetupDto {
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code!: string;
}
