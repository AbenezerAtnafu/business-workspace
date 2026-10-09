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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/errors';

const schema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(255, 'Use at most 255 characters') });

/** Create a sub-unit or rename a unit — the only field either needs is the name. */
export function OrgUnitNameDialog({
  open,
  title,
  description,
  submitLabel,
  initialName = '',
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  submitLabel: string;
  initialName?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: initialName } });

  useEffect(() => {
    if (open) {
      form.reset({ name: initialName });
      setFormError(null);
    }
  }, [open, initialName, form]);

  const submit = async ({ name }: z.infer<typeof schema>) => {
    setFormError(null);
    try {
      await onSubmit(name);
      onOpenChange(false);
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !form.formState.isSubmitting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate id="org-unit-name-form">
            <FormError message={formError} />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input autoFocus autoComplete="off" placeholder="e.g. Engineering" {...field} />
                  </FormControl>
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
          <Button type="submit" form="org-unit-name-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
