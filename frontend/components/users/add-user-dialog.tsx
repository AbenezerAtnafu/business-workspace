'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Globe } from 'lucide-react';
import { toast } from 'sonner';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
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
import { errorMessage, isApiError, quotaMessage } from '@/lib/api/errors';
import type { CreateUserResult, Domain, InviteResult } from '@/lib/api/types';
import type { OrgUnitOption } from '@/lib/org-units';
import { LOCAL_PART_HINT, LOCAL_PART_REGEX } from '@/lib/users';
import type { TemporaryCredentials } from './temporary-password-dialog';

export type AddUserMode = 'invite' | 'create';

const base = {
  domainId: z.string().min(1, 'Choose a domain'),
  localPart: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter the part before the @')
    .max(64, 'Use at most 64 characters')
    .regex(LOCAL_PART_REGEX, LOCAL_PART_HINT),
  role: z.enum(['member', 'admin']),
  orgUnitId: z.string().min(1),
};
/** Same field set for both modes; only the mode's own extra field is validated. */
function schemaFor(mode: AddUserMode) {
  return z.object({
    ...base,
    contactEmail: mode === 'invite' ? z.string().trim().email('Enter a valid email address') : z.string(),
    name:
      mode === 'create'
        ? z.string().trim().min(1, 'Enter their name').max(200, 'Use at most 200 characters')
        : z.string(),
  });
}
type Values = z.infer<ReturnType<typeof schemaFor>>;

/**
 * Invite User (Path A, POST /users/invite) and Create User Directly (Path B,
 * POST /users) — screen-flow-inventory.md §2.3, Flows 3 & 4. One component
 * because both pick the same company address (verified domain + local part),
 * role and Org Unit; they differ only in the contact email (invite) vs. the
 * person's name (create), and in what happens on success: an invite email
 * goes out, or a one-time temporary password is handed back.
 */
export function AddUserDialog({
  mode,
  open,
  onOpenChange,
  domains,
  orgUnits,
  onInvited,
  onCreated,
}: {
  mode: AddUserMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: Domain[];
  orgUnits: OrgUnitOption[];
  onInvited: () => void;
  onCreated: (credentials: TemporaryCredentials) => void;
}) {
  const verified = useMemo(() => domains.filter((d) => d.verificationStatus === 'verified'), [domains]);
  const defaultDomain = verified.find((d) => d.isPrimary)?.id ?? verified[0]?.id ?? '';
  const rootUnit = orgUnits.find((u) => u.isRoot)?.id ?? orgUnits[0]?.id ?? '';
  const [formError, setFormError] = useState<string | null>(null);

  const defaults: Values = {
    domainId: defaultDomain,
    localPart: '',
    role: 'member',
    orgUnitId: rootUnit,
    contactEmail: '',
    name: '',
  };
  const form = useForm<Values>({
    resolver: zodResolver(schemaFor(mode)),
    defaultValues: defaults,
  });

  // Fresh form each time the dialog opens.
  useEffect(() => {
    if (open) {
      form.reset(defaults);
      setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // The dialog can open before /domains or /org-units has loaded. When the
  // defaults arrive, fill only the still-empty fields — never wipe what the
  // admin already typed (found 2026-10-07: opening it right after page
  // load left Domain and Org unit blank, failing validation).
  useEffect(() => {
    if (!open) return;
    if (defaultDomain && !form.getValues('domainId')) form.setValue('domainId', defaultDomain);
    if (rootUnit && !form.getValues('orgUnitId')) form.setValue('orgUnitId', rootUnit);
  }, [open, defaultDomain, rootUnit, form]);

  const domainName = verified.find((d) => d.id === form.watch('domainId'))?.domainName;

  const onSubmit = async (values: Values) => {
    setFormError(null);
    const common = {
      domainId: values.domainId,
      localPart: values.localPart,
      role: values.role,
      // Root is the backend's default; send it only when another unit was picked.
      ...(values.orgUnitId && values.orgUnitId !== rootUnit ? { orgUnitId: values.orgUnitId } : {}),
    };
    try {
      if (mode === 'invite') {
        await api<InviteResult>('/users/invite', {
          method: 'POST',
          body: { ...common, contactEmail: values.contactEmail },
        });
        toast.success('Invite sent', {
          description: `${values.localPart}@${domainName} — the link went to ${values.contactEmail}.`,
        });
        onOpenChange(false);
        onInvited();
      } else {
        const res = await api<CreateUserResult>('/users', { method: 'POST', body: { ...common, name: values.name } });
        onOpenChange(false);
        onCreated({ email: res.email, temporaryPassword: res.temporaryPassword, reason: 'created' });
      }
    } catch (err) {
      if (isApiError(err) && err.code === 'MAILBOX_SLOT_TAKEN') {
        form.setError('localPart', { message: err.message });
        return;
      }
      setFormError((mode === 'invite' ? quotaMessage(err, 'invite') : undefined) ?? errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !form.formState.isSubmitting && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'invite' ? 'Invite a user' : 'Create an account'}</DialogTitle>
          <DialogDescription>
            {mode === 'invite'
              ? 'They get an email with a link to set their own password. The link expires in 7 days.'
              : 'For someone without another email address. You’ll get a temporary password to give them.'}
          </DialogDescription>
        </DialogHeader>

        {verified.length === 0 ? (
          <Alert>
            <Globe className="h-4 w-4" />
            <AlertTitle>Verify a domain first</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>Every account gets a company address, so you need at least one verified domain.</p>
              <Link href="/admin/domains" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                Go to Domains
              </Link>
            </AlertDescription>
          </Alert>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate id="add-user-form">
              <FormError message={formError} />
              {mode === 'create' && (
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full name</FormLabel>
                      <FormControl>
                        <Input autoComplete="off" autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <div className="space-y-2">
                <Label className={form.formState.errors.localPart ? 'text-destructive' : undefined}>Company email</Label>
                <div className="flex items-start gap-1.5">
                  <FormField
                    control={form.control}
                    name="localPart"
                    render={({ field }) => (
                      <FormItem className="flex-1 space-y-1">
                        <FormControl>
                          <Input
                            placeholder="john"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            autoFocus={mode === 'invite'}
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
                <p className="text-[0.8rem] text-muted-foreground">
                  This becomes their sign-in address and mailbox. Only verified domains are listed.
                </p>
              </div>

              {mode === 'invite' && (
                <FormField
                  control={form.control}
                  name="contactEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Send the invite to</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="their personal or current email" {...field} />
                      </FormControl>
                      <FormDescription>Where they can receive the invite link today.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="orgUnitId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Org unit</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {orgUnits.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.path}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </form>
          </Form>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
            Cancel
          </Button>
          {verified.length > 0 && (
            <Button type="submit" form="add-user-form" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              {mode === 'invite' ? 'Send invite' : 'Create account'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
