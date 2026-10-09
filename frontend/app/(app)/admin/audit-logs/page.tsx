'use client';

// Audit Logs (Log Viewer) — screen-flow-inventory.md §2.7, api-contract.md
// §11. GET /audit-logs, GET /audit-logs/{id}. Owner/Admin only. The filter
// bar maps 1:1 to the endpoint's query params (actorUserId, action,
// resourceType, from, to) and lives in the URL, so a filtered view can be
// shared or bookmarked; `?entry=<id>` opens one entry. Cursor pagination
// via "Load more". Passwords never appear: excluded when rows are written.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FilterX, ScrollText } from 'lucide-react';
import { AuditEntryDialog } from '@/components/audit/audit-entry-dialog';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { AuditLogEntry, CursorPage } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { ACTION_GROUPS, actionLabel, describeEntry, RESOURCE_LABEL, RESOURCE_TYPES, userIdsIn } from '@/lib/audit';
import { useDirectory } from '@/lib/hooks/use-directory';
import { formatDateTime } from '@/lib/utils';

const ANY = '__any';
const PAGE_SIZE = 50;

interface Filters {
  actor: string;
  action: string;
  type: string;
  from: string; // yyyy-mm-dd, local
  to: string;
}

function filtersFrom(params: URLSearchParams): Filters {
  return {
    actor: params.get('actor') ?? '',
    action: params.get('action') ?? '',
    type: params.get('type') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
}

/** Local calendar days → the instant range the API filters on (`to` is inclusive of that whole day). */
function toQuery(f: Filters, cursor: string | null): URLSearchParams {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (f.actor) q.set('actorUserId', f.actor);
  if (f.action) q.set('action', f.action);
  if (f.type) q.set('resourceType', f.type);
  if (f.from) q.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) q.set('to', new Date(`${f.to}T23:59:59.999`).toISOString());
  if (cursor) q.set('cursor', cursor);
  return q;
}

function AuditLogsScreen() {
  const me = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => filtersFrom(params), [params]);
  const entryId = params.get('entry');
  const dir = useDirectory();

  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const call = useRef(0);

  const rangeInvalid = !!filters.from && !!filters.to && filters.from > filters.to;

  const load = useCallback(
    async (after: string | null) => {
      if (rangeInvalid) {
        setRows([]);
        setCursor(null);
        setLoading(false);
        return;
      }
      const id = ++call.current;
      setLoading(true);
      setError(null);
      // New filters → don't keep showing rows that no longer match while loading.
      if (!after) {
        setRows([]);
        setCursor(null);
      }
      try {
        const page = await api<CursorPage<AuditLogEntry>>(`/audit-logs?${toQuery(filters, after)}`);
        if (id !== call.current) return;
        setRows((prev) => (after ? [...prev, ...page.data] : page.data));
        setCursor(page.meta.hasMore ? page.meta.nextCursor : null);
      } catch (err) {
        if (id !== call.current) return;
        if (isApiError(err) && err.status === 403) setForbidden(true);
        setError(errorMessage(err));
      } finally {
        if (id === call.current) setLoading(false);
      }
    },
    [filters, rangeInvalid],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const { resolveUsers } = dir;
  useEffect(() => {
    resolveUsers(rows.flatMap(userIdsIn));
  }, [rows, resolveUsers]);

  const setParams = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    router.replace(`${pathname}${sp.size ? `?${sp}` : ''}`, { scroll: false });
  };
  const setFilter = (key: keyof Filters, value: string) => setParams({ [key]: value === ANY ? null : value || null });
  const anyFilter = Object.values(filters).some(Boolean);

  // A filtered actor who's been deleted isn't in GET /users; keep them selectable.
  const actorOptions = useMemo(() => {
    const list = dir.users.map((u) => ({ id: u.id, label: `${u.name} · ${u.email}` }));
    if (filters.actor && !list.some((u) => u.id === filters.actor)) {
      list.push({ id: filters.actor, label: dir.userName(filters.actor) });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [dir, filters.actor]);

  if (me.role === 'member' || forbidden) {
    return (
      <>
        <PageHeader title="Audit logs" />
        <FormError message="Only the Owner and Admins can view audit logs." />
      </>
    );
  }

  const ctx = { name: dir.userName, domain: dir.domainName, resource: dir.resourceName };

  return (
    <>
      <PageHeader
        title="Audit logs"
        description="Who did what in your organization, newest first. Entries can’t be edited or deleted."
      />

      <Card className="mb-4">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_1.4fr_1fr_auto_auto_auto] lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="f-actor">Who</Label>
            <Select value={filters.actor || ANY} onValueChange={(v) => setFilter('actor', v)}>
              <SelectTrigger id="f-actor" aria-label="Filter by person">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Anyone</SelectItem>
                {actorOptions.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-action">Action</Label>
            <Select value={filters.action || ANY} onValueChange={(v) => setFilter('action', v)}>
              <SelectTrigger id="f-action" aria-label="Filter by action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any action</SelectItem>
                {ACTION_GROUPS.map((g) => (
                  <SelectGroup key={g.label}>
                    <SelectLabel>{g.label}</SelectLabel>
                    {g.actions.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-type">Resource</Label>
            <Select value={filters.type || ANY} onValueChange={(v) => setFilter('type', v)}>
              <SelectTrigger id="f-type" aria-label="Filter by resource type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any resource</SelectItem>
                {RESOURCE_TYPES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-from">From</Label>
            <Input id="f-from" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-to">To</Label>
            <Input id="f-to" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} />
          </div>
          <Button
            variant="ghost"
            disabled={!anyFilter}
            onClick={() => setParams({ actor: null, action: null, type: null, from: null, to: null })}
          >
            <FilterX /> Clear
          </Button>
        </CardContent>
      </Card>

      {rangeInvalid && <FormError message="The “From” date is after the “To” date." />}
      {error && <FormError message={error} />}

      <Card>
        <CardContent className="p-0">
          {loading && rows.length === 0 ? (
            <div className="flex justify-center p-8">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <ScrollText className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {anyFilter ? 'No entries match these filters.' : 'No activity recorded yet.'}
              </p>
            </div>
          ) : (
            <Table data-testid="audit-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead className="hidden lg:table-cell">Resource</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow
                    key={e.id}
                    className="cursor-pointer"
                    data-action={e.action}
                    onClick={() => setParams({ entry: e.id })}
                  >
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDateTime(e.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">{dir.userName(e.actorUserId)}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left text-sm hover:underline"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setParams({ entry: e.id });
                        }}
                      >
                        {describeEntry(e, ctx)}
                      </button>
                      <div className="text-xs text-muted-foreground">{actionLabel(e.action)}</div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {e.resourceType && (
                        <span className="flex flex-wrap items-center gap-1.5 text-sm">
                          <Badge variant="outline">{RESOURCE_LABEL[e.resourceType] ?? e.resourceType}</Badge>
                          <span className="truncate text-muted-foreground">
                            {dir.resourceName(e.resourceType, e.resourceId) ?? ''}
                          </span>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {rows.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
              <span>
                {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
                {cursor ? ' shown' : ''}
              </span>
              {cursor && (
                <Button variant="outline" size="sm" onClick={() => void load(cursor)} disabled={loading}>
                  {loading && <Spinner />} Load more
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <AuditEntryDialog
        entryId={entryId}
        preloaded={rows.find((r) => r.id === entryId)}
        directory={dir}
        onClose={() => setParams({ entry: null })}
      />
    </>
  );
}

export default function AuditLogsPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <AuditLogsScreen />
    </Suspense>
  );
}
