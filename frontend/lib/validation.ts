import { z } from 'zod';

/**
 * planning/business-rules-and-defaults.md ("Authentication"): minimum 10
 * characters, length favoured over composition rules. Mirrors the backend
 * DTOs' @MinLength(10) so users see the rule before submitting.
 */
export const PASSWORD_MIN = 10;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
  .max(256, 'Use at most 256 characters');

/** New password + confirmation, for every set-a-password form. */
export const passwordPairSchema = z
  .object({ password: newPasswordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords don’t match',
    path: ['confirmPassword'],
  });

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');
