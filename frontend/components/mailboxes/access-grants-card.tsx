'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Trash2, UserRound, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { AccessGrant, Group, ListResponse, MailboxAccessLevel, MailboxDetail, User } from '@/lib/api/types';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { ACCESS_LEVEL_HINT, ACCESS_LEVEL_LABEL } from '@/lib/mail';

const LEVELS: MailboxAccessLevel[] = ['read_only', 'send_as', 'manage'];
type Target = 'user' | 'group';

/**
 * Access grants sub-section of Mailbox Detail — screen-flow-inventory.md
 * §2.6 / Flow 11. GET/POST/PATCH/DELETE /mailboxes/{id}/access[/{grantId}].
 * The User/Group toggle switches which picker shows. Owner/Admin can change
 * grants; a `manage` grantee sees the list read-only; anyone else gets 403
 * from GET and this section renders nothing at all (not an error).
 */
export function AccessGrantsCard({ mailbox, canEdit }: { mailbox: MailboxDetail; canEdit: boolean }) {
  const grants = useApiQuery<ListResponse<AccessGrant>>(`/mailboxes/${mailbox.id}/access`);
  const users = useApiQuery<ListResponse<User>>(canEdit ? '/users' : null);
  const groups = useApiQuery<ListResponse<Group>>(canEdit ? '/groups' : null);

  const [target, setTarget] = useState<Target>('user');
  const [targetId, setTargetId] = useState('');
  const [level, setLevel] = useState<MailboxAccessLevel>('read_only');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AccessGrant | null>(null);
  const [changing, setChanging] = useState<string | null>(null);

  const list = useMemo(() => grants.data?.data ?? [], [grants.data]);
  const userOptions = useMemo(() => {
    const granted = new Set(list.map((g) => g.userId).filter(Boolean));
    return (users.data?.data ?? [])
      .filter((u) => u.status !== 'deleted' && u.id !== mailbox.userId && !granted.has(u.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [users.data, list, mailbox.userId]);
  const groupOptions = useMemo(() => {
    const granted = new Set(list.map((g) => g.groupId).filter(Boolean));
    return (groups.data?.data ?? []).filter((g) => !granted.has(g.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [groups.data, list]);

  if (grants.apiError?.status === 403) return null;

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetId) {
      setError(target === 'user' ? 'Choose a person.' : 'Choose a group.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<AccessGrant>(`/mailboxes/${mailbox.id}/access`, {
        method: 'POST',
        body: { [target === 'user' ? 'userId' : 'groupId']: targetId, accessLevel: level },
      });
      grants.setData((prev) => ({ data: [...(prev?.data ?? []), created] }));
      setTargetId('');
      toast.success(`${created.targetName} can now ${ACCESS_LEVEL_LABEL[level].toLowerCase()} this mailbox`);
    } catch (err) {
      setError(
        isApiError(err) && err.code === 'ALREADY_GRANTED'
          ? 'They already have access — change their level in the list instead.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const changeLevel = async (g: AccessGrant, next: MailboxAccessLevel) => {
    if (next === g.accessLevel) return;
    setChanging(g.id);
    try {
      const updated = await api<AccessGrant>(`/mailboxes/${mailbox.id}/access/${g.id}`, {
        method: 'PATCH',
        body: { accessLevel: next },
      });
      grants.setData((prev) => ({ data: (prev?.data ?? []).map((x) => (x.id === g.id ? updated : x)) }));
      toast.success(`${g.targetName}: ${ACCESS_LEVEL_LABEL[next]}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChanging(null);
    }
  };

  const options = target === 'user' ? userOptions : groupOptions;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Who has access</CardTitle>
        <CardDescription>
          {mailbox.userId
            ? `${mailbox.userName ?? 'The owner'} always has full access. Give others access here.`
            : 'Give people or whole groups access to this shared mailbox.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {grants.error && grants.apiError?.status !== 403 && <FormError message={grants.error} />}
        {grants.loading && !grants.data ? (
          <Skeleton className="h-10 w-full" />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one else has access yet.</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="grant-list">
            {list.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm" data-grant={g.targetName}>
                {g.groupId ? (
                  <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  {g.groupId ? (
                    <Link href={`/admin/org-units-groups/groups/${g.groupId}`} className="font-medium hover:underline">
                      {g.targetName}
                    </Link>
                  ) : (
                    <Link href={`/admin/users/${g.userId}`} className="font-medium hover:underline">
                      {g.targetName}
                    </Link>
                  )}
                  {g.groupId && (
                    <Badge variant="secondary" className="ml-2">
                      Group
                    </Badge>
                  )}
                </div>
                {canEdit ? (
                  <>
                    <Select
                      value={g.accessLevel}
                      onValueChange={(v) => void changeLevel(g, v as MailboxAccessLevel)}
                      disabled={changing === g.id}
                    >
                      <SelectTrigger className="h-8 w-32" aria-label={`Access level for ${g.targetName}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LEVELS.map((l) => (
                          <SelectItem key={l} value={l}>
                            {ACCESS_LEVEL_LABEL[l]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`Revoke access for ${g.targetName}`}
                      onClick={() => setRevoking(g)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <Badge variant="outline">{ACCESS_LEVEL_LABEL[g.accessLevel]}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form onSubmit={grant} className="space-y-3 rounded-md border p-3" noValidate>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Give access to</Label>
              <Tabs
                value={target}
                onValueChange={(v) => {
                  setTarget(v as Target);
                  setTargetId('');
                  setError(null);
                }}
              >
                <TabsList className="h-8">
                  <TabsTrigger value="user" className="text-xs">
                    A person
                  </TabsTrigger>
                  <TabsTrigger value="group" className="text-xs">
                    A group
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger className="sm:flex-1" aria-label={target === 'user' ? 'Person' : 'Group'}>
                  <SelectValue placeholder={target === 'user' ? 'Choose a person…' : 'Choose a group…'} />
                </SelectTrigger>
                <SelectContent>
                  {options.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      {target === 'user' ? 'Everyone already has access.' : 'No groups left to add.'}
                    </div>
                  ) : target === 'user' ? (
                    userOptions.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name} · {u.email}
                      </SelectItem>
                    ))
                  ) : (
                    groupOptions.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name} ({g.memberCount} {g.memberCount === 1 ? 'member' : 'members'})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <Select value={level} onValueChange={(v) => setLevel(v as MailboxAccessLevel)}>
                <SelectTrigger className="sm:w-36" aria-label="Access level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {ACCESS_LEVEL_LABEL[l]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" disabled={busy}>
                {busy && <Spinner />} Grant
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{ACCESS_LEVEL_HINT[level]}</p>
            <FormError message={error} />
          </form>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke access for ${revoking?.targetName}?`}
        description={
          revoking?.groupId
            ? 'Everyone who has access only through this group loses it.'
            : 'They will no longer see this mailbox.'
        }
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          await api(`/mailboxes/${mailbox.id}/access/${revoking.id}`, { method: 'DELETE' });
          grants.setData((prev) => ({ data: (prev?.data ?? []).filter((x) => x.id !== revoking.id) }));
          toast.success(`Access revoked for ${revoking.targetName}`);
        }}
      />
    </Card>
  );
}
