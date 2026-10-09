'use client';

// Force Password Change — screen-flow-inventory.md §2.1 / Flows 4, 5.
// Reached after logging in with an admin-issued temporary (or reissued)
// password. POST /auth/password-change { passwordChangeToken, newPassword }.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/common/form-error';
import { PasswordInput } from '@/components/common/password-input';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { SessionResponse } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { homePathFor } from '@/lib/auth/navigation';
import { clearPendingAuth, readPendingAuth } from '@/lib/auth/pending-auth';
import { PASSWORD_MIN, passwordPairSchema } from '@/lib/validation';

type Values = z.infer<typeof passwordPairSchema>;

export default function ForcePasswordChangePage() {
  const router = useRouter();
  const { establishSession } = useAuth();
  const [pending, setPending] = useState<ReturnType<typeof readPendingAuth> | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(passwordPairSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  useEffect(() => {
    const p = readPendingAuth('password-change');
    if (!p) router.replace('/login?reason=password-change-expired');
    setPending(p);
  }, [router]);

  const onSubmit = async ({ password }: Values) => {
    if (!pending) return;
    setFormError(null);
    try {
      const res = await api<SessionResponse>('/auth/password-change', {
        method: 'POST',
        auth: false,
        body: { passwordChangeToken: pending.token, newPassword: password },
      });
      clearPendingAuth();
      const me = await establishSession(res.accessToken);
      router.replace(pending.next ?? homePathFor(me));
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        clearPendingAuth();
        router.replace('/login?reason=password-change-expired');
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  if (!pending) return <FullPageSpinner />;

  return (
    <AuthCard
      title="Choose a new password"
      description={
        <>
          <strong>{pending.email}</strong> is using a temporary password from your administrator. Set your own to
          continue.
        </>
      }
      footer={
        <Link href="/login" onClick={clearPendingAuth} className="text-primary hover:underline">
          Back to log in
        </Link>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FormError message={formError} />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" autoFocus {...field} />
                </FormControl>
                <FormDescription>At least {PASSWORD_MIN} characters. A short phrase works well.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm new password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Set password and continue
          </Button>
        </form>
      </Form>
    </AuthCard>
  );
}
