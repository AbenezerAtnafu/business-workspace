'use client';

// Log In — screen-flow-inventory.md §2.1 / Flows 1, 4, 12.
// POST /auth/login branches three ways (api-contract.md §1): a session, an
// MFA challenge token, or a forced-password-change token.

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Info } from 'lucide-react';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/common/form-error';
import { PasswordInput } from '@/components/common/password-input';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { LoginResponse } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { homePathFor, LOGIN_REASONS, safeNextPath } from '@/lib/auth/navigation';
import { clearPendingAuth, savePendingAuth } from '@/lib/auth/pending-auth';
import { useRedirectIfAuthenticated } from '@/lib/auth/use-redirect-if-authenticated';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type Values = z.infer<typeof schema>;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { establishSession } = useAuth();
  const { checking } = useRedirectIfAuthenticated();
  const [formError, setFormError] = useState<string | null>(null);

  const next = safeNextPath(params.get('next'));
  const reason = LOGIN_REASONS[params.get('reason') ?? ''];

  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  const onSubmit = async (values: Values) => {
    setFormError(null);
    try {
      const res = await api<LoginResponse>('/auth/login', { method: 'POST', body: values, auth: false });

      if ('mfaChallengeToken' in res) {
        savePendingAuth('mfa', res.mfaChallengeToken, values.email, next ?? undefined);
        router.push('/mfa-challenge');
        return;
      }
      if ('passwordChangeToken' in res) {
        savePendingAuth('password-change', res.passwordChangeToken, values.email, next ?? undefined);
        router.push('/force-password-change');
        return;
      }

      clearPendingAuth();
      const me = await establishSession(res.accessToken);
      router.replace(next ?? homePathFor(me));
    } catch (err) {
      setFormError(errorMessage(err));
      form.resetField('password');
    }
  };

  if (checking) return <FullPageSpinner />;

  return (
    <AuthCard
      title="Log in"
      description="Use your company email address."
      footer={
        <span>
          New organization?{' '}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </span>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {reason && !formError && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>{reason}</AlertDescription>
            </Alert>
          )}
          <FormError message={formError} />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="username" autoFocus {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <FormLabel>Password</FormLabel>
                  <Link href="/forgot-password/request" className="text-xs text-primary hover:underline">
                    Forgot password?
                  </Link>
                </div>
                <FormControl>
                  <PasswordInput autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Log in
          </Button>
        </form>
      </Form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <LoginForm />
    </Suspense>
  );
}
