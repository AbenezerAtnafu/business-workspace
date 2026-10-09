'use client';

// Domain Detail / DNS Instructions — screen-flow-inventory.md §2.2 + Flow 2.
// GET /domains/{id}, GET /domains/{id}/dns-records (live DNS lookups, so
// slow — loaded separately with its own spinner), POST /domains/{id}/verify
// ("Verify now" is manual and explicit — no silent polling), PATCH
// {isPrimary}, DELETE (422 DOMAIN_HAS_ACTIVE_MAILBOXES / _PENDING_INVITES
// route the admin to what blocks it).

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, RefreshCw, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { DnsRecords } from '@/components/domains/dns-records';
import { DkimBadge, VerificationBadge } from '@/components/domains/domain-badges';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { DnsRecord, Domain } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { formatDateTime } from '@/lib/utils';

export default function DomainDetailPage() {
  const { domainId } = useParams<{ domainId: string }>();
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';
  const router = useRouter();

  const domain = useApiQuery<Domain>(`/domains/${domainId}`);
  const dns = useApiQuery<{ records: DnsRecord[] }>(`/domains/${domainId}/dns-records`);

  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [primaryBusy, setPrimaryBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (domain.loading && !domain.data) return <FullPageSpinner />;
  if (!domain.data) {
    return (
      <>
        <BackLink />
        <FormError
          message={domain.apiError?.status === 404 ? 'This domain doesn’t exist or was removed.' : domain.error}
        />
      </>
    );
  }
  const d = domain.data;
  const verified = d.verificationStatus === 'verified';

  const verify = async () => {
    setVerifying(true);
    setVerifyNote(null);
    try {
      const updated = await api<Domain>(`/domains/${domainId}/verify`, { method: 'POST' });
      const justVerified = updated.verificationStatus === 'verified' && !verified;
      domain.setData(updated);
      if (updated.verificationStatus === 'verified') {
        setVerifyNote({
          ok: true,
          text: justVerified
            ? 'Ownership verified. Your DKIM signing key has been generated — publish the DKIM record below next.'
            : 'Ownership is verified.',
        });
      } else {
        setVerifyNote({
          ok: false,
          text: 'We couldn’t find the ownership TXT record yet. DNS changes can take a few minutes to an hour to appear — check the record and try again.',
        });
      }
      void dns.reload();
    } catch (err) {
      setVerifyNote({ ok: false, text: errorMessage(err) });
    } finally {
      setVerifying(false);
    }
  };

  const makePrimary = async () => {
    setPrimaryBusy(true);
    try {
      const updated = await api<Domain>(`/domains/${domainId}`, { method: 'PATCH', body: { isPrimary: true } });
      domain.setData(updated);
      toast.success(`${updated.domainName} is now your primary domain`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPrimaryBusy(false);
    }
  };

  return (
    <>
      <BackLink />
      <PageHeader
        title={d.domainName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <VerificationBadge status={d.verificationStatus} />
            <DkimBadge status={d.dkimStatus} />
            {d.isPrimary && <Badge variant="outline">Primary</Badge>}
            <span>
              Added {formatDateTime(d.createdAt)}
              {d.verifiedAt && ` · verified ${formatDateTime(d.verifiedAt)}`}
            </span>
          </span>
        }
        actions={
          isAdmin && (
            <>
              {verified && !d.isPrimary && (
                <Button variant="outline" onClick={makePrimary} disabled={primaryBusy}>
                  {primaryBusy ? <Spinner /> : <Star />} Set as primary
                </Button>
              )}
              <Button variant="outline" onClick={() => setRemoving(true)}>
                <Trash2 /> Remove
              </Button>
            </>
          )
        }
      />

      <div className="space-y-6">
        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{verified ? 'Ownership verified' : 'Verify ownership'}</CardTitle>
              <CardDescription>
                {verified
                  ? 'You can now create addresses on this domain. Publish the remaining records below so mail is delivered and trusted.'
                  : 'Add the ownership TXT record below at your DNS provider, then click Verify now. Records you publish are checked live each time.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {verifyNote && (
                <Alert variant={verifyNote.ok ? 'success' : 'warning'} data-testid="verify-result">
                  {verifyNote.ok && <CheckCircle2 className="h-4 w-4" />}
                  <AlertTitle>{verifyNote.ok ? 'Verified' : 'Not verified yet'}</AlertTitle>
                  <AlertDescription>{verifyNote.text}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap gap-2">
                {!verified && (
                  <Button onClick={verify} disabled={verifying}>
                    {verifying && <Spinner />} Verify now
                  </Button>
                )}
                <Button variant="outline" onClick={() => void dns.reload()} disabled={dns.loading}>
                  {dns.loading ? <Spinner /> : <RefreshCw />} Check records again
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">DNS records</h2>
            <p className="text-sm text-muted-foreground">
              Add these at the company that manages your domain’s DNS (your registrar or DNS host). Status is a live
              lookup.
            </p>
          </div>
          {dns.error && <FormError message={dns.error} />}
          {dns.loading && !dns.data ? (
            <div className="flex items-center gap-2 rounded-md border p-6 text-sm text-muted-foreground">
              <Spinner /> Looking up your DNS records…
            </div>
          ) : (
            dns.data && <DnsRecords records={dns.data.records} />
          )}
        </section>
      </div>

      {isAdmin && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${d.domainName}?`}
          description="The domain is disconnected from your organization. Any other organization could then claim it."
          confirmLabel="Remove domain"
          destructive
          onConfirm={async () => {
            await api(`/domains/${domainId}`, { method: 'DELETE' });
            toast.success(`${d.domainName} removed`);
            router.replace('/admin/domains');
          }}
          describeError={(err) => {
            if (!isApiError(err)) return undefined;
            if (err.code === 'DOMAIN_HAS_ACTIVE_MAILBOXES') {
              const ids = ((err.details as { mailboxIds?: string[] } | undefined)?.mailboxIds ?? []).slice(0, 5);
              return (
                <Alert variant="warning">
                  <AlertTitle>This domain still has mailboxes</AlertTitle>
                  <AlertDescription>
                    Delete or move these first:{' '}
                    {ids.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ', '}
                        <Link className="underline" href={`/admin/mailboxes/${id}`}>
                          mailbox {i + 1}
                        </Link>
                      </span>
                    ))}
                    . Personal mailboxes go away when you delete their user.
                  </AlertDescription>
                </Alert>
              );
            }
            if (err.code === 'DOMAIN_HAS_PENDING_INVITES') {
              return (
                <Alert variant="warning">
                  <AlertTitle>This domain has pending invites</AlertTitle>
                  <AlertDescription>
                    <Link className="underline" href="/admin/users?tab=invites">
                      Revoke them
                    </Link>{' '}
                    first, then try again.
                  </AlertDescription>
                </Alert>
              );
            }
            return undefined;
          }}
        />
      )}
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/domains"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> Domains
    </Link>
  );
}
