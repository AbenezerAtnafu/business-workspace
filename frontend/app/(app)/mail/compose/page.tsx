'use client';

// Compose / Reply / Forward / Edit draft — screen-flow-inventory.md §2.9,
// api-contract.md §8.
//   /mail/compose?mb=<mailbox>                      new message
//   /mail/compose?mb=<mailbox>&reply=<messageId>    (or replyAll=, forward=)
//   /mail/compose?mb=<mailbox>&draft=<messageId>    continue a saved draft
// Attachments upload as soon as they're picked, one request per file with
// its own progress and its own inline error (413 over 100 MB or over the
// mailbox's remaining quota). Sending waits for uploads to finish. Plain-text
// bodies only in this version. Forwarding carries the text, not the
// original's attachments.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Paperclip, Send, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { FormError } from '@/components/common/form-error';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, apiUpload } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import { MAIL_WRITE_ACCESS, type MailMailbox, type MailMessageDetail, type StagedAttachment } from '@/lib/api/types';
import { formatBytes, parseRecipients, replyDraft } from '@/lib/webmail';

interface Upload {
  key: string;
  fileName: string;
  sizeBytes: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachmentId?: string;
  error?: string;
}

interface Kept {
  attachmentId: string; // index within the saved draft
  fileName: string;
  sizeBytes: number;
}

function uploadError(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === 'PAYLOAD_TOO_LARGE') return 'Too large: attachments can be at most 100 MB.';
    if (err.code === 'MAILBOX_QUOTA_EXCEEDED') return 'Not enough space left in this mailbox for this file.';
  }
  return errorMessage(err, 'Upload failed.');
}

function ComposeScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const mbParam = params.get('mb');
  const replyId = params.get('reply') ?? params.get('replyAll') ?? params.get('forward');
  const mode = params.get('reply') ? 'reply' : params.get('replyAll') ? 'replyAll' : params.get('forward') ? 'forward' : null;
  const draftParam = params.get('draft');

  const [mailboxes, setMailboxes] = useState<MailMailbox[] | null>(null);
  const [mailboxId, setMailboxId] = useState<string | null>(mbParam);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [inReplyTo, setInReplyTo] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(draftParam);
  const [kept, setKept] = useState<Kept[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'save' | 'discard' | null>(null);
  const [ready, setReady] = useState(false);
  const dirty = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const writable = useMemo(
    () => (mailboxes ?? []).filter((m) => MAIL_WRITE_ACCESS.includes(m.access) && m.status === 'active'),
    [mailboxes],
  );
  const from = writable.find((m) => m.mailboxId === mailboxId) ?? null;

  // Load mailboxes, then the message being replied to or the draft being edited.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ data: MailMailbox[] }>('/mail/mailboxes');
        if (cancelled) return;
        setMailboxes(res.data);
        const usable = res.data.filter((m) => MAIL_WRITE_ACCESS.includes(m.access) && m.status === 'active');
        const mb = usable.find((m) => m.mailboxId === mbParam) ?? usable[0];
        if (!mb) {
          setReady(true);
          return;
        }
        setMailboxId(mb.mailboxId);
        if (draftParam) {
          const d = await api<MailMessageDetail>(`/mailboxes/${mb.mailboxId}/messages/${encodeURIComponent(draftParam)}`);
          if (cancelled) return;
          setTo(d.to.map((a) => a.address).join(', '));
          setCc(d.cc.map((a) => a.address).join(', '));
          setBcc(d.bcc.map((a) => a.address).join(', '));
          setShowCcBcc(d.cc.length > 0 || d.bcc.length > 0);
          setSubject(d.subject);
          setBody(d.bodyText ?? '');
          setKept(d.attachments.filter((a) => !a.inline).map((a) => ({ attachmentId: a.attachmentId, fileName: a.fileName, sizeBytes: a.sizeBytes })));
        } else if (replyId && mode) {
          const m = await api<MailMessageDetail>(`/mailboxes/${mb.mailboxId}/messages/${encodeURIComponent(replyId)}`);
          if (cancelled) return;
          const pre = replyDraft(m, mode, mb.address);
          setTo(pre.to);
          setCc(pre.cc);
          setShowCcBcc(!!pre.cc);
          setSubject(pre.subject);
          setBody(pre.body);
          setInReplyTo(pre.inReplyTo);
        }
        setReady(true);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    dirty.current = true;
    setter(v);
  };

  function addFiles(files: FileList | null) {
    if (!files || !mailboxId) return;
    dirty.current = true;
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, fileName: file.name, sizeBytes: file.size, progress: 0, status: 'uploading' }]);
      const update = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      if (file.size > 100 * 1024 * 1024) {
        update({ status: 'error', error: 'Too large: attachments can be at most 100 MB.' });
        continue;
      }
      apiUpload<StagedAttachment>(`/mailboxes/${mailboxId}/attachments`, file, { onProgress: (p) => update({ progress: p }) })
        .then((res) => update({ status: 'done', progress: 1, attachmentId: res.attachmentId }))
        .catch((err) => update({ status: 'error', error: uploadError(err) }));
    }
    if (fileInput.current) fileInput.current.value = '';
  }

  function payload() {
    return {
      to: parseRecipients(to).addresses,
      cc: parseRecipients(cc).addresses,
      bcc: parseRecipients(bcc).addresses,
      subject: subject.trim(),
      bodyText: body,
      attachmentIds: uploads.filter((u) => u.status === 'done').map((u) => u.attachmentId!),
      ...(inReplyTo ? { inReplyTo } : {}),
    };
  }

  function validate(forSend: boolean): string | null {
    const bad = [to, cc, bcc].flatMap((v) => parseRecipients(v).invalid);
    if (bad.length) return `Not an email address: ${bad.join(', ')}`;
    const p = payload();
    if (forSend && p.to.length + p.cc.length + p.bcc.length === 0) return 'Add at least one recipient.';
    if (p.to.length + p.cc.length + p.bcc.length > 100) return 'A message can have at most 100 recipients in total.';
    if (uploads.some((u) => u.status === 'uploading')) return 'Wait for attachments to finish uploading.';
    return null;
  }

  /** Create or update the draft; returns its (new) id. */
  async function persistDraft(): Promise<string> {
    const p = payload();
    if (draftId) {
      const res = await api<{ messageId: string }>(`/mailboxes/${mailboxId}/drafts/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        body: { ...p, keepAttachmentIds: kept.map((k) => k.attachmentId) },
      });
      return res.messageId;
    }
    const res = await api<{ messageId: string }>(`/mailboxes/${mailboxId}/drafts`, { method: 'POST', body: p });
    return res.messageId;
  }

  async function onSend() {
    const problem = validate(true);
    if (problem) return setFormError(problem);
    setFormError(null);
    setBusy('send');
    try {
      if (draftId) {
        const id = await persistDraft();
        await api(`/mailboxes/${mailboxId}/drafts/${encodeURIComponent(id)}/send`, { method: 'POST' });
      } else {
        await api(`/mailboxes/${mailboxId}/messages`, { method: 'POST', body: payload() });
      }
      dirty.current = false;
      toast.success('Message sent');
      router.push(`/mail?mb=${mailboxId}`);
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(null);
    }
  }

  async function onSave() {
    const problem = validate(false);
    if (problem) return setFormError(problem);
    setFormError(null);
    setBusy('save');
    try {
      const id = await persistDraft();
      // The saved draft now holds every attachment; continue from it.
      const d = await api<MailMessageDetail>(`/mailboxes/${mailboxId}/messages/${encodeURIComponent(id)}`);
      setDraftId(id);
      setKept(d.attachments.filter((a) => !a.inline).map((a) => ({ attachmentId: a.attachmentId, fileName: a.fileName, sizeBytes: a.sizeBytes })));
      setUploads((u) => u.filter((x) => x.status === 'error'));
      dirty.current = false;
      router.replace(`/mail/compose?mb=${mailboxId}&draft=${encodeURIComponent(id)}`, { scroll: false });
      toast.success('Draft saved');
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function onDiscard() {
    setBusy('discard');
    try {
      if (draftId) await api(`/mailboxes/${mailboxId}/messages/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
      dirty.current = false;
      router.push(`/mail?mb=${mailboxId}${draftId ? '&folder=drafts' : ''}`);
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(null);
    }
  }

  if (loadError) return <FormError message={loadError} />;
  if (!ready || !mailboxes) return <FullPageSpinner label="Loading…" />;
  if (writable.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        You don’t have a mailbox you can send from. Read-only access lets you read a shared mailbox, not send from it.
      </p>
    );
  }

  const heading = draftId ? 'Edit draft' : mode === 'forward' ? 'Forward' : mode ? 'Reply' : 'New message';
  const hasAttachments = uploads.length > 0 || kept.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="compose-screen">
      <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="grid gap-1.5">
            <Label>From</Label>
            {writable.length > 1 && !draftId ? (
              <Select value={mailboxId ?? undefined} onValueChange={touch(setMailboxId)} disabled={hasAttachments}>
                <SelectTrigger data-testid="compose-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {writable.map((m) => (
                    <SelectItem key={m.mailboxId} value={m.mailboxId}>
                      {m.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm" data-testid="compose-from">{from?.address}</p>
            )}
            {hasAttachments && writable.length > 1 && !draftId && (
              <p className="text-xs text-muted-foreground">Attachments belong to this mailbox; remove them to switch.</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="to">To</Label>
              {!showCcBcc && (
                <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setShowCcBcc(true)}>
                  Cc / Bcc
                </button>
              )}
            </div>
            <Input id="to" value={to} onChange={(e) => touch(setTo)(e.target.value)} placeholder="name@example.com, …" autoFocus={!mode} />
          </div>
          {showCcBcc && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="cc">Cc</Label>
                <Input id="cc" value={cc} onChange={(e) => touch(setCc)(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="bcc">Bcc</Label>
                <Input id="bcc" value={bcc} onChange={(e) => touch(setBcc)(e.target.value)} />
                <p className="text-xs text-muted-foreground">Bcc recipients are hidden from everyone else.</p>
              </div>
            </>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" value={subject} onChange={(e) => touch(setSubject)(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="body" className="sr-only">
              Message
            </Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => touch(setBody)(e.target.value)}
              rows={14}
              className="font-sans"
              placeholder="Write your message…"
              autoFocus={!!mode}
              onFocus={(e) => mode && mode !== 'forward' && e.currentTarget.setSelectionRange(0, 0)}
            />
          </div>

          {hasAttachments && (
            <ul className="space-y-1.5" data-testid="compose-attachments">
              {kept.map((k) => (
                <li key={`kept-${k.attachmentId}`} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{k.fileName}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(k.sizeBytes)}</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="Remove" onClick={() => { dirty.current = true; setKept((x) => x.filter((y) => y !== k)); }}>
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
              {uploads.map((u) => (
                <li key={u.key} className="rounded-md border px-3 py-1.5 text-sm" data-testid="upload-row" data-status={u.status}>
                  <div className="flex items-center gap-2">
                    <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{u.fileName}</span>
                    <span className="text-xs text-muted-foreground">
                      {u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : formatBytes(u.sizeBytes)}
                    </span>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Remove" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  {u.status === 'uploading' && (
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                    </div>
                  )}
                  {u.status === 'error' && <p className="mt-1 text-xs text-destructive">{u.error}</p>}
                </li>
              ))}
            </ul>
          )}

          {mode === 'forward' && (
            <p className="text-xs text-muted-foreground">The original message’s attachments aren’t included when forwarding yet.</p>
          )}

          <FormError message={formError} />

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onSend} disabled={busy !== null} data-testid="send-button">
              {busy === 'send' ? <Spinner /> : <Send className="mr-2 h-4 w-4" />}
              Send
            </Button>
            <Button variant="outline" onClick={onSave} disabled={busy !== null} data-testid="save-draft-button">
              {busy === 'save' ? <Spinner /> : null}
              Save draft
            </Button>
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} data-testid="attach-input" />
            <Button variant="ghost" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
              <Paperclip className="mr-2 h-4 w-4" /> Attach
            </Button>
            <Button variant="ghost" className="ml-auto text-destructive" onClick={onDiscard} disabled={busy !== null}>
              <Trash2 className="mr-2 h-4 w-4" /> {draftId ? 'Delete draft' : 'Discard'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ComposePage() {
  return (
    <Suspense fallback={<FullPageSpinner label="Loading…" />}>
      <ComposeScreen />
    </Suspense>
  );
}
