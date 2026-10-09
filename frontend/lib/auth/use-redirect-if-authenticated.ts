'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from './auth-context';
import { homePathFor, safeNextPath } from './navigation';

/**
 * Log In / Sign Up: a visitor who *arrives* already signed in goes straight
 * into the app. Only the initial session-restore result counts — once the
 * page itself signs someone in, its own submit handler decides where to go
 * (Sign Up → Setup Checklist, Log In → `next`), so we don't race it here.
 */
export function useRedirectIfAuthenticated(): { checking: boolean } {
  const { status, user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const initial = useRef<'pending' | 'authenticated' | 'unauthenticated'>('pending');

  if (initial.current === 'pending' && status !== 'loading') {
    initial.current = status;
  }

  useEffect(() => {
    if (initial.current === 'authenticated' && user) {
      router.replace(safeNextPath(params.get('next')) ?? homePathFor(user));
    }
  }, [user, router, params]);

  return { checking: status === 'loading' || initial.current === 'authenticated' };
}
