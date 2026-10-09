'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { Domain, MailboxDetail } from '@/lib/api/types';
import { gbToBytes } from '@/lib/mail';
import { LOCAL_PART_HINT, LOCAL_PART_REGEX } from '@/lib/users';

const schema = z.object({
  localPart: z.string().trim().min(1, 'Enter the part before the @').regex(LOCAL_PART_REGEX, LOCAL_PART_HINT),
  domainId: z.string().min(1, 'Choose a domain'),
  // 1 MiB–1 TiB on the server; the UI works in GB.
  quotaGb: z.coerce.number({ invalid_type_error: 'Enter a number' }).min(0.5, 'At least 0.5 GB').max(1024, 'At most 1024 GB'),
});
type Values = z.input<typeof schema>;

/**
 * Create Shared Mailbox — screen-flow-inventory.md §2.6. POST /mailboxes
 * without assignToSelf → a user-less mailbox (support@, finance@). Same
 * slot-collision error as onboarding (409 MAILBOX_SLOT_TAKEN), shown inline.
 */
export function CreateMailboxDialog({
  open,
  onOpenChange,
  domains,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: Domain[];
  onCreated: (mailbox: MailboxDetail) => void;
}) {
  const verified = domains.filter((d) => d.verificationStatus === 'verified');
  const defaultDomain = (verified.find((d) => d.isPrimary) ?? verified[0])?.id ?? '';
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { localPart: '', domainId: defaultDomain, quotaGb: 5 },
  });

  useEffect(() => {
    if (open) {
      form.reset({ localPart: '', domainId: defaultDomain, quotaGb: 5 });
      setFormError(null);
    }
  }, [open, form, defaultDomain]);

  const onSubmit = async (values: Values) => {
    setFormError(null);
    const v = schema.parse(values);
    try {
      const mailbox = await api<MailboxDetail>('/mailboxes', {
        method: 'POST',
        body: { domainId: v.domainId, localPart: v.localPart, quotaBytes: gbToBytes(v.quotaGb) },
      });
      onOpenChange(false);
      onCreated(mailbox);
    } catch (err) {
      if (isApiError(err) && err.code === 'MAILBOX_SLOT_TAKEN') {
        form.setError('localPart', { message: err.message });
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !form.formState.isSubmitting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a shared mailbox</DialogTitle>
          <DialogDescription>
            A team address like support@ or finance@ that isn’t anyone’s sign-in. Give people access to it after it’s
            created.
          </DialogDescription>
        </DialogHeader>
        {verified.length === 0 ? (
          <Alert variant="warning">
            <AlertDescription>
              You need a verified domain first.{' '}
              <Link href="/admin/domains" className="underline">
                Go to Domains
              </Link>
            </AlertDescription>
          </Alert>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate id="create-mailbox-form">
              <FormError message={formError} />
              <div className="space-y-2">
                <Label className={form.formState.errors.localPart ? 'text-destructive' : undefined}>Address</Label>
                <div className="flex items-start gap-1.5">
                  <FormField
                    control={form.control}
                    name="localPart"
                    render={({ field }) => (
                      <FormItem className="flex-1 space-y-1">
                        <FormControl>
                          <Input
                            autoFocus
                            placeholder="support"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            aria-label="Address (before the @)"
                            {...field}
                            onChange={(e) => field.onChange(e.target.value.toLowerCase())}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <span className="pt-2 text-sm text-muted-foreground">@</span>
                  <FormField
                    control={form.control}
                    name="domainId"
                    render={({ field }) => (
                      <FormItem className="flex-1 space-y-1">
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger aria-label="Domain">
                              <SelectValue placeholder="Domain" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {verified.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                {d.domainName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
              <FormField
                control={form.control}
                name="quotaGb"
                render={({ field }) => (
                  <FormItem className="w-40">
                    <FormLabel>Storage (GB)</FormLabel>
                    <FormControl>
                      <Input type="number" min={0.5} step={0.5} {...field} value={field.value as number} />
                    </FormControl>
                    <FormDescription>Default is 5 GB.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
            Cancel
          </Button>
          {verified.length > 0 && (
            <Button type="submit" form="create-mailbox-form" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create mailbox
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
