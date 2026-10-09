import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * POST /auth/password-change — architecture/api-contract.md §1: "Forced
 * change after a temp or expired password." Consumes the passwordChangeToken
 * issued by POST /auth/login's mustChangePassword branch. Same password
 * policy as everywhere else (planning/business-rules-and-defaults.md —
 * "minimum 10 characters").
 */
export class PasswordChangeDto {
  @IsString()
  @IsNotEmpty()
  passwordChangeToken!: string;

  @IsString()
  @MinLength(10)
  newPassword!: string;
}
