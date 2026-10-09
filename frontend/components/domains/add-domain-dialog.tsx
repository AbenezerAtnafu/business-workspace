'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
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
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { Domain } from '@/lib/api/types';

// Same rule as the backend's CreateDomainDto.
const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

const schema = z.object({
  domainName: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
    .pipe(z.string().regex(DOMAIN_RE, 'Enter a domain like acme.com')),
});
type Values = z.input<typeof schema>;

/**
 * Add Domain — screen-flow-inventory.md §2.2 (Flow 2). POST /domains.
 * A domain already claimed by any organization → explicit "already in use".
 * Pasting a URL ("https://www.acme.com/") is forgiven and trimmed to the domain.
 */
export function AddDomainDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (domain: Domain) => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { domainName: '' } });

  useEffect(() => {
    if (open) {
      form.reset({ domainName: '' });
      setFormError(null);
    }
  }, [open, form]);

  const onSubmit = async (values: Values) => {
    setFormError(null);
    const { domainName } = schema.parse(values);
    try {
      const domain = await api<Domain>('/domains', { method: 'POST', body: { domainName } });
      onOpenChange(false);
      onAdded(domain);
    } catch (err) {
      if (isApiError(err) && err.code === 'DOMAIN_ALREADY_CLAIMED') {
        form.setError('domainName', {
          message: 'This domain is already in use by another organization. If it’s yours, contact support.',
        });
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !form.formState.isSubmitting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>
            The domain your company email will use, e.g. <strong>acme.com</strong>. You’ll prove you own it by adding a
            DNS record next.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate id="add-domain-form">
            <FormError message={formError} />
            <FormField
              control={form.control}
              name="domainName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Domain</FormLabel>
                  <FormControl>
                    <Input
                      autoFocus
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="acme.com"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>Use a domain you control at your DNS provider.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form="add-domain-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Add domain
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
