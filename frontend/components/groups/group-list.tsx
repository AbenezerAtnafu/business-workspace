'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import type { Group } from '@/lib/api/types';
import { GroupFormDialog } from './group-form-dialog';

/** Group List — screen-flow-inventory.md §2.4. GET /groups, POST /groups. */
export function GroupList({
  groups,
  isAdmin,
  onCreated,
}: {
  groups: Group[];
  isAdmin: boolean;
  onCreated: () => Promise<void> | void;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  const createDialog = (
    <GroupFormDialog
      open={creating}
      mode="create"
      onOpenChange={setCreating}
      onSubmit={async ({ name, description }) => {
        const g = await api<Group>('/groups', {
          method: 'POST',
          body: { name, ...(description ? { description } : {}) },
        });
        await onCreated();
        toast.success(`Created ${g.name}`);
        router.push(`/admin/org-units-groups/groups/${g.id}`);
      }}
    />
  );

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <UsersRound className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No groups yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a group like “Support Team”, add people to it, then give the whole group access to a shared mailbox
            such as support@.
          </p>
          {isAdmin && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New group
            </Button>
          )}
        </CardContent>
        {createDialog}
      </Card>
    );
  }

  return (
    <Card>
      {isAdmin && (
        <div className="flex justify-end border-b p-3">
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New group
          </Button>
        </div>
      )}
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Group</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="w-8 pr-4">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <TableRow
                key={g.id}
                className="cursor-pointer"
                onClick={() => router.push(`/admin/org-units-groups/groups/${g.id}`)}
              >
                <TableCell className="pl-6">
                  <Link
                    href={`/admin/org-units-groups/groups/${g.id}`}
                    className="font-medium hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {g.name}
                  </Link>
                  {g.description && <p className="line-clamp-1 text-xs text-muted-foreground">{g.description}</p>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{g.memberCount}</TableCell>
                <TableCell className="pr-4">
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {createDialog}
    </Card>
  );
}
