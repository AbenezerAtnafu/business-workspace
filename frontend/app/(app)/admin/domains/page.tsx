'use client';

// Domains list — screen-flow-inventory.md §1 (Admin Console → Domains) /
// Flow 2. GET /domains; Owner/Admin can Add Domain (POST /domains), which
// lands straight on that domain's DNS instructions. Members get a read-only
// list (permission matrix: Domains is Member-read).

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Globe, Plus } from 'lucide-react';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { AddDomainDialog } from '@/components/domains/add-domain-dialog';
import { DkimBadge, VerificationBadge } from '@/components/domains/domain-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Domain, ListResponse } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { formatDateTime } from '@/lib/utils';

export default function DomainsPage() {
  const me = useCurrentUser();
  const isAdmin = me.role !== 'member';
  const router = useRouter();
  const domains = useApiQuery<ListResponse<Domain>>('/domains');
  const [adding, setAdding] = useState(false);

  const rows = [...(domains.data?.data ?? [])].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.domainName.localeCompare(b.domainName),
  );

  return (
    <>
      <PageHeader
        title="Domains"
        description={
          isAdmin
            ? 'Connect your company domains. A domain must be verified before you can create addresses on it.'
            : 'The domains your organization uses for email.'
        }
        actions={
          isAdmin && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add domain
            </Button>
          )
        }
      />

      {domains.error && <FormError message={domains.error} />}

      <Card>
        <CardContent className="p-0">
          {domains.loading && !domains.data ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <Globe className="h-8 w-8 text-muted-foreground" />
              <div className="space-y-1">
                <p className="font-medium">No domains yet</p>
                <p className="text-sm text-muted-foreground">
                  {isAdmin
                    ? 'Add the domain you want your company email on, like acme.com.'
                    : 'An admin hasn’t connected a domain yet.'}
                </p>
              </div>
              {isAdmin && (
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus /> Add domain
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Ownership</TableHead>
                  <TableHead className="hidden md:table-cell">Signing (DKIM)</TableHead>
                  <TableHead className="hidden lg:table-cell">Added</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id} className="cursor-pointer" onClick={() => router.push(`/admin/domains/${d.id}`)}>
                    <TableCell>
                      <Link
                        href={`/admin/domains/${d.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {d.domainName}
                      </Link>
                      {d.isPrimary && (
                        <Badge variant="outline" className="ml-2">
                          Primary
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <VerificationBadge status={d.verificationStatus} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <DkimBadge status={d.dkimStatus} />
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {formatDateTime(d.createdAt)}
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
        <AddDomainDialog
          open={adding}
          onOpenChange={setAdding}
          onAdded={(domain) => router.push(`/admin/domains/${domain.id}`)}
        />
      )}
    </>
  );
}
