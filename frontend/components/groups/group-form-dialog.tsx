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
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isApiError } from '@/lib/api/errors';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(255, 'Use at most 255 characters'),
  description: z.string().trim().max(2000, 'Use at most 2000 characters'),
});
export type GroupFormValues = z.infer<typeof schema>;

/** Create or edit a group (name + optional description). 409 GROUP_NAME_TAKEN lands on the name field. */
export function GroupFormDialog({
  open,
  mode,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  initial?: GroupFormValues;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: GroupFormValues) => Promise<void>;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<GroupFormValues>({
    resolver: zodResolver(schema),
    defaultValues: initial ?? { name: '', description: '' },
  });

  useEffect(() => {
    if (open) {
      form.reset(initial ?? { name: '', description: '' });
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (values: GroupFormValues) => {
    setFormError(null);
    try {
      await onSubmit(values);
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err) && err.code === 'GROUP_NAME_TAKEN') {
        form.setError('name', { message: 'A group with this name already exists' });
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !form.formState.isSubmitting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New group' : 'Edit group'}</DialogTitle>
          <DialogDescription>
            Groups are flat lists of people. Their main use is giving a whole team access to a shared mailbox at once.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate id="group-form">
            <FormError message={formError} />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input autoFocus autoComplete="off" placeholder="e.g. Support Team" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Description <span className="font-normal text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="What is this group for?" {...field} />
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
          <Button type="submit" form="group-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            {mode === 'create' ? 'Create group' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
