import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  // Deliberately not @MinLength(10) here — that's the *new password* policy
  // (planning/business-rules-and-defaults.md) enforced at signup/password-
  // change time. A login attempt against an existing account must be
  // allowed to fail with INVALID_CREDENTIALS, not a 400 VALIDATION_ERROR,
  // regardless of what the submitted password looks like.
  @IsString()
  @MinLength(1)
  password!: string;
}
