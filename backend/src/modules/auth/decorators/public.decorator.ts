import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route handler (or whole controller) as exempt from the global
 * JwtAuthGuard. Secure-by-default: every endpoint requires a valid Bearer
 * access token unless explicitly opted out with @Public() — chosen over an
 * allowlist-per-module approach so a newly added endpoint can never
 * accidentally ship unauthenticated.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
