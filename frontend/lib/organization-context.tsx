'use client';

import { createContext, useContext } from 'react';
import type { Organization } from '@/lib/api/types';
import { useApiQuery } from '@/lib/hooks/use-api-query';

interface OrganizationContextValue {
  organization: Organization | undefined;
  /** Replace the cached org after a successful PATCH, so the shell updates at once. */
  setOrganization: (org: Organization) => void;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

/**
 * The caller's organization (GET /organization), loaded once by the app shell
 * and shared, so the sidebar's name/logo and the Settings screen never
 * disagree after an edit.
 */
export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  const org = useApiQuery<Organization>('/organization');
  return (
    <OrganizationContext.Provider value={{ organization: org.data, setOrganization: org.setData }}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization(): OrganizationContextValue {
  const ctx = useContext(OrganizationContext);
  if (!ctx) throw new Error('useOrganization used outside OrganizationProvider');
  return ctx;
}
