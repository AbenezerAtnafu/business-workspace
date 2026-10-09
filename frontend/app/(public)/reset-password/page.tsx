import { redirect } from 'next/navigation';

/**
 * The backend's reset email links to `${APP_BASE_URL}/reset-password?token=…`
 * (AuthService.requestPasswordReset), while this app's screen lives at
 * /forgot-password/confirm per the site map. Redirect rather than rename either.
 */
export default function ResetPasswordRedirect({ searchParams }: { searchParams: { token?: string } }) {
  const token = typeof searchParams.token === 'string' ? searchParams.token : '';
  redirect(token ? `/forgot-password/confirm?token=${encodeURIComponent(token)}` : '/forgot-password/confirm');
}
