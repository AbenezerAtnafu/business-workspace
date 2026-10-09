import { IsString, MinLength } from 'class-validator';

export class PasswordResetConfirmDto {
  @IsString()
  token!: string;

  // planning/business-rules-and-defaults.md ("Authentication"): minimum 10
  // characters, length favored over composition rules.
  @IsString()
  @MinLength(10)
  newPassword!: string;
}
