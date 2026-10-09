'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError, type ApiError } from '@/lib/api/errors';

export interface ApiQuery<T> {
  data: T | undefined;
  error: string | null;
  /** The raw ApiError, for screens that branch on status/code (e.g. 404). */
  apiError: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace the cached data after a mutation that returned the new value. */
  setData: (next: T | ((prev: T | undefined) => T)) => void;
}

/**
 * Minimal GET-and-cache hook — enough for admin screens that load a list or
 * one record, mutate it, and reload. Pass `null` as the path to skip loading
 * (e.g. an admin-only endpoint for a Member). Deliberately not a full
 * data-fetching library; swap for TanStack Query if screens start sharing
 * caches across routes.
 */
export function useApiQuery<T>(path: string | null): ApiQuery<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const call = ++latest.current;
    setLoading(true);
    try {
      const result = await api<T>(path);
      if (call !== latest.current) return;
      setDataState(result);
      setError(null);
      setApiError(null);
    } catch (err) {
      if (call !== latest.current) return;
      setError(errorMessage(err));
      setApiError(isApiError(err) ? err : null);
    } finally {
      if (call === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setData = useCallback((next: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof next === 'function' ? (next as (p: T | undefined) => T)(prev) : next));
  }, []);

  return { data, error, apiError, loading, reload, setData };
}
