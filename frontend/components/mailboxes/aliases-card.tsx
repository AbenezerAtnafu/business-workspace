'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { MailboxAlias, MailboxDetail } from '@/lib/api/types';
import { LOCAL_PART_HINT, LOCAL_PART_REGEX } from '@/lib/users';

/**
 * Aliases sub-section of Mailbox Detail — screen-flow-inventory.md §2.6.
 * POST /mailboxes/{id}/aliases {localPart} (always on the mailbox's own
 * domain), DELETE /aliases/{aliasId}. Mail to an alias lands in this mailbox.
 */
export function AliasesCard({
  mailbox,
  canEdit,
  onChange,
}: {
  mailbox: MailboxDetail;
  canEdit: boolean;
  onChange: (aliases: MailboxAlias[]) => void;
}) {
  const [localPart, setLocalPart] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<MailboxAlias | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = localPart.trim().toLowerCase();
    if (!LOCAL_PART_REGEX.test(value)) {
      setError(LOCAL_PART_HINT);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const alias = await api<MailboxAlias>(`/mailboxes/${mailbox.id}/aliases`, {
        method: 'POST',
        body: { localPart: value },
      });
      onChange([...mailbox.aliases, alias]);
      setLocalPart('');
      toast.success(`${alias.email} added`);
    } catch (err) {
      setError(
        isApiError(err) && err.code === 'MAILBOX_SLOT_TAKEN'
          ? `${value}@${mailbox.domainName} is already in use.`
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Aliases</CardTitle>
        <CardDescription>Extra addresses that deliver to this mailbox.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {mailbox.aliases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No aliases.</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="alias-list">
            {mailbox.aliases.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="truncate">{a.email}</span>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Remove ${a.email}`}
                    onClick={() => setRemoving(a)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form onSubmit={add} className="space-y-2" noValidate>
            <div className="flex items-center gap-1.5">
              <Input
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
                placeholder="sales"
                aria-label="New alias (before the @)"
                autoCapitalize="none"
                spellCheck={false}
                className="flex-1"
              />
              <span className="shrink-0 text-sm text-muted-foreground">@{mailbox.domainName}</span>
              <Button type="submit" variant="outline" disabled={busy || !localPart.trim()}>
                {busy ? <Spinner /> : <Plus />} Add
              </Button>
            </div>
            <FormError message={error} />
          </form>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.email}?`}
        description="Mail sent to this address will no longer arrive. The address becomes available again."
        confirmLabel="Remove alias"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await api(`/aliases/${removing.id}`, { method: 'DELETE' });
          onChange(mailbox.aliases.filter((x) => x.id !== removing.id));
          toast.success(`${removing.email} removed`);
        }}
      />
    </Card>
  );
}
