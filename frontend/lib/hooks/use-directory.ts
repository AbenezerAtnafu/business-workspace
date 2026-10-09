'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import type { Domain, Group, ListResponse, Mailbox, OrgUnit, User } from '@/lib/api/types';
import { useApiQuery } from './use-api-query';

/**
 * Id → display-name lookups for screens that show raw ids (Audit Logs,
 * Overview activity). Loads the org's current users, domains, mailboxes,
 * groups and org units once. GET /users omits deleted users, so ids it
 * doesn't know are fetched one by one through GET /users/{id} (which does
 * return deleted users) via `resolveUsers`.
 */
export function useDirectory() {
  const users = useApiQuery<ListResponse<User>>('/users');
  const domains = useApiQuery<ListResponse<Domain>>('/domains');
  const mailboxes = useApiQuery<ListResponse<Mailbox>>('/mailboxes');
  const groups = useApiQuery<ListResponse<Group>>('/groups');
  const orgUnits = useApiQuery<ListResponse<OrgUnit>>('/org-units');
  const [extraUsers, setExtraUsers] = useState<Record<string, User | null>>({});
  const requested = useRef(new Set<string>());

  const userMap = useMemo(() => {
    const map = new Map<string, User>();
    for (const u of users.data?.data ?? []) map.set(u.id, u);
    for (const [id, u] of Object.entries(extraUsers)) if (u) map.set(id, u);
    return map;
  }, [users.data, extraUsers]);

  const resolveUsers = useCallback(
    (ids: string[]) => {
      if (!users.data) return; // wait for the list first
      const missing = [...new Set(ids)].filter((id) => !userMap.has(id) && !requested.current.has(id)).slice(0, 25);
      for (const id of missing) {
        requested.current.add(id);
        api<User>(`/users/${id}`)
          .then((u) => setExtraUsers((prev) => ({ ...prev, [id]: u })))
          .catch(() => setExtraUsers((prev) => ({ ...prev, [id]: null })));
      }
    },
    [users.data, userMap],
  );

  const userName = useCallback(
    (id: string | null | undefined) => {
      if (!id) return 'System';
      const u = userMap.get(id);
      if (!u) return extraUsers[id] === null ? 'Unknown user' : 'Someone';
      return u.status === 'deleted' ? `${u.name} (deleted)` : u.name;
    },
    [userMap, extraUsers],
  );

  const domainName = useCallback(
    (id: string | null | undefined) => (id ? domains.data?.data.find((d) => d.id === id)?.domainName : undefined),
    [domains.data],
  );

  const resourceName = useCallback(
    (type: string | null, id: string | null): string | undefined => {
      if (!id) return undefined;
      switch (type) {
        case 'user':
          return userName(id);
        case 'domain':
          return domainName(id);
        case 'mailbox':
          return mailboxes.data?.data.find((m) => m.id === id)?.email;
        case 'group':
          return groups.data?.data.find((g) => g.id === id)?.name;
        case 'org_unit':
          return orgUnits.data?.data.find((o) => o.id === id)?.name;
        case 'organization':
          return 'Organization settings';
        default:
          return undefined;
      }
    },
    [userName, domainName, mailboxes.data, groups.data, orgUnits.data],
  );

  return {
    users: users.data?.data ?? [],
    loading: users.loading && !users.data,
    userName,
    domainName,
    resourceName,
    resolveUsers,
  };
}
