'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Flag,
  Forward,
  Inbox,
  MailOpen,
  Paperclip,
  Pencil,
  Reply,
  ReplyAll,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { api, apiDownload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MailMessageDetail } from '@/lib/api/types';
import { addressList, displayName, emailSrcDoc, formatBytes, fullAddress, hasRemoteContent } from '@/lib/webmail';
import { formatDateTime } from '@/lib/utils';

/**
 * Message Detail — screen-flow-inventory.md §2.9. Opening an unread message
 * marks it read (PATCH readAt) when the caller may change the mailbox;
 * read_only grantees can read but every write would be a 403, so nothing is
 * changed for them. HTML bodies are untrusted and render only inside a
 * sandboxed iframe (lib/mail.ts → emailSrcDoc).
 */
export function MessageReader({
  mailboxId,
  messageId,
  canWrite,
  onBack,
  onChanged,
  onGone,
}: {
  mailboxId: string;
  messageId: string;
  canWrite: boolean;
  onBack: () => void;
  /** Something about the message changed (read state, flag): refresh list + counts. */
  onChanged: () => void;
  /** The message left this folder (moved/deleted): close the reader. */
  onGone: () => void;
}) {
  const [msg, setMsg] = useState<MailMessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRemote, setShowRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const base = `/mailboxes/${mailboxId}/messages/${encodeURIComponent(messageId)}`;

  useEffect(() => {
    let cancelled = false;
    setMsg(null);
    setError(null);
    setShowRemote(false);
    api<MailMessageDetail>(base)
      .then(async (m) => {
        if (cancelled) return;
        setMsg(m);
        if (!m.read && canWrite) {
          await api(base, { method: 'PATCH', body: { readAt: new Date().toISOString() } }).catch(() => undefined);
          if (!cancelled) {
            setMsg({ ...m, read: true });
            onChanged();
          }
        }
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, canWrite]);

  const remote = useMemo(() => (msg?.bodyHtml ? hasRemoteContent(msg.bodyHtml) : false), [msg?.bodyHtml]);

  async function patch(body: Record<string, unknown>, done: string, gone = false) {
    setBusy(true);
    try {
      await api(base, { method: 'PATCH', body });
      toast.success(done);
      onChanged();
      if (gone) onGone();
      else if (msg) setMsg({ ...msg, ...('flagged' in body ? { flagged: !!body.flagged } : {}), ...('readAt' in body ? { read: body.readAt !== null } : {}) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function download(attachmentId: string, fileName: string) {
    try {
      const { blob, fileName: serverName } = await apiDownload(`${base}/attachments/${attachmentId}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = serverName ?? fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast.error(errorMessage(err, 'The attachment could not be downloaded.'));
    }
  }

  if (error) {
    return (
      <div className="space-y-3 p-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="md:hidden">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        <FormError message={error} />
      </div>
    );
  }
  if (!msg) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    );
  }

  const composeHref = (mode: string) =>
    `/mail/compose?mb=${mailboxId}&${mode}=${encodeURIComponent(msg.id)}`;
  const files = msg.attachments.filter((a) => !a.inline);

  return (
    <article className="flex h-full min-h-0 flex-col" data-testid="message-reader">
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="md:hidden">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        {canWrite && msg.folder === 'drafts' && (
          <Button size="sm" asChild>
            <Link href={`/mail/compose?mb=${mailboxId}&draft=${encodeURIComponent(msg.id)}`}>
              <Pencil className="mr-1 h-4 w-4" /> Edit draft
            </Link>
          </Button>
        )}
        {canWrite && msg.folder !== 'drafts' && (
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={composeHref('reply')}>
                <Reply className="mr-1 h-4 w-4" /> Reply
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={composeHref('replyAll')}>
                <ReplyAll className="mr-1 h-4 w-4" /> Reply all
              </Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={composeHref('forward')}>
                <Forward className="mr-1 h-4 w-4" /> Forward
              </Link>
            </Button>
          </>
        )}
        {canWrite && (
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              title={msg.flagged ? 'Remove flag' : 'Flag'}
              disabled={busy}
              onClick={() => patch({ flagged: !msg.flagged }, msg.flagged ? 'Flag removed' : 'Flagged')}
            >
              <Flag className={msg.flagged ? 'h-4 w-4 fill-amber-500 text-amber-500' : 'h-4 w-4'} />
            </Button>
            {msg.folder !== 'drafts' && (
              <Button variant="ghost" size="icon" title="Mark as unread" disabled={busy} onClick={() => patch({ readAt: null }, 'Marked as unread', true)}>
                <MailOpen className="h-4 w-4" />
              </Button>
            )}
            {msg.folder === 'trash' ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => patch({ folder: 'inbox' }, 'Moved to Inbox', true)}>
                  <Inbox className="mr-1 h-4 w-4" /> Restore
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="mr-1 h-4 w-4" /> Delete forever
                </Button>
              </>
            ) : msg.folder === 'drafts' ? (
              <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="mr-1 h-4 w-4" /> Discard
              </Button>
            ) : (
              <Button variant="ghost" size="icon" title="Move to Trash" disabled={busy} onClick={() => patch({ folder: 'trash' }, 'Moved to Trash', true)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="space-y-2 px-5 pb-3 pt-4">
          <h2 className="text-lg font-semibold leading-snug" data-testid="message-subject">
            {msg.subject || '(no subject)'}
          </h2>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
            <div className="min-w-0">
              <span className="font-medium">{displayName(msg.from)}</span>
              {msg.from?.name && <span className="ml-1 text-muted-foreground">&lt;{msg.from.address}&gt;</span>}
            </div>
            {msg.date && <time className="shrink-0 text-xs text-muted-foreground">{formatDateTime(msg.date)}</time>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted-foreground">
            {msg.to.length > 0 && (
              <>
                <dt>To</dt>
                <dd className="break-words">{addressList(msg.to)}</dd>
              </>
            )}
            {msg.cc.length > 0 && (
              <>
                <dt>Cc</dt>
                <dd className="break-words">{addressList(msg.cc)}</dd>
              </>
            )}
            {msg.bcc.length > 0 && (
              <>
                <dt>Bcc</dt>
                <dd className="break-words">{addressList(msg.bcc)}</dd>
              </>
            )}
            {msg.replyTo.length > 0 && msg.replyTo[0].address !== msg.from?.address && (
              <>
                <dt>Reply-To</dt>
                <dd className="break-words">{msg.replyTo.map(fullAddress).join(', ')}</dd>
              </>
            )}
          </dl>
        </header>
        <Separator />

        {msg.bodyHtml ? (
          <div className="px-2 py-2">
            {remote && !showRemote && (
              <div className="mx-3 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                Images from the internet are hidden to protect your privacy.
                <Button variant="outline" size="sm" onClick={() => setShowRemote(true)}>
                  Show images
                </Button>
              </div>
            )}
            <iframe
              title="Message body"
              data-testid="message-body-html"
              // No allow-scripts, no allow-same-origin: the sender's HTML can't
              // run code or reach this app. Popups only so links open in a tab.
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={emailSrcDoc(msg.bodyHtml, showRemote)}
              className="h-[60vh] w-full rounded-md border-0 bg-white"
            />
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words px-5 py-4 font-sans text-sm" data-testid="message-body-text">
            {msg.bodyText || '(empty message)'}
          </pre>
        )}

        {files.length > 0 && (
          <section className="space-y-2 px-5 pb-6 pt-2">
            <h3 className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Paperclip className="h-3.5 w-3.5" /> {files.length} attachment{files.length === 1 ? '' : 's'}
            </h3>
            <ul className="flex flex-wrap gap-2">
              {files.map((a) => (
                <li key={a.attachmentId}>
                  <Button variant="outline" size="sm" onClick={() => download(a.attachmentId, a.fileName)} title={`Download ${a.fileName}`}>
                    <Download className="mr-1 h-4 w-4" />
                    <span className="max-w-[14rem] truncate">{a.fileName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={msg.folder === 'drafts' ? 'Discard this draft?' : 'Delete this message forever?'}
        description="This can’t be undone."
        confirmLabel={msg.folder === 'drafts' ? 'Discard' : 'Delete forever'}
        destructive
        onConfirm={async () => {
          await api(base, { method: 'DELETE' });
          toast.success(msg.folder === 'drafts' ? 'Draft discarded' : 'Message deleted');
          onChanged();
          onGone();
        }}
      />
    </article>
  );
}
