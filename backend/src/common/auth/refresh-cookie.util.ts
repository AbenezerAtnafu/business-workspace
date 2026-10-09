import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

// architecture/api-contract.md §0: cookie is scoped to the refresh path only.
export const REFRESH_COOKIE_NAME = 'refreshToken';
export const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Extracted from AuthController once a second caller needed it (Step 1.6's
 * InvitesController — POST /invites/{token}/accept issues a session exactly
 * like login does, per architecture/api-contract.md §3's "201 { accessToken,
 * user } (... refresh cookie set)"). Same extract-once-a-second-caller-
 * needs-it reasoning as SessionsService (see its own doc comment) — keeping
 * this in one place means the cookie's security attributes can't drift
 * between the two controllers that set it.
 */
export function setRefreshCookie(res: Response, configService: ConfigService, refreshToken: string): void {
  // architecture/api-contract.md §0: the refresh token is never in the
  // JSON body — httpOnly/Secure/SameSite=Strict cookie only.
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: configService.get<boolean>('cookie.secure'),
    sameSite: 'strict',
    domain: configService.get<string>('cookie.domain'),
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  });
}

export function clearRefreshCookie(res: Response, configService: ConfigService): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: configService.get<boolean>('cookie.secure'),
    sameSite: 'strict',
    domain: configService.get<string>('cookie.domain'),
    path: REFRESH_COOKIE_PATH,
  });
}

export function readRefreshCookie(cookies: Record<string, string> | undefined): string | undefined {
  return cookies?.[REFRESH_COOKIE_NAME];
}
