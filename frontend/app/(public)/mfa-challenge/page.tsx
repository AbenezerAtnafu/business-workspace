'use client';

// MFA Challenge — screen-flow-inventory.md §2.1 / Flow 12.
// POST /auth/mfa/challenge { mfaChallengeToken, code }. Token is 10-min,
// single-use; an expired one bounces back to Log In with an explanation.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/common/form-error';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { SessionResponse } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { homePathFor } from '@/lib/auth/navigation';
import { clearPendingAuth, readPendingAuth } from '@/lib/auth/pending-auth';
import { totpCodeSchema } from '@/lib/validation';

const schema = z.object({ code: totpCodeSchema });
type Values = z.infer<typeof schema>;

export default function MfaChallengePage() {
  const router = useRouter();
  const { establishSession } = useAuth();
  const [pending, setPending] = useState<ReturnType<typeof readPendingAuth> | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  useEffect(() => {
    const p = readPendingAuth('mfa');
    if (!p) router.replace('/login?reason=mfa-expired');
    setPending(p);
  }, [router]);

  const onSubmit = async ({ code }: Values) => {
    if (!pending) return;
    setFormError(null);
    try {
      const res = await api<SessionResponse>('/auth/mfa/challenge', {
        method: 'POST',
        auth: false,
        body: { mfaChallengeToken: pending.token, code },
      });
      clearPendingAuth();
      const me = await establishSession(res.accessToken);
      router.replace(pending.next ?? homePathFor(me));
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        // Challenge token expired or already used.
        clearPendingAuth();
        router.replace('/login?reason=mfa-expired');
        return;
      }
      if (isApiError(err) && err.code === 'INVALID_CODE') {
        form.setError('code', { message: err.message });
        form.setValue('code', '');
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  if (!pending) return <FullPageSpinner />;

  return (
    <AuthCard
      title="Two-step verification"
      description={
        <>
          Enter the 6-digit code from your authenticator app for <strong>{pending.email}</strong>.
        </>
      }
      footer={
        <Link href="/login" onClick={clearPendingAuth} className="text-primary hover:underline">
          Use a different account
        </Link>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FormError message={formError} />
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Verification code</FormLabel>
                <FormControl>
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    autoFocus
                    className="text-center font-mono text-lg tracking-[0.5em]"
                    {...field}
                    onChange={(e) => field.onChange(e.target.value.replace(/\D/g, ''))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Verify
          </Button>
        </form>
      </Form>
    </AuthCard>
  );
}
