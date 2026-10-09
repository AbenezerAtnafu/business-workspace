'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FullPageSpinner } from '@/components/common/spinner';
import { useAuth } from '@/lib/auth/auth-context';
import { homePathFor } from '@/lib/auth/navigation';

/** `/` has no screen of its own: send the visitor to their home, or to Log In. */
export default function RootPage() {
  const { status, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated' && user) router.replace(homePathFor(user));
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, user, router]);

  return <FullPageSpinner />;
}
