'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, onSessionExpired, refreshAccessToken, setAccessToken } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: Me | null;
  /** Adopt an access token from any session-issuing response, then load GET /me. */
  establishSession: (accessToken: string) => Promise<Me>;
  /** Re-fetch GET /me (after MFA changes, role transfer, primary-mailbox claim…). */
  refreshMe: () => Promise<Me | null>;
  /** POST /auth/logout, then forget everything locally regardless of outcome. */
  logout: () => Promise<void>;
  /**
   * Why the last session ended, so the route guard can explain it on Log In:
   * 'expired' (refresh failed mid-session) or 'logout' (user chose to).
   */
  endReason: 'expired' | 'logout' | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Session lifecycle for the whole app. On first mount it tries to restore a
 * session from the httpOnly refresh cookie (POST /auth/refresh → GET /me) —
 * that's the only way to survive a reload, since the access token itself is
 * memory-only (see lib/api/client.ts).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<Me | null>(null);
  const [endReason, setEndReason] = useState<'expired' | 'logout' | null>(null);
  const restoreStarted = useRef(false);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const loadMe = useCallback(async () => {
    const me = await api<Me>('/me');
    setUser(me);
    setStatus('authenticated');
    setEndReason(null);
    return me;
  }, []);

  useEffect(() => {
    // StrictMode mounts effects twice in dev; refreshAccessToken() is
    // single-flight anyway, but there's no reason to even ask twice.
    if (restoreStarted.current) return;
    restoreStarted.current = true;

    (async () => {
      const token = await refreshAccessToken();
      if (!token) {
        clearSession();
        return;
      }
      try {
        await loadMe();
      } catch {
        clearSession();
      }
    })();
  }, [clearSession, loadMe]);

  useEffect(
    () =>
      onSessionExpired(() => {
        setEndReason('expired');
        clearSession();
      }),
    [clearSession],
  );

  const establishSession = useCallback(
    async (accessToken: string) => {
      setAccessToken(accessToken);
      return loadMe();
    },
    [loadMe],
  );

  const refreshMe = useCallback(async () => {
    try {
      return await loadMe();
    } catch {
      return null;
    }
  }, [loadMe]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // Already-expired session or network error: local sign-out still wins.
    }
    setEndReason('logout');
    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, establishSession, refreshMe, logout, endReason }),
    [status, user, establishSession, refreshMe, logout, endReason],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Narrowed variant for screens inside the (app) shell, which only render once authenticated. */
export function useCurrentUser(): Me {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser used outside an authenticated route');
  return user;
}
