'use client';

// Mailboxes list — screen-flow-inventory.md §2.6. GET /mailboxes. Owner/Admin
// see every mailbox; the server already narrows a Member's list to their own
// + granted ones. Personal (has userId) vs shared (userId null) are
// distinguished visually and by a filter. Create Shared Mailbox → POST
// /mailboxes, then straight to its detail page to add aliases/access.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AtSign, ChevronRight, Plus, Search } from 'lucide-react';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { CreateMailboxDialog } from '@/components/mailboxes/create-mailbox-dialog';
import { MailboxKindBadge, MailboxStatusBadge } from '@/components/mailboxes/mailbox-badges';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Domain, ListResponse, Mailbox } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { formatQuota } from '@/lib/mail';

type Filter = 'all' | 'personal' | 'shared';

export default function MailboxesPage() {
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';
  const router = useRouter();
  const mailboxes = useApiQuery<ListResponse<Mailbox>>('/mailboxes');
  const domains = useApiQuery<ListResponse<Domain>>(isAdmin ? '/domains' : null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const all = mailboxes.data?.data ?? [];
  const counts = {
    all: all.length,
    personal: all.filter((m) => m.userId).length,
    shared: all.filter((m) => !m.userId).length,
  };
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (mailboxes.data?.data ?? [])
      .filter((m) => filter === 'all' || (filter === 'personal' ? !!m.userId : !m.userId))
      .filter((m) => !q || m.email.includes(q) || (m.userName ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.email.localeCompare(b.email));
  }, [mailboxes.data, filter, query]);

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description={
          isAdmin
            ? 'Personal mailboxes are created with each user. Shared mailboxes are team addresses you give people access to.'
            : 'Mailboxes you have access to.'
        }
        actions={
          isAdmin && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> Create shared mailbox
            </Button>
          )
        }
      />

      {mailboxes.error && <FormError message={mailboxes.error} />}

      <Card>
        <CardContent className="p-0">
          <div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <TabsList>
                <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
                <TabsTrigger value="personal">Personal ({counts.personal})</TabsTrigger>
                <TabsTrigger value="shared">Shared ({counts.shared})</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search address or person"
                className="pl-8"
                aria-label="Search mailboxes"
              />
            </div>
          </div>

          {mailboxes.loading && !mailboxes.data ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <AtSign className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {all.length === 0
                  ? 'No mailboxes yet. Verify a domain, then add users or create a shared mailbox.'
                  : 'No mailboxes match.'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="hidden md:table-cell">Storage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow
                    key={m.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/admin/mailboxes/${m.id}`)}
                  >
                    <TableCell>
                      <Link
                        href={`/admin/mailboxes/${m.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {m.email}
                      </Link>
                      {m.userName && <div className="text-xs text-muted-foreground">{m.userName}</div>}
                    </TableCell>
                    <TableCell>
                      <MailboxKindBadge mailbox={m} />
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{formatQuota(m.quotaBytes)}</TableCell>
                    <TableCell>
                      <MailboxStatusBadge status={m.status} />
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <CreateMailboxDialog
          open={creating}
          onOpenChange={setCreating}
          domains={domains.data?.data ?? []}
          onCreated={(m) => router.push(`/admin/mailboxes/${m.id}`)}
        />
      )}
    </>
  );
}
