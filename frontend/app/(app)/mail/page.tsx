'use client';

// Mail — screen-flow-inventory.md §2.9 (Folder view, Message Detail, Search
// Results), api-contract.md §8. State lives in the URL — ?mb=<mailbox>
// &folder=<inbox|sent|drafts|trash>&m=<message>&q=<search>&unread=1 — so a
// view can be reloaded or shared with someone who has the same access.
// The mailbox switcher appears only when the user can open more than one
// mailbox (their own + grants); read_only grantees never see Compose.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Flag, Inbox, Paperclip, PenSquare, RefreshCw, Search, X } from 'lucide-react';
import { FormError } from '@/components/common/form-error';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { MessageReader } from '@/components/mail/message-reader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import {
  MAIL_WRITE_ACCESS,
  type CursorPage,
  type MailFolderId,
  type MailFolders,
  type MailMailbox,
  type MailMessageSummary,
} from '@/lib/api/types';
import { displayName, EMPTY_FOLDER, FOLDER_LABEL, FOLDER_ORDER, formatBytes, isFolder, shortDate } from '@/lib/webmail';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;
const ACCESS_LABEL: Record<MailMailbox['access'], string> = {
  owner: 'Yours',
  manage: 'Manage',
  send_as: 'Send as',
  read_only: 'Read only',
};

function MailScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [mailboxes, setMailboxes] = useState<MailMailbox[] | null>(null);
  const [mbError, setMbError] = useState<string | null>(null);

  const mbParam = params.get('mb');
  const folderParam = params.get('folder');
  const folder: MailFolderId = isFolder(folderParam) ? folderParam : 'inbox';
  const openId = params.get('m');
  const q = params.get('q') ?? '';
  const unreadOnly = params.get('unread') === '1';

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const loadMailboxes = useCallback(async () => {
    try {
      const res = await api<{ data: MailMailbox[] }>('/mail/mailboxes');
      setMailboxes(res.data);
      setMbError(null);
    } catch (err) {
      setMbError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadMailboxes();
  }, [loadMailboxes]);

  const current = useMemo(() => {
    if (!mailboxes || mailboxes.length === 0) return null;
    return mailboxes.find((m) => m.mailboxId === mbParam) ?? mailboxes.find((m) => m.status === 'active') ?? mailboxes[0];
  }, [mailboxes, mbParam]);

  if (mbError) return <FormError message={mbError} />;
  if (!mailboxes) return <FullPageSpinner label="Loading mail…" />;
  if (!current) {
    return (
      <div className="mx-auto max-w-md space-y-2 py-16 text-center" data-testid="mail-no-mailbox">
        <Inbox className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">No mailbox yet</h1>
        <p className="text-sm text-muted-foreground">
          You don’t have a mailbox, and none has been shared with you. An Owner or Admin can give you one (or, if
          you’re the Owner, claim yours from the setup checklist).
        </p>
      </div>
    );
  }

  return (
    <MailboxView
      key={current.mailboxId}
      mailbox={current}
      mailboxes={mailboxes}
      folder={folder}
      openId={openId}
      q={q}
      unreadOnly={unreadOnly}
      setParams={setParams}
      onCountsChanged={loadMailboxes}
    />
  );
}

