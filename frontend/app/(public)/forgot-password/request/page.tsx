'use client';

// Forgot Password — Request. screen-flow-inventory.md §2.1 / Flow 6.
// POST /auth/password-reset/request. Always shows the same "check your email"
// confirmation whether or not the account exists — never leak existence.

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MailCheck } from 'lucide-react';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/common/form-error';
import { Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError, quotaMessage } from '@/lib/api/errors';

const schema = z.object({ email: z.string().trim().email('Enter a valid email address') });
type Values = z.infer<typeof schema>;

export default function ForgotPasswordRequestPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '' } });

  const onSubmit = async (values: Values) => {
    setFormError(null);
    try {
      await api('/auth/password-reset/request', { method: 'POST', auth: false, body: values });
      setSentTo(values.email);
    } catch (err) {
      // Only transport/rate-limit failures are worth surfacing; anything the
      // server says about the address itself must not change what we show.
      if (isApiError(err) && (err.status === 0 || err.status === 429 || err.status >= 500)) {
        setFormError(quotaMessage(err, 'reset') ?? errorMessage(err));
      } else {
        setSentTo(values.email);
      }
    }
  };

  const backToLogin = (
    <Link href="/login" className="text-primary hover:underline">
      Back to log in
    </Link>
  );

  if (sentTo) {
    return (
      <AuthCard title="Check your email" footer={backToLogin}>
        <div className="flex flex-col items-center gap-3 text-center text-sm">
          <MailCheck className="h-10 w-10 text-primary" />
          <p>
            If an account exists for <strong>{sentTo}</strong>, we’ve sent a link to reset its password. It expires in
            1 hour.
          </p>
          <p className="text-muted-foreground">
            The link goes to that mailbox itself. If you can’t open it anywhere, ask your administrator to issue you a
            temporary password instead.
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter your company email and we’ll send you a reset link."
      footer={backToLogin}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
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
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Send reset link
          </Button>
        </form>
      </Form>
    </AuthCard>
  );
}
