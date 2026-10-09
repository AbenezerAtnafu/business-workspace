import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * PATCH /me/password. `currentPassword` deliberately has no length rule
 * (same reasoning as LoginDto): a wrong one must fail as INVALID_CREDENTIALS,
 * not VALIDATION_ERROR. `newPassword` follows the platform policy —
 * minimum 10 characters (planning/business-rules-and-defaults.md).
 */
export class ChangeOwnPasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(256)
  newPassword!: string;
}
