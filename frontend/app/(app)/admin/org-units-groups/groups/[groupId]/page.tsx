'use client';

// Group Detail — screen-flow-inventory.md §2.4 / Flow 11. GET/PATCH/DELETE
// /groups/{id}, POST/DELETE /groups/{id}/members. Shows which mailboxes the
// group grants access to, so removing a member or deleting the group makes
// its access consequences visible before confirming.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, AtSign, Pencil, Search, Trash2, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { GroupFormDialog } from '@/components/groups/group-form-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { GroupDetail, ListResponse, MailboxAccessLevel, User } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { formatDateTime } from '@/lib/utils';

const ACCESS_LABEL: Record<MailboxAccessLevel, string> = {
  read_only: 'Read only',
  send_as: 'Send as',
  manage: 'Manage',
};

function mailboxList(group: GroupDetail) {
  return group.mailboxAccess.map((m) => m.email).join(', ');
}

export default function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const router = useRouter();
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';

  const group = useApiQuery<GroupDetail>(`/groups/${groupId}`);
  const users = useApiQuery<ListResponse<User>>(isAdmin ? '/users' : null);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);

  const g = group.data;
  const backHref = '/admin/org-units-groups?tab=groups';

  if (group.apiError?.status === 404) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className={buttonVariants({ variant: 'ghost', size: 'sm', className: '-ml-2' })}>
          <ArrowLeft /> Groups
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <UsersRound className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">Group not found</p>
            <p className="text-sm text-muted-foreground">It may have been deleted.</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (group.error) {
    return (
      <div className="space-y-3">
        <FormError message={group.error} />
        <Button variant="outline" size="sm" onClick={group.reload}>
          Try again
        </Button>
      </div>
    );
  }
  if (!g) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const hasAccess = g.mailboxAccess.length > 0;

  return (
    <div className="space-y-6">
      <Link href={backHref} className={buttonVariants({ variant: 'ghost', size: 'sm', className: '-ml-2' })}>
        <ArrowLeft /> Groups
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{g.name}</h1>
          <p className="text-sm text-muted-foreground">{g.description || 'No description'}</p>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            <Button variant="outline" onClick={() => setDeleting(true)}>
              <Trash2 /> Delete
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Members</CardTitle>
            <CardDescription>
              {g.members.length === 0
                ? 'No one is in this group yet.'
                : `${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}`}
            </CardDescription>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <UserPlus /> Add people
            </Button>
          )}
        </CardHeader>
        {g.members.length > 0 && (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Added</TableHead>
                  {isAdmin && (
                    <TableHead className="pr-6 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.members.map((m) => (
                  <TableRow key={m.userId}>
                    <TableCell className="pl-6">
                      <Link href={`/admin/users/${m.userId}`} className="font-medium hover:underline">
                        {m.name}
                      </Link>
                      <p className="break-all text-xs text-muted-foreground">{m.email}</p>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                      {formatDateTime(m.addedAt)}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="pr-6 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRemoving({ userId: m.userId, name: m.name })}
                          aria-label={`Remove ${m.name}`}
                        >
                          <UserMinus /> Remove
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mailbox access</CardTitle>
          <CardDescription>
            Everyone in this group, now and in the future, can use these mailboxes. Grants are managed on each
            mailbox’s page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasAccess ? (
            <ul className="divide-y">
              {g.mailboxAccess.map((m) => (
                <li key={m.grantId} className="flex items-center justify-between gap-3 py-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <AtSign className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {isAdmin ? (
                      <Link href={`/admin/mailboxes/${m.mailboxId}`} className="break-all hover:underline">
                        {m.email}
                      </Link>
                    ) : (
                      <span className="break-all">{m.email}</span>
                    )}
                  </span>
                  <Badge variant="secondary">{ACCESS_LABEL[m.accessLevel]}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              This group doesn’t give access to any mailbox yet.
              {isAdmin && (
                <>
                  {' '}
                  Grant it from a shared mailbox in{' '}
                  <Link href="/admin/mailboxes" className="underline underline-offset-4">
                    Mailboxes
                  </Link>
                  .
                </>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <>
          <GroupFormDialog
            open={editing}
            mode="edit"
            initial={{ name: g.name, description: g.description ?? '' }}
            onOpenChange={setEditing}
            onSubmit={async ({ name, description }) => {
              await api(`/groups/${groupId}`, { method: 'PATCH', body: { name, description } });
              await group.reload();
              toast.success('Group updated');
            }}
          />

          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete ${g.name}?`}
            description={
              <div className="space-y-2">
                <p>
                  The group is removed. Its {g.members.length} {g.members.length === 1 ? 'member keeps' : 'members keep'}{' '}
                  their accounts.
                </p>
                {hasAccess && (
                  <p className="font-medium text-foreground">
                    They lose the access this group gave them to: {mailboxList(g)}.
                  </p>
                )}
              </div>
            }
            acknowledge={hasAccess ? 'I understand members will lose this mailbox access' : undefined}
            confirmLabel="Delete group"
            destructive
            onConfirm={async () => {
              await api(`/groups/${groupId}`, { method: 'DELETE' });
              toast.success(`Deleted ${g.name}`);
              router.push(backHref);
            }}
          />

          <ConfirmDialog
            open={removing !== null}
            onOpenChange={(o) => !o && setRemoving(null)}
            title={`Remove ${removing?.name ?? ''} from ${g.name}?`}
            description={
              hasAccess
                ? `They lose the access this group gives to: ${mailboxList(g)}. Direct grants they have aren’t affected.`
                : 'Their account isn’t affected.'
            }
            confirmLabel="Remove"
            destructive={hasAccess}
            onConfirm={async () => {
              if (!removing) return;
              await api(`/groups/${groupId}/members/${removing.userId}`, { method: 'DELETE' });
              group.setData((prev) =>
                prev ? { ...prev, members: prev.members.filter((m) => m.userId !== removing.userId) } : prev!,
              );
              toast.success(`Removed ${removing.name}`);
            }}
          />

          <AddMembersDialog
            open={adding}
            onOpenChange={setAdding}
            users={users.data?.data}
            usersError={users.error}
            memberIds={new Set(g.members.map((m) => m.userId))}
            groupName={g.name}
            onAdd={async (user) => {
              await api(`/groups/${groupId}/members`, { method: 'POST', body: { userId: user.id } });
              await group.reload();
              toast.success(`Added ${user.name}`);
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Pick people to add — one click per person, the dialog stays open so a whole
 * team can be added in one go (Flow 11: "repeat per member").
 */
function AddMembersDialog({
  open,
  onOpenChange,
  users,
  usersError,
  memberIds,
  groupName,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: User[] | undefined;
  usersError: string | null;
  memberIds: Set<string>;
  groupName: string;
  onAdd: (user: User) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? [])
      .filter((u) => u.status !== 'deleted' && !memberIds.has(u.id))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [users, memberIds, query]);

  const add = async (u: User) => {
    setBusyId(u.id);
    setError(null);
    try {
      await onAdd(u);
    } catch (err) {
      // Already a member (added elsewhere meanwhile) is the outcome we wanted.
      if (!(isApiError(err) && err.code === 'ALREADY_GROUP_MEMBER')) setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setQuery('');
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add people to {groupName}</DialogTitle>
          <DialogDescription>They get the group’s mailbox access as soon as they’re added.</DialogDescription>
        </DialogHeader>
        <FormError message={error ?? usersError} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email"
            className="pl-8"
            autoFocus
            aria-label="Search people"
          />
        </div>
        <div className="max-h-80 overflow-y-auto">
          {!users ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {query ? `No one matches “${query}”.` : 'Everyone is already in this group.'}
            </p>
          ) : (
            <ul className="divide-y">
              {candidates.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{u.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId !== null}
                    onClick={() => add(u)}
                    aria-label={`Add ${u.name}`}
                  >
                    {busyId === u.id ? <Spinner /> : <UserPlus />} Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
