'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { FullPageSpinner } from '@/components/common/spinner';
import { useAuth } from '@/lib/auth/auth-context';

/**
 * Route guard for every authenticated screen. Real enforcement is the API's
 * job (every endpoint checks the bearer token and role); this only keeps
 * signed-out visitors from seeing an empty shell.
 */
export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const { status, endReason } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'unauthenticated') {
      if (endReason === 'logout') {
        router.replace('/login?reason=logged-out');
        return;
      }
      const params = new URLSearchParams({ next: pathname });
      if (endReason === 'expired') params.set('reason', 'session-expired');
      router.replace(`/login?${params.toString()}`);
    }
  }, [status, endReason, router, pathname]);

  if (status !== 'authenticated') return <FullPageSpinner />;
  return <AppShell>{children}</AppShell>;
}
