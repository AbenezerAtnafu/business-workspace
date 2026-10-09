'use client';

// Users list — screen-flow-inventory.md §2.3. GET /users.
// Owner/Admin: full roster + Invite (Path A), Create Directly (Path B) and the
// Pending Invites tab (GET /invites). Member: a read-only directory.

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, Search, UserPlus, UserRoundPlus } from 'lucide-react';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner } from '@/components/common/spinner';
import { AddUserDialog, type AddUserMode } from '@/components/users/add-user-dialog';
import { PendingInvites } from '@/components/users/pending-invites';
import { TemporaryPasswordDialog, type TemporaryCredentials } from '@/components/users/temporary-password-dialog';
import { RoleBadge, StatusBadge } from '@/components/users/user-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Domain, ListResponse, OrgUnit, PendingInvite, User } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { orgUnitOptions } from '@/lib/org-units';
import { formatDateTime } from '@/lib/utils';

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 } as const;

function UsersScreen() {
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = isAdmin && params.get('tab') === 'invites' ? 'invites' : 'users';

  const users = useApiQuery<ListResponse<User>>('/users');
  const invites = useApiQuery<ListResponse<PendingInvite>>(isAdmin ? '/invites' : null);
  const domains = useApiQuery<ListResponse<Domain>>(isAdmin ? '/domains' : null);
  const units = useApiQuery<ListResponse<OrgUnit>>('/org-units');

  const unitOptions = useMemo(() => orgUnitOptions(units.data?.data ?? []), [units.data]);
  const unitPath = (id: string | null) => {
    const opts = unitOptions;
    return (id ? opts.find((u) => u.id === id) : opts.find((u) => u.isRoot))?.path ?? '—';
  };

  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<AddUserMode | null>(null);
  const [credentials, setCredentials] = useState<TemporaryCredentials | null>(null);

  const setTab = (next: string) => {
    const sp = new URLSearchParams(params.toString());
    if (next === 'invites') sp.set('tab', 'invites');
    else sp.delete('tab');
    router.replace(`${pathname}${sp.size ? `?${sp}` : ''}`, { scroll: false });
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users.data?.data ?? [])
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
  }, [users.data, query]);

  const pendingCount = invites.data?.data.length;

  const usersTable = (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b p-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              className="pl-8"
              aria-label="Search users"
            />
          </div>
          {users.data && (
            <span className="ml-auto text-sm text-muted-foreground">
              {rows.length} of {users.data.data.length}
            </span>
          )}
        </div>
        {users.error ? (
          <div className="space-y-3 p-6">
            <FormError message={users.error} />
            <Button variant="outline" size="sm" onClick={users.reload}>
              Try again
            </Button>
          </div>
        ) : !users.data ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No one matches “{query}”.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead className="hidden md:table-cell">Org unit</TableHead>
                <TableHead>Role</TableHead>
                {isAdmin && <TableHead className="hidden sm:table-cell">Status</TableHead>}
                {isAdmin && <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>}
                <TableHead className="w-8 pr-4">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => (
                <TableRow
                  key={u.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/admin/users/${u.id}`)}
                >
                  <TableCell className="pl-6">
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {u.name}
                    </Link>
                    {u.id === me.id && (
                      <Badge variant="outline" className="ml-2">
                        You
                      </Badge>
                    )}
                    <div className="break-all text-xs text-muted-foreground">{u.email}</div>
                  </TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{unitPath(u.orgUnitId)}</TableCell>
                  <TableCell>
                    <RoleBadge role={u.role} />
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="hidden sm:table-cell">
                      <StatusBadge user={u} />
                    </TableCell>
                  )}
                  {isAdmin && (
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}
                    </TableCell>
                  )}
                  <TableCell className="pr-4">
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        title={isAdmin ? 'Users' : 'People'}
        description={
          isAdmin
            ? 'Invite people, create accounts, and manage roles and access.'
            : 'Everyone in your organization.'
        }
        actions={
          isAdmin && (
            <>
              <Button variant="outline" onClick={() => setDialog('create')}>
                <UserRoundPlus /> Create account
              </Button>
              <Button onClick={() => setDialog('invite')}>
                <UserPlus /> Invite user
              </Button>
            </>
          )
        }
      />

      {isAdmin ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="users">
              Users
              {users.data && <span className="text-xs text-muted-foreground">{users.data.data.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="invites">
              Pending invites
              {pendingCount !== undefined && pendingCount > 0 && (
                <Badge variant="secondary" className="px-1.5">
                  {pendingCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="users">{usersTable}</TabsContent>
          <TabsContent value="invites">
            <Card>
              <CardContent className="p-0">
                <PendingInvites
                  invites={invites.data?.data}
                  error={invites.error}
                  loading={invites.loading}
                  orgUnitPath={unitPath}
                  onRetry={invites.reload}
                  onInvite={() => setDialog('invite')}
                  onRevoked={(id) =>
                    invites.setData((prev) => ({ data: (prev?.data ?? []).filter((i) => i.id !== id) }))
                  }
                />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      ) : (
        usersTable
      )}

      {isAdmin && (
        <AddUserDialog
          mode={dialog ?? 'invite'}
          open={dialog !== null}
          onOpenChange={(o) => !o && setDialog(null)}
          domains={domains.data?.data ?? []}
          orgUnits={unitOptions}
          onInvited={() => {
            void invites.reload();
            setTab('invites');
          }}
          onCreated={(c) => {
            setCredentials(c);
            void users.reload();
          }}
        />
      )}
      <TemporaryPasswordDialog credentials={credentials} onDone={() => setCredentials(null)} />
    </>
  );
}

export default function UsersPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <UsersScreen />
    </Suspense>
  );
}
