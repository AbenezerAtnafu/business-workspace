import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * "requires current password or a valid code, never a bare toggle"
 * (planning/screen-flow-inventory.md §2.11) — exactly one of these two is
 * required; AuthService enforces that (class-validator alone can't express
 * "at least one of these two fields" cleanly without a custom decorator,
 * and this is the only place in the app that needs it).
 */
export class MfaDisableDto {
  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code?: string;
}