function MailboxView({
  mailbox,
  mailboxes,
  folder,
  openId,
  q,
  unreadOnly,
  setParams,
  onCountsChanged,
}: {
  mailbox: MailMailbox;
  mailboxes: MailMailbox[];
  folder: MailFolderId;
  openId: string | null;
  q: string;
  unreadOnly: boolean;
  setParams: (patch: Record<string, string | null>) => void;
  onCountsChanged: () => void;
}) {
  const canWrite = MAIL_WRITE_ACCESS.includes(mailbox.access);
  const suspended = mailbox.status !== 'active';
  const [folders, setFolders] = useState<MailFolders | null>(null);
  const [list, setList] = useState<MailMessageSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState(q);
  const listKey = `${mailbox.mailboxId}|${folder}|${q}|${unreadOnly}`;
  const latestKey = useRef(listKey);
  latestKey.current = listKey;

  const base = `/mailboxes/${mailbox.mailboxId}`;

  const loadFolders = useCallback(async () => {
    try {
      setFolders(await api<MailFolders>(`${base}/folders`));
    } catch {
      /* the list call below reports the error */
    }
  }, [base]);

  const loadList = useCallback(
    async (after: string | null) => {
      const key = listKey;
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (q) query.set('q', q);
      if (unreadOnly) query.set('unreadOnly', 'true');
      if (after) query.set('cursor', after);
      const page = await api<CursorPage<MailMessageSummary>>(`${base}/folders/${folder}/messages?${query}`);
      if (latestKey.current !== key) return; // filters changed meanwhile: drop stale rows
      setList((prev) => (after && prev ? [...prev, ...page.data] : page.data));
      setCursor(page.meta.hasMore ? page.meta.nextCursor : null);
    },
    [base, folder, q, unreadOnly, listKey],
  );

  const refresh = useCallback(async () => {
    if (suspended) return;
    setRefreshing(true);
    setError(null);
    try {
      await Promise.all([loadList(null), loadFolders()]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [loadFolders, loadList, suspended]);

  useEffect(() => {
    setList(null);
    setCursor(null);
    void refresh();
  }, [refresh]);

  useEffect(() => setSearch(q), [q]);

  // New mail: re-check every minute and when the tab regains focus.
  useEffect(() => {
    if (suspended) return;
    const tick = () => {
      if (document.visibilityState === 'visible') {
        void loadFolders();
        if (!openId) void loadList(null).catch(() => undefined);
      }
    };
    const id = window.setInterval(tick, 60_000);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [loadFolders, loadList, openId, suspended]);

  const afterChange = useCallback(() => {
    void loadFolders();
    void loadList(null).catch(() => undefined);
    onCountsChanged();
  }, [loadFolders, loadList, onCountsChanged]);

  const counts = useMemo(() => new Map(folders?.data.map((f) => [f.folder, f]) ?? []), [folders]);
  const quota = folders?.quota;
  const quotaPct = quota?.limitBytes ? Math.min(100, (quota.usedBytes / quota.limitBytes) * 100) : null;

  return (
    <div className="flex h-[calc(100vh-3.5rem-4rem)] min-h-[32rem] flex-col gap-3 md:flex-row" data-testid="mail-screen">
      {/* Folders */}
      <aside className={cn('flex shrink-0 flex-col gap-3 md:w-56', openId && 'hidden md:flex')}>
        {mailboxes.length > 1 && (
          <Select value={mailbox.mailboxId} onValueChange={(v) => setParams({ mb: v, m: null, q: null, folder: null, unread: null })}>
            <SelectTrigger aria-label="Mailbox" data-testid="mailbox-switcher">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {mailboxes.map((m) => (
                <SelectItem key={m.mailboxId} value={m.mailboxId}>
                  <span className="truncate">{m.address}</span>
                  {m.unread ? <span className="ml-2 text-xs text-muted-foreground">{m.unread}</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {mailboxes.length === 1 && <div className="truncate px-1 text-sm font-medium" title={mailbox.address}>{mailbox.address}</div>}
        {(mailbox.isShared || mailbox.access !== 'owner') && (
          <div className="flex gap-1 px-1">
            {mailbox.isShared && <Badge variant="secondary">Shared</Badge>}
            <Badge variant="outline">{ACCESS_LABEL[mailbox.access]}</Badge>
          </div>
        )}

        {canWrite && !suspended && (
          <Button asChild data-testid="compose-button">
            <Link href={`/mail/compose?mb=${mailbox.mailboxId}`}>
              <PenSquare className="mr-2 h-4 w-4" /> Compose
            </Link>
          </Button>
        )}

        <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col" aria-label="Folders">
          {FOLDER_ORDER.map((f) => {
            const c = counts.get(f);
            const badge = f === 'drafts' ? c?.total : c?.unread;
            return (
              <button
                key={f}
                type="button"
                data-testid={`folder-${f}`}
                onClick={() => setParams({ folder: f === 'inbox' ? null : f, m: null })}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted',
                  folder === f && 'bg-muted font-medium',
                )}
              >
                <span>{FOLDER_LABEL[f]}</span>
                {badge ? <span className="text-xs text-muted-foreground">{badge}</span> : null}
              </button>
            );
          })}
        </nav>

        {quota && quotaPct !== null && (
          <div className="mt-auto hidden space-y-1 px-1 md:block" data-testid="mailbox-quota">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full', quotaPct > 90 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${Math.max(quotaPct, 1)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {formatBytes(quota.usedBytes)} of {formatBytes(quota.limitBytes!)} used
            </p>
          </div>
        )}
      </aside>

      {/* Message list */}
      <section
        className={cn('flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border md:max-w-md lg:max-w-lg', openId && 'hidden md:flex')}
        aria-label="Messages"
      >
        <form
          className="flex items-center gap-2 border-b p-2"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ q: search.trim() || null, m: null });
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${FOLDER_LABEL[folder]}`}
              className="h-9 pl-8"
              data-testid="mail-search"
            />
          </div>
          {q && (
            <Button type="button" variant="ghost" size="icon" title="Clear search" onClick={() => setParams({ q: null, m: null })}>
              <X className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant={unreadOnly ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setParams({ unread: unreadOnly ? null : '1', m: null })}
            data-testid="unread-filter"
          >
            Unread
          </Button>
          <Button type="button" variant="ghost" size="icon" title="Refresh" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </Button>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {suspended ? (
            <p className="p-6 text-center text-sm text-muted-foreground">This mailbox is suspended. An Owner or Admin can reactivate it.</p>
          ) : error ? (
            <div className="p-4">
              <FormError message={error} />
            </div>
          ) : list === null ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Spinner />
            </div>
          ) : list.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground" data-testid="mail-empty">
              {q ? `No messages match “${q}”.` : unreadOnly ? 'No unread messages.' : EMPTY_FOLDER[folder]}
            </p>
          ) : (
            <ul className="divide-y" data-testid="message-list">
              {list.map((m) => {
                const who = folder === 'sent' || folder === 'drafts' ? (m.to[0] ? `To: ${displayName(m.to[0])}${m.to.length > 1 ? ` +${m.to.length - 1}` : ''}` : '(no recipients)') : displayName(m.from);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => setParams({ m: m.id })}
                      data-testid="message-row"
                      className={cn(
                        'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                        openId === m.id && 'bg-muted',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {!m.read && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                        <span className={cn('min-w-0 flex-1 truncate text-sm', !m.read && 'font-semibold')}>{who}</span>
                        {m.flagged && <Flag className="h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500" aria-label="Flagged" />}
                        {m.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
                        <span className="shrink-0 text-xs text-muted-foreground">{shortDate(m.date)}</span>
                      </div>
                      <span className={cn('truncate text-sm', m.read ? 'text-muted-foreground' : 'font-medium')}>
                        {m.subject || '(no subject)'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {cursor && !error && (
            <div className="p-3 text-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    await loadList(cursor);
                  } catch (err) {
                    setError(errorMessage(err));
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                {loadingMore ? <Spinner /> : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Reader */}
      <section className={cn('min-h-0 min-w-0 flex-1 rounded-lg border', !openId && 'hidden md:block')} aria-label="Message">
        {openId ? (
          <MessageReader
            key={openId}
            mailboxId={mailbox.mailboxId}
            messageId={openId}
            canWrite={canWrite}
            onBack={() => setParams({ m: null })}
            onChanged={afterChange}
            onGone={() => setParams({ m: null })}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Select a message to read it.</div>
        )}
      </section>
    </div>
  );
}

export default function MailPage() {
  return (
    <Suspense fallback={<FullPageSpinner label="Loading mail…" />}>
      <MailScreen />
    </Suspense>
  );
}
