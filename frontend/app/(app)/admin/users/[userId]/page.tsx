'use client';

// User Detail — screen-flow-inventory.md §2.3 / Flows 5, 7, 10.
// GET /users/{id}; PATCH /users/{id} (role, status, orgUnitId);
// POST /users/{id}/password/reissue; POST /users/{id}/transfer-ownership;
// DELETE /users/{id}. Owner/Admin get actions; anyone can view.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Crown, KeyRound, Pause, Play, Trash2, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { TemporaryPasswordDialog, type TemporaryCredentials } from '@/components/users/temporary-password-dialog';
import { RoleBadge, StatusBadge } from '@/components/users/user-badges';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, refreshAccessToken } from '@/lib/api/client';
import { errorMessage, isApiError, quotaMessage } from '@/lib/api/errors';
import type { ListResponse, OrgUnit, ReissueResult, User } from '@/lib/api/types';
import { useAuth, useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { orgUnitOptions } from '@/lib/org-units';
import { formatDateTime } from '@/lib/utils';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-3 sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm sm:col-span-2">{children}</dd>
    </div>
  );
}

/** One row of the "Account actions" card: what it does on the left, the button on the right. */
function ActionRow({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 409 SOLE_OWNER → a guided message pointing at Transfer Ownership (screen-flow-inventory.md §2.3). */
function soleOwnerMessage(err: unknown): React.ReactNode | undefined {
  if (isApiError(err) && err.code === 'SOLE_OWNER') {
    return (
      <Alert variant="warning">
        <Crown className="h-4 w-4" />
        <AlertTitle>This is the Owner’s account</AlertTitle>
        <AlertDescription>
          Every organization needs exactly one Owner. Transfer ownership to someone else first, from their user page.
        </AlertDescription>
      </Alert>
    );
  }
  return undefined;
}

type PendingAction = 'suspend' | 'delete' | 'reissue' | 'transfer' | null;

export default function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();
  const me = useCurrentUser();
  const { refreshMe } = useAuth();
  const isAdmin = me.role !== 'member';
  const isSelf = me.id === userId;

  const user = useApiQuery<User>(`/users/${userId}`);
  const units = useApiQuery<ListResponse<OrgUnit>>('/org-units');
  const unitOpts = useMemo(() => orgUnitOptions(units.data?.data ?? []), [units.data]);

  const [saving, setSaving] = useState<'role' | 'orgUnit' | 'reactivate' | null>(null);
  const [inlineError, setInlineError] = useState<React.ReactNode | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [credentials, setCredentials] = useState<TemporaryCredentials | null>(null);

  const u = user.data;

  const patch = async (field: 'role' | 'orgUnit' | 'reactivate', body: Record<string, string>, done: string) => {
    setSaving(field);
    setInlineError(null);
    try {
      const updated = await api<User>(`/users/${userId}`, { method: 'PATCH', body });
      user.setData(updated);
      toast.success(done);
    } catch (err) {
      setInlineError(soleOwnerMessage(err) ?? <FormError message={errorMessage(err)} />);
    } finally {
      setSaving(null);
    }
  };

  if (user.apiError?.status === 404 || (u && u.status === 'deleted' && !isAdmin)) {
    return (
      <div className="space-y-4">
        <Link href="/admin/users" className={buttonVariants({ variant: 'ghost', size: 'sm', className: '-ml-2' })}>
          <ArrowLeft /> Users
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <UserX className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">User not found</p>
            <p className="text-sm text-muted-foreground">They may have been removed from your organization.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (user.error) {
    return (
      <div className="space-y-3">
        <FormError message={user.error} />
        <Button variant="outline" size="sm" onClick={user.reload}>
          Try again
        </Button>
      </div>
    );
  }

  if (!u) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const deleted = u.status === 'deleted';
  const targetIsOwner = u.role === 'owner';
  // Admin actions on this account. Your own account is managed from My
  // Account (a role/suspend/delete on yourself is how admins lock themselves
  // out), and the Owner's role/status/password only change via transfer.
  const canManage = isAdmin && !isSelf && !deleted;
  const unitPath = unitOpts.find((o) => o.id === u.orgUnitId)?.path ?? '—';

  return (
    <div className="space-y-6">
      <Link href="/admin/users" className={buttonVariants({ variant: 'ghost', size: 'sm', className: '-ml-2' })}>
        <ArrowLeft /> {isAdmin ? 'Users' : 'People'}
      </Link>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {u.name}
            {isSelf && <Badge variant="outline">You</Badge>}
          </h1>
          <p className="break-all text-sm text-muted-foreground">{u.email}</p>
        </div>
        <div className="flex gap-2">
          <RoleBadge role={u.role} />
          {isAdmin && <StatusBadge user={u} />}
        </div>
      </div>

      {deleted && (
        <Alert variant="destructive">
          <Trash2 className="h-4 w-4" />
          <AlertTitle>This account was deleted</AlertTitle>
          <AlertDescription>It can’t sign in and can’t be changed.</AlertDescription>
        </Alert>
      )}
      {isSelf && (
        <Alert>
          <AlertDescription>
            This is your account. Change your name, password and security settings in{' '}
            <Link href="/account/profile" className="font-medium underline underline-offset-4">
              My account
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
      {inlineError}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Row label="Email">
              <span className="break-all">{u.email}</span>
            </Row>
            <Row label="Role">
              {canManage && !targetIsOwner ? (
                <div className="flex items-center gap-2">
                  <Select
                    value={u.role}
                    disabled={saving !== null}
                    onValueChange={(role) =>
                      role !== u.role && patch('role', { role }, `${u.name} is now ${role === 'admin' ? 'an Admin' : 'a Member'}`)
                    }
                  >
                    <SelectTrigger className="w-40" aria-label="Role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  {saving === 'role' && <Spinner />}
                </div>
              ) : (
                <div className="space-y-1">
                  <RoleBadge role={u.role} />
                  {targetIsOwner && isAdmin && !isSelf && (
                    <p className="text-xs text-muted-foreground">
                      The Owner’s role changes only through an ownership transfer.
                    </p>
                  )}
                </div>
              )}
            </Row>
            <Row label="Org unit">
              {canManage && unitOpts.length > 0 ? (
                <div className="flex items-center gap-2">
                  {/* Moves immediately, no confirmation step (Flow 10). */}
                  <Select
                    value={u.orgUnitId}
                    disabled={saving !== null}
                    onValueChange={(orgUnitId) =>
                      orgUnitId !== u.orgUnitId &&
                      patch(
                        'orgUnit',
                        { orgUnitId },
                        `Moved to ${unitOpts.find((o) => o.id === orgUnitId)?.path ?? 'new unit'}`,
                      )
                    }
                  >
                    <SelectTrigger className="w-full max-w-xs" aria-label="Org unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {unitOpts.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {saving === 'orgUnit' && <Spinner />}
                </div>
              ) : (
                unitPath
              )}
            </Row>
            {isAdmin && (
              <>
                <Row label="Joined">{formatDateTime(u.createdAt)}</Row>
                <Row label="Last sign-in">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</Row>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Account actions</CardTitle>
            <CardDescription>Every action here is recorded in the audit log.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {me.role === 'owner' && !targetIsOwner && (
              <ActionRow
                title="Transfer ownership"
                description={
                  u.status === 'active'
                    ? `Make ${u.name} the Owner. You’ll become an Admin.`
                    : 'Only an active account can become the Owner.'
                }
              >
                <Button variant="outline" onClick={() => setPending('transfer')} disabled={u.status !== 'active'}>
                  <Crown /> Transfer ownership
                </Button>
              </ActionRow>
            )}

            {!targetIsOwner && (
              <ActionRow
                title="Reissue password"
                description="Replace their password with a new temporary one and sign them out everywhere. Use it when they’re locked out or the account may be compromised."
              >
                <Button variant="outline" onClick={() => setPending('reissue')}>
                  <KeyRound /> Reissue password
                </Button>
              </ActionRow>
            )}

            {!targetIsOwner &&
              (u.status === 'suspended' ? (
                <ActionRow title="Reactivate" description="Let them sign in again.">
                  <Button
                    variant="outline"
                    disabled={saving !== null}
                    onClick={() => patch('reactivate', { status: 'active' }, `${u.name} can sign in again`)}
                  >
                    {saving === 'reactivate' ? <Spinner /> : <Play />} Reactivate
                  </Button>
                </ActionRow>
              ) : (
                <ActionRow
                  title="Suspend"
                  description="Block sign-in without deleting anything. You can reactivate later."
                >
                  <Button variant="outline" onClick={() => setPending('suspend')}>
                    <Pause /> Suspend
                  </Button>
                </ActionRow>
              ))}

            {!targetIsOwner && (
              <ActionRow
                title="Delete user"
                description="Permanently remove their access. Their mailbox is kept, so it can be reassigned."
              >
                <Button variant="destructive" onClick={() => setPending('delete')}>
                  <Trash2 /> Delete
                </Button>
              </ActionRow>
            )}

            {targetIsOwner && (
              <p className="py-4 text-sm text-muted-foreground">
                This is the Owner. Their role, status and password can’t be changed here. Only the Owner can hand
                over ownership.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={pending === 'suspend'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Suspend ${u.name}?`}
        description="They won’t be able to sign in until you reactivate them. Existing sessions stop at their next refresh, within 15 minutes."
        confirmLabel="Suspend"
        destructive
        describeError={soleOwnerMessage}
        onConfirm={async () => {
          const updated = await api<User>(`/users/${userId}`, { method: 'PATCH', body: { status: 'suspended' } });
          user.setData(updated);
          toast.success(`${u.name} is suspended`);
        }}
      />

      <ConfirmDialog
        open={pending === 'delete'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Delete ${u.name}?`}
        description={
          <>
            <strong className="break-all">{u.email}</strong> will be signed out everywhere and can’t sign in again.
            This can’t be undone.
          </>
        }
        acknowledge="I understand this can’t be undone"
        confirmLabel="Delete user"
        destructive
        describeError={soleOwnerMessage}
        onConfirm={async () => {
          await api(`/users/${userId}`, { method: 'DELETE' });
          toast.success(`${u.name} was deleted`);
          router.push('/admin/users');
        }}
      />

      <ConfirmDialog
        open={pending === 'reissue'}
        onOpenChange={(o) => !o && setPending(null)}
        title="Reissue password?"
        description={
          <>
            <strong>{u.name}</strong>’s current password stops working and they’re signed out of every device.
            You’ll get a temporary password to give them. They’ll choose their own at next sign-in.
          </>
        }
        confirmLabel="Reissue password"
        describeError={(err) => quotaMessage(err, 'reissue')}
        onConfirm={async () => {
          const res = await api<ReissueResult>(`/users/${userId}/password/reissue`, { method: 'POST', body: {} });
          setCredentials({ email: u.email, temporaryPassword: res.temporaryPassword, reason: 'reissued' });
          void user.reload();
        }}
      />

      <ConfirmDialog
        open={pending === 'transfer'}
        onOpenChange={(o) => !o && setPending(null)}
        title="Transfer ownership?"
        description={
          <div className="space-y-2">
            <p>
              <strong>{u.name}</strong> becomes the Owner of this organization, and you become an Admin.
            </p>
            <p>You can’t undo this yourself. Only the new Owner can transfer it back.</p>
          </div>
        }
        acknowledge={`I want to make ${u.name} the Owner`}
        confirmLabel="Transfer ownership"
        destructive
        onConfirm={async () => {
          await api(`/users/${userId}/transfer-ownership`, { method: 'POST', body: {} });
          // Flow 7: both accounts' roles changed. The role also lives in the
          // access token's claims, so get a fresh token (POST /auth/refresh
          // re-reads the role) before re-fetching /me — otherwise the API
          // would keep treating us as Owner until the token expired.
          await refreshAccessToken();
          await refreshMe();
          await user.reload();
          toast.success(`${u.name} is now the Owner`);
        }}
      />

      <TemporaryPasswordDialog credentials={credentials} onDone={() => setCredentials(null)} />
    </div>
  );
}
