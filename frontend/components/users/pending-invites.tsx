'use client';

import { useState } from 'react';
import { MailPlus } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { FormError } from '@/components/common/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { PendingInvite } from '@/lib/api/types';
import { formatDateTime } from '@/lib/utils';
import { inviteExpiry, relativeTime } from '@/lib/users';
import { ROLE_LABEL } from '@/components/layout/nav-config';

/**
 * Pending Invites — screen-flow-inventory.md §2.3. GET /invites,
 * DELETE /invites/{id}. Invites expiring within 24h are flagged; expired
 * ones stay listed (the backend still returns them) so the admin can see
 * why someone never joined, and revoke to free the address.
 */
export function PendingInvites({
  invites,
  error,
  loading,
  orgUnitPath,
  onRevoked,
  onInvite,
  onRetry,
}: {
  invites: PendingInvite[] | undefined;
  error: string | null;
  loading: boolean;
  orgUnitPath: (id: string | null) => string;
  onRevoked: (id: string) => void;
  onInvite: () => void;
  onRetry: () => void;
}) {
  const [revoking, setRevoking] = useState<PendingInvite | null>(null);

  if (error) {
    return (
      <div className="space-y-3 p-6">
        <FormError message={error} />
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (loading && !invites) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  }
  if (!invites || invites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <MailPlus className="h-8 w-8 text-muted-foreground" />
        <p className="font-medium">No pending invites</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Invited people show up here until they accept. Accepted invites move to the Users tab.
        </p>
        <Button size="sm" onClick={onInvite}>
          Invite a user
        </Button>
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">Company email</TableHead>
            <TableHead className="hidden md:table-cell">Sent to</TableHead>
            <TableHead className="hidden sm:table-cell">Role</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="pr-6 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invites.map((inv) => {
            const exp = inviteExpiry(inv.expiresAt);
            return (
              <TableRow key={inv.id}>
                <TableCell className="pl-6">
                  <div className="font-medium break-all">
                    {inv.localPart}@{inv.domainName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Invited by {inv.invitedByName} · {orgUnitPath(inv.orgUnitId)}
                  </div>
                </TableCell>
                <TableCell className="hidden break-all md:table-cell">{inv.contactEmail}</TableCell>
                <TableCell className="hidden sm:table-cell">{ROLE_LABEL[inv.role]}</TableCell>
                <TableCell>
                  <span title={formatDateTime(inv.expiresAt)}>
                    {exp === 'expired' ? (
                      <Badge variant="destructive">Expired</Badge>
                    ) : exp === 'soon' ? (
                      <Badge variant="warning">{relativeTime(inv.expiresAt)}</Badge>
                    ) : (
                      <span className="text-sm">{relativeTime(inv.expiresAt)}</span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="pr-6 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(inv)}>
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this invite?"
        description={
          revoking && (
            <>
              The link sent to <strong>{revoking.contactEmail}</strong> stops working and{' '}
              <strong>
                {revoking.localPart}@{revoking.domainName}
              </strong>{' '}
              becomes available again.
            </>
          )
        }
        confirmLabel="Revoke invite"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await api(`/invites/${revoking.id}`, { method: 'DELETE' });
          } catch (err) {
            // Already accepted or revoked elsewhere: same end state for this list.
            if (!(isApiError(err) && err.status === 404)) throw err;
          }
          onRevoked(revoking.id);
          toast.success('Invite revoked');
        }}
      />
    </>
  );
}
