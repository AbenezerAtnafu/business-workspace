'use client';

// Overview / Dashboard — screen-flow-inventory.md §2.8, api-contract.md §12.
// GET /admin/overview (one call: user/mailbox counts, every domain's status,
// the 10 newest audit entries) plus GET /invites for the pending count.
// Owner/Admin landing page. Every tile links to the screen that manages it;
// each activity row opens that entry in the Log Viewer.

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight, AtSign, ClipboardCheck, Globe, MailPlus, Users } from 'lucide-react';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner } from '@/components/common/spinner';
import { DkimBadge, VerificationBadge } from '@/components/domains/domain-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AdminOverview, ListResponse, PendingInvite } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { describeEntry, userIdsIn } from '@/lib/audit';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { useDirectory } from '@/lib/hooks/use-directory';
import { relativeTime } from '@/lib/users';

export default function AdminOverviewPage() {
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';
  const overview = useApiQuery<AdminOverview>(isAdmin ? '/admin/overview' : null);
  const invites = useApiQuery<ListResponse<PendingInvite>>(isAdmin ? '/invites' : null);
  const dir = useDirectory();

  const activity = overview.data?.recentActivity;
  const { resolveUsers } = dir;
  useEffect(() => {
    if (activity) resolveUsers(activity.flatMap(userIdsIn));
  }, [activity, resolveUsers]);

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Overview" />
        <FormError message="The overview is for the Owner and Admins." />
      </>
    );
  }
  if (overview.loading && !overview.data) return <FullPageSpinner />;
  if (!overview.data) return <FormError message={overview.error} />;

  const o = overview.data;
  const verified = o.domains.filter((d) => d.verificationStatus === 'verified').length;
  const inactive = o.totalUsers - o.activeUsers;
  const pending = invites.data?.data.length;
  const setupIncomplete = verified === 0 || o.mailboxCount === 0 || (me.role === 'owner' && me.primaryMailboxId === null);

  return (
    <>
      <PageHeader title="Overview" description="Your organization at a glance." />

      {setupIncomplete && (
        <Card className="mb-6 border-primary/40 bg-primary/5" data-testid="setup-banner">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <ClipboardCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <p className="text-sm">
                <span className="font-medium">Setup isn’t finished.</span> Verify a domain and create mailboxes to
                start using company email.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/setup-checklist">
                Open setup checklist <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          href="/admin/users"
          icon={Users}
          label="Users"
          value={o.totalUsers}
          note={inactive > 0 ? `${o.activeUsers} active · ${inactive} suspended` : 'All active'}
        />
        <Tile
          href="/admin/users?tab=invites"
          icon={MailPlus}
          label="Pending invites"
          value={pending ?? '—'}
          note={pending ? 'Waiting to be accepted' : 'None waiting'}
        />
        <Tile href="/admin/mailboxes" icon={AtSign} label="Mailboxes" value={o.mailboxCount} note="Personal and shared" />
        <Tile
          href="/admin/domains"
          icon={Globe}
          label="Domains"
          value={o.domains.length}
          note={o.domains.length ? `${verified} verified` : 'None added yet'}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Domains</CardTitle>
            <CardDescription>Ownership and mail-signing status.</CardDescription>
          </CardHeader>
          <CardContent>
            {o.domains.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No domains yet.{' '}
                <Link href="/admin/domains" className="underline underline-offset-4">
                  Add one
                </Link>
              </p>
            ) : (
              <ul className="space-y-3" data-testid="overview-domains">
                {o.domains.map((d) => (
                  <li key={d.id} className="space-y-1.5">
                    <Link href={`/admin/domains/${d.id}`} className="text-sm font-medium hover:underline">
                      {d.domainName}
                    </Link>
                    {d.isPrimary && (
                      <Badge variant="outline" className="ml-2">
                        Primary
                      </Badge>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      <VerificationBadge status={d.verificationStatus} />
                      <DkimBadge status={d.dkimStatus} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="text-base">Recent activity</CardTitle>
              <CardDescription>The latest entries from the audit log.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/audit-logs">
                View all <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {o.recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="divide-y" data-testid="recent-activity">
                {o.recentActivity.map((e) => (
                  <li key={e.id}>
                    <Link
                      href={`/admin/audit-logs?entry=${e.id}`}
                      className="flex items-baseline justify-between gap-3 py-2 text-sm hover:underline"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{dir.userName(e.actorUserId)}</span>
                        <span className="text-muted-foreground"> · </span>
                        {describeEntry(e, { name: dir.userName, domain: dir.domainName, resource: dir.resourceName })}
                      </span>
                      <span
                        className="shrink-0 text-xs text-muted-foreground"
                        title={new Date(e.createdAt).toLocaleString()}
                      >
                        {relativeTime(e.createdAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Tile({
  href,
  icon: Icon,
  label,
  value,
  note,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  note: string;
}) {
  return (
    <Link href={href} className="group rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring" data-tile={label}>
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardContent className="space-y-2 p-5">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            {label}
            <Icon className="h-4 w-4" />
          </div>
          <p className="text-3xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{note}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
