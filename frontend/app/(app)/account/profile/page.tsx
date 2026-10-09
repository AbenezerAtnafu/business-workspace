'use client';

// Profile — screen-flow-inventory.md §2.11. GET /me, PATCH /me (name only).
// Email is derived from the primary mailbox and is never directly editable.

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { ROLE_LABEL } from '@/components/layout/nav-config';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Spinner } from '@/components/common/spinner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Me } from '@/lib/api/types';
import { useAuth, useCurrentUser } from '@/lib/auth/auth-context';

const nameSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(200, 'Use at most 200 characters'),
});

function NameField({ name }: { name: string }) {
  const { refreshMe } = useAuth();
  const [editing, setEditing] = useState(false);
  const form = useForm<z.infer<typeof nameSchema>>({ resolver: zodResolver(nameSchema), values: { name } });

  const onSubmit = async (values: z.infer<typeof nameSchema>) => {
    try {
      await api<Me>('/me', { method: 'PATCH', body: values });
      await refreshMe();
      setEditing(false);
      toast.success('Name updated');
    } catch (err) {
      form.setError('name', { message: errorMessage(err) });
    }
  };

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{name}</span>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-start gap-2" noValidate>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="min-w-[12rem] flex-1 space-y-1">
              <FormControl>
                <Input autoComplete="name" autoFocus aria-label="Name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="sm" className="h-9" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />}
          Save
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9"
          onClick={() => {
            form.reset({ name });
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </form>
    </Form>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm sm:col-span-2">{children}</dd>
    </div>
  );
}

export default function ProfilePage() {
  const user = useCurrentUser();

  return (
    <>
      <PageHeader title="Profile" description="Your account details in this organization." />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Row label="Name">
                <NameField name={user.name} />
              </Row>
              <Row label="Email">
                <span className="break-all">{user.email}</span>
                <p className="mt-1 text-xs text-muted-foreground">
                  This is your sign-in address. It comes from your mailbox and can’t be edited here.
                </p>
              </Row>
              <Row label="Role">
                <Badge variant="outline">{ROLE_LABEL[user.role]}</Badge>
              </Row>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Protect your account with a password and two-step verification.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                {user.mfaEnabled ? (
                  <>
                    <ShieldCheck className="h-4 w-4 text-success" /> Two-step verification is on
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-4 w-4 text-warning" /> Two-step verification is off
                  </>
                )}
              </div>
              <Link href="/account/mfa" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {user.mfaEnabled ? 'Manage' : 'Turn on'}
              </Link>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm">Signed-in devices</span>
              <Link href="/account/sessions" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                Review sessions
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
