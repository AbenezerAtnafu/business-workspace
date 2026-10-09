'use client';

// Org Unit Tree + Groups — screen-flow-inventory.md §2.4 / Flows 10-11.
// GET/POST/PATCH/DELETE /org-units, GET/POST /groups. Everyone can view;
// Owner/Admin get the actions.

import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner } from '@/components/common/spinner';
import { GroupList } from '@/components/groups/group-list';
import { OrgUnitTree } from '@/components/org-units/org-unit-tree';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Group, ListResponse, OrgUnit, User } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';

function Loading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-8 w-1/3" />
    </div>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="space-y-3">
      <FormError message={message} />
      <Button variant="outline" size="sm" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

function OrgStructureScreen() {
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get('tab') === 'groups' ? 'groups' : 'units';

  const units = useApiQuery<ListResponse<OrgUnit>>('/org-units');
  const users = useApiQuery<ListResponse<User>>('/users');
  const groups = useApiQuery<ListResponse<Group>>('/groups');

  const setTab = (next: string) =>
    router.replace(next === 'groups' ? `${pathname}?tab=groups` : pathname, { scroll: false });

  return (
    <>
      <PageHeader
        title="Org units & groups"
        description="How your organization is arranged, and the teams you can grant mailbox access to."
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="units">Org units</TabsTrigger>
          <TabsTrigger value="groups">
            Groups
            {groups.data && groups.data.data.length > 0 && (
              <Badge variant="secondary" className="px-1.5">
                {groups.data.data.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="units">
          {units.error || users.error ? (
            <Failed
              message={(units.error ?? users.error)!}
              retry={() => {
                void units.reload();
                void users.reload();
              }}
            />
          ) : !units.data || !users.data ? (
            <Loading />
          ) : (
            <OrgUnitTree
              units={units.data.data}
              users={users.data.data}
              isAdmin={isAdmin}
              onChanged={async () => {
                await Promise.all([units.reload(), users.reload()]);
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="groups">
          {groups.error ? (
            <Failed message={groups.error} retry={groups.reload} />
          ) : !groups.data ? (
            <Loading />
          ) : (
            <GroupList groups={groups.data.data} isAdmin={isAdmin} onCreated={groups.reload} />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

export default function OrgUnitsGroupsPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <OrgStructureScreen />
    </Suspense>
  );
}
