'use client';

// Mailbox Detail — screen-flow-inventory.md §2.6 / Flow 11.
// GET /mailboxes/{id}; PATCH {quotaBytes, status} (suspend/reactivate);
// DELETE (422 MAILBOX_IS_PRIMARY → points at User Detail); Aliases and
// Access grants sub-sections. Owner/Admin edit; a grantee sees it read-only
// (the access sub-section only for `manage` grantees — the server decides).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Ban, CirclePlay, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CopyButton } from '@/components/common/copy-button';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { AccessGrantsCard } from '@/components/mailboxes/access-grants-card';
import { AliasesCard } from '@/components/mailboxes/aliases-card';
import { MailboxKindBadge, MailboxStatusBadge } from '@/components/mailboxes/mailbox-badges';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { MailboxDetail } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { bytesToGb, formatQuota, gbToBytes } from '@/lib/mail';
import { formatDateTime } from '@/lib/utils';

export default function MailboxDetailPage() {
  const { mailboxId } = useParams<{ mailboxId: string }>();
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';
  const router = useRouter();
  const mailbox = useApiQuery<MailboxDetail>(`/mailboxes/${mailboxId}`);

  const [quotaGb, setQuotaGb] = useState('');
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [savingQuota, setSavingQuota] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const quotaBytes = mailbox.data?.quotaBytes;
  useEffect(() => {
    if (quotaBytes !== undefined) setQuotaGb(String(bytesToGb(quotaBytes)));
  }, [quotaBytes]);

  if (mailbox.loading && !mailbox.data) return <FullPageSpinner />;
  if (!mailbox.data) {
    const status = mailbox.apiError?.status;
    return (
      <>
        <BackLink />
        <FormError
          message={
            status === 404
              ? 'This mailbox doesn’t exist or was deleted.'
              : status === 403
                ? 'You don’t have access to this mailbox.'
                : mailbox.error
          }
        />
      </>
    );
  }
  const m = mailbox.data;
  const suspended = m.status === 'suspended';

  const patch = async (body: { quotaBytes?: number; status?: 'active' | 'suspended' }) => {
    const updated = await api<MailboxDetail>(`/mailboxes/${m.id}`, { method: 'PATCH', body });
    mailbox.setData(updated);
    return updated;
  };

  const saveQuota = async (e: React.FormEvent) => {
    e.preventDefault();
    const gb = Number(quotaGb);
    if (!Number.isFinite(gb) || gb < 0.5 || gb > 1024) {
      setQuotaError('Enter a size between 0.5 and 1024 GB.');
      return;
    }
    setSavingQuota(true);
    setQuotaError(null);
    try {
      const updated = await patch({ quotaBytes: gbToBytes(gb) });
      toast.success(`Storage set to ${formatQuota(updated.quotaBytes)}`);
    } catch (err) {
      setQuotaError(errorMessage(err));
    } finally {
      setSavingQuota(false);
    }
  };

  const reactivate = async () => {
    setStatusBusy(true);
    try {
      await patch({ status: 'active' });
      toast.success(`${m.email} reactivated`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStatusBusy(false);
    }
  };

  const quotaDirty = quotaGb !== String(bytesToGb(m.quotaBytes));

  return (
    <>
      <BackLink />
      <PageHeader
        title={m.email}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <MailboxKindBadge mailbox={m} />
            <MailboxStatusBadge status={m.status} />
            {m.userId && (
              <span>
                Belongs to{' '}
                {isAdmin ? (
                  <Link href={`/admin/users/${m.userId}`} className="underline">
                    {m.userName}
                  </Link>
                ) : (
                  m.userName
                )}
              </span>
            )}
            <span>Created {formatDateTime(m.createdAt)}</span>
          </span>
        }
        actions={
          <>
            <CopyButton value={m.email} label="Copy address" />
            {isAdmin &&
              (suspended ? (
                <Button variant="outline" onClick={reactivate} disabled={statusBusy}>
                  {statusBusy ? <Spinner /> : <CirclePlay />} Reactivate
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setSuspending(true)}>
                  <Ban /> Suspend
                </Button>
              ))}
            {isAdmin && (
              <Button variant="outline" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            )}
          </>
        }
      />

      {suspended && (
        <Alert variant="warning" className="mb-6">
          <AlertTitle>This mailbox is suspended</AlertTitle>
          <AlertDescription>It doesn’t receive or send mail until it’s reactivated.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Storage</CardTitle>
              <CardDescription>The most mail and attachments this mailbox can hold.</CardDescription>
            </CardHeader>
            <CardContent>
              {isAdmin ? (
                <form onSubmit={saveQuota} className="space-y-2" noValidate>
                  <Label htmlFor="quota">Quota (GB)</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="quota"
                      type="number"
                      min={0.5}
                      max={1024}
                      step={0.5}
                      value={quotaGb}
                      onChange={(e) => setQuotaGb(e.target.value)}
                      className="w-32"
                    />
                    <Button type="submit" variant="outline" disabled={savingQuota || !quotaDirty}>
                      {savingQuota && <Spinner />} Save
                    </Button>
                  </div>
                  <FormError message={quotaError} />
                </form>
              ) : (
                <p className="text-sm">{formatQuota(m.quotaBytes)}</p>
              )}
            </CardContent>
          </Card>

          <AliasesCard
            mailbox={m}
            canEdit={isAdmin}
            onChange={(aliases) => mailbox.setData((prev) => ({ ...(prev ?? m), aliases }))}
          />
        </div>

        <AccessGrantsCard mailbox={m} canEdit={isAdmin} />
      </div>

      {isAdmin && (
        <>
          <ConfirmDialog
            open={suspending}
            onOpenChange={setSuspending}
            title={`Suspend ${m.email}?`}
            description="It stops receiving and sending mail. Nothing is deleted, and you can reactivate it any time."
            confirmLabel="Suspend mailbox"
            destructive
            onConfirm={async () => {
              await patch({ status: 'suspended' });
              toast.success(`${m.email} suspended`);
            }}
          />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete ${m.email}?`}
            description="The mailbox, its aliases and everyone’s access to it are removed. The address becomes available again."
            confirmLabel="Delete mailbox"
            destructive
            acknowledge="I understand this can’t be undone."
            onConfirm={async () => {
              await api(`/mailboxes/${m.id}`, { method: 'DELETE' });
              toast.success(`${m.email} deleted`);
              router.replace('/admin/mailboxes');
            }}
            describeError={(err) => {
              if (isApiError(err) && err.code === 'MAILBOX_IS_PRIMARY') {
                const userId = (err.details as { userId?: string } | undefined)?.userId ?? m.userId;
                return (
                  <Alert variant="warning">
                    <AlertTitle>This is someone’s sign-in mailbox</AlertTitle>
                    <AlertDescription>
                      A personal mailbox goes away with its user.{' '}
                      {userId && (
                        <Link href={`/admin/users/${userId}`} className="underline">
                          Open {m.userName ?? 'the user'}
                        </Link>
                      )}{' '}
                      to delete them instead.
                    </AlertDescription>
                  </Alert>
                );
              }
              return undefined;
            }}
          />
        </>
      )}
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/mailboxes"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> Mailboxes
    </Link>
  );
}
