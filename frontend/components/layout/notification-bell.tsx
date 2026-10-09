'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Check, CheckCheck, Circle } from 'lucide-react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { AppNotification, CursorPage } from '@/lib/api/types';
import { describeNotification } from '@/lib/notifications';
import { relativeTime } from '@/lib/users';
import { cn } from '@/lib/utils';

const POLL_MS = 60_000;
const PAGE = 10;

/**
 * Notifications panel — screen-flow-inventory.md §2.10 ("panel, not a full
 * page"), api-contract.md §10. The badge polls GET /notifications/unread-count
 * every minute and when the tab regains focus (no push channel exists yet).
 * Opening the panel loads a fresh first page; "Load more" follows the cursor.
 * Clicking an item marks it read and opens what it's about.
 */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [items, setItems] = useState<AppNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = useRef(0);

  const refreshCount = useCallback(async () => {
    try {
      const r = await api<{ unreadCount: number }>('/notifications/unread-count');
      setUnread(r.unreadCount);
    } catch {
      // Badge is best-effort; a failed poll just keeps the last count.
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const t = window.setInterval(() => void refreshCount(), POLL_MS);
    const onFocus = () => void refreshCount();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCount]);

  const load = useCallback(
    async (after: string | null) => {
      const id = ++call.current;
      setLoading(true);
      setError(null);
      // A fresh first page (opening, or switching All/Unread) must not show
      // the previous list's rows while it loads.
      if (!after) {
        setItems([]);
        setCursor(null);
      }
      try {
        const qs = new URLSearchParams({ limit: String(PAGE) });
        if (filter === 'unread') qs.set('unreadOnly', 'true');
        if (after) qs.set('cursor', after);
        const page = await api<CursorPage<AppNotification>>(`/notifications?${qs}`);
        if (id !== call.current) return;
        setItems((prev) => (after ? [...prev, ...page.data] : page.data));
        setCursor(page.meta.hasMore ? page.meta.nextCursor : null);
      } catch (err) {
        if (id === call.current) setError(errorMessage(err));
      } finally {
        if (id === call.current) setLoading(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    if (open) {
      void load(null);
      void refreshCount();
    }
  }, [open, load, refreshCount]);

  const setRead = async (n: AppNotification, read: boolean) => {
    const readAt = read ? new Date().toISOString() : null;
    // Optimistic: the row and the badge flip at once, and roll back on error.
    setItems((prev) =>
      filter === 'unread' && read
        ? prev.filter((x) => x.id !== n.id)
        : prev.map((x) => (x.id === n.id ? { ...x, readAt } : x)),
    );
    setUnread((u) => Math.max(0, u + (read ? -1 : 1)));
    try {
      await api(`/notifications/${n.id}`, { method: 'PATCH', body: { readAt } });
    } catch (err) {
      toast.error(errorMessage(err));
      void load(null);
      void refreshCount();
    }
  };

  const readAll = async () => {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      setUnread(0);
      setItems((prev) => (filter === 'unread' ? [] : prev.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() }))));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const openItem = (n: AppNotification) => {
    const view = describeNotification(n);
    if (!n.readAt) void setRead(n, true);
    if (view.href) {
      setOpen(false);
      router.push(view.href);
    }
  };

  const badge = unread > 9 ? '9+' : String(unread);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell />
          {unread > 0 && (
            <span
              data-testid="unread-badge"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
            >
              {badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0" aria-label="Notifications">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <p className="font-semibold">Notifications</p>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={readAll} disabled={unread === 0}>
            <CheckCheck className="h-3.5 w-3.5" /> Mark all as read
          </Button>
        </div>
        <div className="border-b px-4 py-2">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as 'all' | 'unread')}>
            <TabsList className="h-8">
              <TabsTrigger value="all" className="text-xs">
                All
              </TabsTrigger>
              <TabsTrigger value="unread" className="text-xs">
                Unread{unread ? ` (${unread})` : ''}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="max-h-[26rem] overflow-y-auto">
          {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
          {items.length === 0 && !loading && !error ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {filter === 'unread' ? 'You’re all caught up.' : 'No notifications yet.'}
            </p>
          ) : (
            <ul className="divide-y" data-testid="notification-list">
              {items.map((n) => {
                const v = describeNotification(n);
                const isUnread = !n.readAt;
                return (
                  <li key={n.id} className={cn('group flex gap-2 px-4 py-3', isUnread && 'bg-primary/5')} data-unread={isUnread}>
                    <button
                      type="button"
                      onClick={() => openItem(n)}
                      className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
                    >
                      <p className={cn('text-sm', isUnread && 'font-medium')}>{v.title}</p>
                      {v.body && <p className="mt-0.5 text-xs text-muted-foreground">{v.body}</p>}
                      <p className="mt-1 text-xs text-muted-foreground" title={new Date(n.createdAt).toLocaleString()}>
                        {relativeTime(n.createdAt)}
                      </p>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label={isUnread ? `Mark “${v.title}” as read` : `Mark “${v.title}” as unread`}
                      title={isUnread ? 'Mark as read' : 'Mark as unread'}
                      onClick={() => void setRead(n, isUnread)}
                    >
                      {isUnread ? (
                        <Circle className="h-2.5 w-2.5 fill-primary text-primary" />
                      ) : (
                        <Check className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {loading && (
            <div className="flex justify-center py-3">
              <Spinner />
            </div>
          )}
          {cursor && !loading && (
            <div className="border-t p-2">
              <Button variant="ghost" size="sm" className="w-full" onClick={() => void load(cursor)}>
                Load more
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
