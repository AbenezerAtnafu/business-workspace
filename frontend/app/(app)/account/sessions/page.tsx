'use client';

// Active Sessions — screen-flow-inventory.md §2.11.
// GET /me/sessions, DELETE /me/sessions/{id}, DELETE /me/sessions (all but
// current). The current session is marked and not individually revocable —
// Log Out is the way to end it.

import { useCallback, useEffect, useState } from 'react';
import { Laptop, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { Spinner } from '@/components/common/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { ActiveSession, ListResponse } from '@/lib/api/types';
import { describeDevice } from '@/lib/user-agent';
import { formatDateTime } from '@/lib/utils';

export default function SessionsPage() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api<ListResponse<ActiveSession>>('/me/sessions');
      // Current first, then newest.
      setSessions(
        [...res.data].sort(
          (a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt),
        ),
      );
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setRevokingId(id);
    try {
      await api(`/me/sessions/${id}`, { method: 'DELETE' });
      setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
      toast.success('Session signed out');
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        // Already gone (expired or revoked elsewhere) — same end state.
        setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setRevokingId(null);
    }
  };

  const revokeAll = async () => {
    setRevokingAll(true);
    try {
      await api('/me/sessions', { method: 'DELETE' });
      setSessions((prev) => prev?.filter((s) => s.current) ?? null);
      setConfirmAll(false);
      toast.success('Signed out of all other sessions');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRevokingAll(false);
    }
  };

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Devices currently signed in to your account. Sign out any you don’t recognise."
        actions={
          others > 0 && (
            <Button variant="outline" onClick={() => setConfirmAll(true)}>
              <LogOut /> Sign out all other sessions
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="space-y-3 p-6">
              <FormError message={loadError} />
              <Button variant="outline" size="sm" onClick={load}>
                Try again
              </Button>
            </div>
          ) : !sessions ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Device</TableHead>
                  <TableHead className="hidden sm:table-cell">IP address</TableHead>
                  <TableHead className="hidden md:table-cell">Signed in</TableHead>
                  <TableHead className="pr-6 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="pl-6">
                      <div className="flex items-center gap-3">
                        <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium" title={s.deviceInfo ?? undefined}>
                              {describeDevice(s.deviceInfo)}
                            </span>
                            {s.current && <Badge variant="success">This device</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground md:hidden">{formatDateTime(s.createdAt)}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs sm:table-cell">{s.ipAddress ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{formatDateTime(s.createdAt)}</TableCell>
                    <TableCell className="pr-6 text-right">
                      {!s.current && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => revoke(s.id)}
                          disabled={revokingId === s.id}
                        >
                          {revokingId === s.id && <Spinner />}
                          Sign out
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out all other sessions?</DialogTitle>
            <DialogDescription>
              {others} other {others === 1 ? 'session' : 'sessions'} will be signed out. You’ll stay signed in here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={revokeAll} disabled={revokingAll}>
              {revokingAll && <Spinner />}
              Sign out others
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
