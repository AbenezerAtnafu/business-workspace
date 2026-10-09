'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { AuditLogEntry } from '@/lib/api/types';
import { actionLabel, describeEntry, RESOURCE_LABEL, resourceHref, userIdsIn } from '@/lib/audit';
import type { useDirectory } from '@/lib/hooks/use-directory';
import { formatDateTime } from '@/lib/utils';

type Directory = ReturnType<typeof useDirectory>;

const USER_KEYS = new Set(['userId', 'toUserId', 'fromUserId', 'invitedBy']);

/**
 * One audit entry (GET /audit-logs/{id}). Opened from a row or from a
 * `?entry=<id>` link (Overview's recent activity). Metadata is shown as-is,
 * key by key — it never holds a password (enforced when the row is written).
 */
export function AuditEntryDialog({
  entryId,
  preloaded,
  directory,
  onClose,
}: {
  entryId: string | null;
  preloaded?: AuditLogEntry;
  directory: Directory;
  onClose: () => void;
}) {
  const [entry, setEntry] = useState<AuditLogEntry | null>(preloaded ?? null);
  const [error, setError] = useState<string | null>(null);
  const { resolveUsers } = directory;

  useEffect(() => {
    setError(null);
    if (!entryId) return setEntry(null);
    if (preloaded && preloaded.id === entryId) return setEntry(preloaded);
    setEntry(null);
    let live = true;
    api<AuditLogEntry>(`/audit-logs/${entryId}`)
      .then((e) => live && setEntry(e))
      .catch((err) =>
        live && setError(isApiError(err) && err.status === 404 ? 'This entry doesn’t exist.' : errorMessage(err)),
      );
    return () => {
      live = false;
    };
  }, [entryId, preloaded]);

  useEffect(() => {
    if (entry) resolveUsers([...userIdsIn(entry), ...(typeof entry.metadata.invitedBy === 'string' ? [entry.metadata.invitedBy] : [])]);
  }, [entry, resolveUsers]);

  const href = entry ? resourceHref(entry) : undefined;
  const resName = entry ? directory.resourceName(entry.resourceType, entry.resourceId) : undefined;
  const metaEntries = entry ? Object.entries(entry.metadata ?? {}) : [];

  return (
    <Dialog open={!!entryId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? actionLabel(entry.action) : 'Audit entry'}</DialogTitle>
          <DialogDescription>
            {entry ? describeEntry(entry, { name: directory.userName, domain: directory.domainName, resource: directory.resourceName }) : ' '}
          </DialogDescription>
        </DialogHeader>
        {error && <FormError message={error} />}
        {!entry && !error && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {entry && (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm" data-testid="audit-entry">
            <dt className="text-muted-foreground">When</dt>
            <dd>{formatDateTime(entry.createdAt)}</dd>
            <dt className="text-muted-foreground">Who</dt>
            <dd>
              {entry.actorUserId ? (
                <Link href={`/admin/users/${entry.actorUserId}`} className="underline underline-offset-4">
                  {directory.userName(entry.actorUserId)}
                </Link>
              ) : (
                'System'
              )}
            </dd>
            <dt className="text-muted-foreground">Action</dt>
            <dd>
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{entry.action}</code>
            </dd>
            <dt className="text-muted-foreground">Resource</dt>
            <dd className="break-all">
              {entry.resourceType ? (
                <>
                  <Badge variant="outline" className="mr-2">
                    {RESOURCE_LABEL[entry.resourceType] ?? entry.resourceType}
                  </Badge>
                  {href ? (
                    <Link href={href} className="underline underline-offset-4">
                      {resName ?? 'Open'}
                    </Link>
                  ) : (
                    resName
                  )}
                  {!resName && entry.resourceId && (
                    <span className="ml-1 text-xs text-muted-foreground">(no longer exists or renamed)</span>
                  )}
                </>
              ) : (
                '—'
              )}
            </dd>
            <dt className="text-muted-foreground">IP address</dt>
            <dd>{entry.ipAddress ?? <span className="text-muted-foreground">Not recorded</span>}</dd>
            {metaEntries.length > 0 && (
              <>
                <dt className="col-span-2 mt-2 font-medium">Details</dt>
                {metaEntries.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all font-mono text-xs leading-5">
                      {USER_KEYS.has(k) && typeof v === 'string'
                        ? `${directory.userName(v)} · ${v}`
                        : v === null
                          ? 'null'
                          : typeof v === 'object'
                            ? JSON.stringify(v)
                            : String(v)}
                    </dd>
                  </div>
                ))}
              </>
            )}
            <dt className="text-muted-foreground">Entry id</dt>
            <dd className="break-all font-mono text-xs leading-5">{entry.id}</dd>
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}
