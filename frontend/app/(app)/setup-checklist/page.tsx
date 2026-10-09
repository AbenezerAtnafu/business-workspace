'use client';

// Setup Checklist — screen-flow-inventory.md §2.2 / Flows 1-2. GET /domains,
// GET /admin/overview, GET /mailboxes. Owner/Admin. Complete once there's
// ≥1 verified domain, ≥1 mailbox, and (for the Owner) the primary-mailbox
// claim is done. Claim Your Mailbox is embedded as step 3: it only unlocks
// once a domain is verified and disappears once claimed.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Circle, Lock, PartyPopper, Plus } from 'lucide-react';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner } from '@/components/common/spinner';
import { AddDomainDialog } from '@/components/domains/add-domain-dialog';
import { ClaimMailboxCard } from '@/components/setup/claim-mailbox-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { Domain, ListResponse, Mailbox } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { cn } from '@/lib/utils';

interface Overview {
  totalUsers: number;
  activeUsers: number;
  mailboxCount: number;
}

type StepState = 'done' | 'current' | 'locked';

export default function SetupChecklistPage() {
  const me = useCurrentUser();
  const router = useRouter();
  const isOwner = me.role === 'owner';
  const needsClaim = isOwner && me.primaryMailboxId === null;

  const domains = useApiQuery<ListResponse<Domain>>('/domains');
  const overview = useApiQuery<Overview>('/admin/overview');
  const mailboxes = useApiQuery<ListResponse<Mailbox>>(needsClaim ? '/mailboxes' : null);
  const [adding, setAdding] = useState(false);

  const loading = (domains.loading && !domains.data) || (overview.loading && !overview.data);
  if (loading) return <FullPageSpinner />;

  const allDomains = domains.data?.data ?? [];
  const verifiedDomains = allDomains.filter((d) => d.verificationStatus === 'verified');
  const firstUnverified = allDomains.find((d) => d.verificationStatus !== 'verified');
  const mailboxCount = overview.data?.mailboxCount ?? 0;
  const teamCount = overview.data?.totalUsers ?? 1;
  const pendingOwn = mailboxes.data?.data.find((m) => m.userId === me.id) ?? null;

  const hasDomain = allDomains.length > 0;
  const hasVerified = verifiedDomains.length > 0;
  const mailboxDone = isOwner ? !needsClaim : mailboxCount > 0;

  const reloadAll = () => {
    void domains.reload();
    void overview.reload();
    void mailboxes.reload();
  };

  const state = (done: boolean, unlocked: boolean): StepState => (done ? 'done' : unlocked ? 'current' : 'locked');
  const steps = [hasDomain, hasVerified, mailboxDone];
  const completed = steps.filter(Boolean).length;
  const allDone = completed === steps.length;

  const suggestedLocalPart = me.name.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, '') ?? '';

  return (
    <>
      <PageHeader
        title="Setup checklist"
        description="Get your organization ready for company email."
        actions={<Badge variant={allDone ? 'success' : 'secondary'}>{`${completed} of ${steps.length} done`}</Badge>}
      />

      {(domains.error || overview.error) && <FormError message={domains.error ?? overview.error} />}

      {allDone && (
        <Card className="mb-6 border-success/40">
          <CardContent className="flex items-center gap-3 p-4">
            <PartyPopper className="h-5 w-5 shrink-0" />
            <p className="text-sm">
              You’re all set. Your organization has a verified domain and working mailboxes.{' '}
              <Link href="/admin/overview" className="font-medium underline">
                Go to the overview
              </Link>
            </p>
          </CardContent>
        </Card>
      )}

      <ol className="space-y-4">
        <Step
          n={1}
          title="Add your domain"
          state={state(hasDomain, true)}
          summary={
            hasDomain
              ? `${allDomains.map((d) => d.domainName).join(', ')}`
              : 'The domain your company email will use, like acme.com.'
          }
        >
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add domain
          </Button>
        </Step>

        <Step
          n={2}
          title="Verify you own it"
          state={state(hasVerified, hasDomain)}
          summary={
            hasVerified
              ? `${verifiedDomains.map((d) => d.domainName).join(', ')} verified`
              : hasDomain
                ? 'Add one DNS record at your DNS provider, then click Verify now.'
                : 'Unlocks after you add a domain.'
          }
        >
          {firstUnverified && (
            <Button asChild>
              <Link href={`/admin/domains/${firstUnverified.id}`}>
                Open DNS instructions for {firstUnverified.domainName} <ArrowRight />
              </Link>
            </Button>
          )}
        </Step>

        {isOwner ? (
          <Step
            n={3}
            title="Claim your company mailbox"
            state={state(mailboxDone, hasVerified)}
            summary={
              mailboxDone
                ? `You sign in as ${me.email}`
                : hasVerified
                  ? 'Pick your own address. It becomes how you sign in.'
                  : 'Unlocks once a domain is verified.'
            }
          >
            {mailboxes.loading && !mailboxes.data ? null : (
              <ClaimMailboxCard
                domains={verifiedDomains}
                pending={pendingOwn}
                suggestedLocalPart={suggestedLocalPart}
                onClaimed={reloadAll}
              />
            )}
          </Step>
        ) : (
          <Step
            n={3}
            title="Create the first mailbox"
            state={state(mailboxDone, hasVerified)}
            summary={
              mailboxDone
                ? `${mailboxCount} mailbox${mailboxCount === 1 ? '' : 'es'}`
                : hasVerified
                  ? 'Invite a teammate or create a shared mailbox like support@.'
                  : 'Unlocks once a domain is verified.'
            }
          >
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href="/admin/users">Add users</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/mailboxes">Create a shared mailbox</Link>
              </Button>
            </div>
          </Step>
        )}

        <Step
          n={4}
          title="Bring in your team"
          optional
          state={teamCount > 1 ? 'done' : hasVerified ? 'current' : 'locked'}
          summary={
            teamCount > 1
              ? `${teamCount} people in your organization`
              : 'Invite people by email or create their accounts directly.'
          }
        >
          <Button asChild variant="outline">
            <Link href="/admin/users">Go to Users</Link>
          </Button>
        </Step>
      </ol>

      <AddDomainDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(d) => router.push(`/admin/domains/${d.id}`)}
      />
    </>
  );
}

function Step({
  n,
  title,
  state,
  summary,
  optional,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  summary: string;
  optional?: boolean;
  children?: React.ReactNode;
}) {
  const Icon = state === 'done' ? CheckCircle2 : state === 'locked' ? Lock : Circle;
  return (
    <li data-step={n} data-state={state}>
      <Card className={cn(state === 'locked' && 'opacity-60')}>
        <CardContent className="flex gap-4 p-5">
          <Icon
            className={cn(
              'mt-0.5 h-5 w-5 shrink-0',
              state === 'done' ? 'text-success' : 'text-muted-foreground',
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1">
              <p className="font-medium">
                {n}. {title}
                {optional && <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>}
              </p>
              <p className="break-words text-sm text-muted-foreground">{summary}</p>
            </div>
            {state === 'current' && children}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
