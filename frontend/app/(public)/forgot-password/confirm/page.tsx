'use client';

// Forgot Password — Confirm. screen-flow-inventory.md §2.1 / Flow 6.
// Opened from the emailed link (the backend links to /reset-password?token=…,
// which redirects here). POST /auth/password-reset/confirm { token, newPassword }
// → a full session. Expired/used token (410) → explain, link back to Request.

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/common/form-error';
import { PasswordInput } from '@/components/common/password-input';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { SessionResponse } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { homePathFor } from '@/lib/auth/navigation';
import { PASSWORD_MIN, passwordPairSchema } from '@/lib/validation';

type Values = z.infer<typeof passwordPairSchema>;

function LinkProblem({ message }: { message: string }) {
  return (
    <AuthCard title="This reset link can’t be used">
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">{message}</p>
        <Link href="/forgot-password/request" className={buttonVariants({ className: 'w-full' })}>
          Request a new link
        </Link>
      </div>
    </AuthCard>
  );
}

function ConfirmForm() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const { establishSession } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const [linkDead, setLinkDead] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(passwordPairSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  if (!token) return <LinkProblem message="The link is missing its token. Open it again from the email, or request a new one." />;
  if (linkDead) return <LinkProblem message={linkDead} />;

  const onSubmit = async ({ password }: Values) => {
    setFormError(null);
    try {
      const res = await api<SessionResponse>('/auth/password-reset/confirm', {
        method: 'POST',
        auth: false,
        body: { token, newPassword: password },
      });
      const me = await establishSession(res.accessToken);
      router.replace(homePathFor(me));
    } catch (err) {
      if (isApiError(err) && err.status === 410) {
        setLinkDead('Reset links work once and expire after 1 hour. This one has expired or was already used.');
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  return (
    <AuthCard title="Set a new password">
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
                <FormDescription>At least {PASSWORD_MIN} characters.</FormDescription>
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
            Reset password
          </Button>
        </form>
      </Form>
    </AuthCard>
  );
}

export default function ForgotPasswordConfirmPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <ConfirmForm />
    </Suspense>
  );
}
