'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { Domain, MailboxDetail } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { LOCAL_PART_REGEX } from '@/lib/users';

const schema = z.object({
  domainId: z.string().min(1, 'Choose a domain'),
  localPart: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.string().regex(LOCAL_PART_REGEX, 'Use letters, numbers, dots, dashes or underscores')),
});
type Values = z.input<typeof schema>;

/**
 * Claim Your Mailbox — screen-flow-inventory.md §2.2 / Flow 2's last step.
 * Two calls: POST /mailboxes {assignToSelf:true} then POST /me/primary-mailbox.
 * If the first succeeded and the second didn't (network drop, tab closed),
 * the Owner already has a self-assigned mailbox: `pending` is that mailbox
 * and the card offers to finish the claim instead of creating another (the
 * backend would refuse a second assignToSelf anyway).
 */
export function ClaimMailboxCard({
  domains,
  pending,
  suggestedLocalPart,
  onClaimed,
}: {
  /** Verified domains only. */
  domains: Domain[];
  pending: { id: string; email: string } | null;
  suggestedLocalPart: string;
  onClaimed: () => void;
}) {
  const { refreshMe, user } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const primary = domains.find((d) => d.isPrimary) ?? domains[0];

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { domainId: primary?.id ?? '', localPart: suggestedLocalPart },
  });
  const domainName = domains.find((d) => d.id === form.watch('domainId'))?.domainName ?? '';

  const claim = async (mailboxId: string, email: string) => {
    await api(`/me/primary-mailbox`, { method: 'POST', body: { mailboxId } });
    await refreshMe();
    toast.success(`You now sign in as ${email}`);
    onClaimed();
  };

  const onSubmit = async (values: Values) => {
    setFormError(null);
    const { domainId, localPart } = schema.parse(values);
    let mailbox: MailboxDetail;
    try {
      mailbox = await api<MailboxDetail>('/mailboxes', {
        method: 'POST',
        body: { domainId, localPart, assignToSelf: true },
      });
    } catch (err) {
      if (isApiError(err) && err.code === 'MAILBOX_SLOT_TAKEN') {
        form.setError('localPart', { message: 'That address is already taken — pick another.' });
        return;
      }
      setFormError(errorMessage(err));
      return;
    }
    try {
      await claim(mailbox.id, mailbox.email);
    } catch (err) {
      // The mailbox exists now; the parent reloads and shows the "finish" state.
      setFormError(`Your mailbox was created, but switching your sign-in failed: ${errorMessage(err)}`);
      onClaimed();
    }
  };

  const finish = async () => {
    if (!pending) return;
    setFinishing(true);
    setFormError(null);
    try {
      await claim(pending.id, pending.email);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setFinishing(false);
    }
  };

  const warning = (
    <Alert variant="warning">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>
        After this, you sign in with your new company address.{' '}
        <strong>{user?.email}</strong> will stop working for login. Your password stays the same.
      </AlertDescription>
    </Alert>
  );

  if (pending) {
    return (
      <div className="space-y-3" data-testid="claim-finish">
        <p className="text-sm">
          Your mailbox <strong>{pending.email}</strong> is ready — make it your sign-in address to finish.
        </p>
        {warning}
        <FormError message={formError} />
        <Button onClick={finish} disabled={finishing}>
          {finishing && <Spinner />} Use {pending.email}
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormError message={formError} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <FormField
            control={form.control}
            name="localPart"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>Your address</FormLabel>
                <FormControl>
                  <Input autoCapitalize="none" spellCheck={false} placeholder="jane" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="domainId"
            render={({ field }) => (
              <FormItem className="sm:w-56">
                <FormLabel>Domain</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger aria-label="Domain">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        @{d.domainName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        {domainName && form.watch('localPart') && (
          <p className="text-sm text-muted-foreground">
            You’ll sign in as{' '}
            <strong className="text-foreground">
              {String(form.watch('localPart')).trim().toLowerCase()}@{domainName}
            </strong>
          </p>
        )}
        {warning}
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />} Claim my mailbox
        </Button>
      </form>
    </Form>
  );
}
