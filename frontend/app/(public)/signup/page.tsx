'use client';

// Sign Up — screen-flow-inventory.md §2.1 / Flow 1. POST /organizations
// bootstraps the org, its root Org Unit and the Owner (api-contract.md §2).
// The Owner signs up with an EXTERNAL contact email: no domain exists yet,
// so there can't be a company mailbox. They switch to their company address
// later via Setup Checklist → Claim Your Mailbox.

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/common/form-error';
import { PasswordInput } from '@/components/common/password-input';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError, quotaMessage } from '@/lib/api/errors';
import type { SessionResponse } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { useRedirectIfAuthenticated } from '@/lib/auth/use-redirect-if-authenticated';
import { newPasswordSchema, PASSWORD_MIN } from '@/lib/validation';

// Limits mirror backend CreateOrganizationDto.
const schema = z
  .object({
    organizationName: z.string().trim().min(2, 'Use at least 2 characters').max(200, 'Use at most 200 characters'),
    ownerName: z.string().trim().min(1, 'Enter your name').max(200, 'Use at most 200 characters'),
    ownerContactEmail: z.string().trim().email('Enter a valid email address'),
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'Passwords don’t match', path: ['confirmPassword'] });
type Values = z.infer<typeof schema>;

function SignupForm() {
  const router = useRouter();
  const { establishSession } = useAuth();
  const { checking } = useRedirectIfAuthenticated();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { organizationName: '', ownerName: '', ownerContactEmail: '', password: '', confirmPassword: '' },
  });

  const onSubmit = async ({ confirmPassword: _confirm, ...body }: Values) => {
    setFormError(null);
    try {
      const res = await api<SessionResponse>('/organizations', { method: 'POST', auth: false, body });
      await establishSession(res.accessToken);
      // Flow 1: Sign Up → App Shell → Setup Checklist.
      router.replace('/setup-checklist');
    } catch (err) {
      if (isApiError(err) && err.code === 'EMAIL_ALREADY_REGISTERED') {
        form.setError('ownerContactEmail', { message: 'This email is already registered. Log in instead, or use another.' });
        return;
      }
      setFormError(quotaMessage(err, 'signup') ?? errorMessage(err));
    }
  };

  if (checking) return <FullPageSpinner />;

  return (
    <AuthCard
      title="Create your organization"
      description="You’ll be its Owner. Add your company domain and mailbox right after."
      footer={
        <span>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </span>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FormError message={formError} />
          <FormField
            control={form.control}
            name="organizationName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization name</FormLabel>
                <FormControl>
                  <Input autoComplete="organization" placeholder="Acme Ltd" autoFocus {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ownerName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ownerContactEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your current email</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" placeholder="you@gmail.com" {...field} />
                </FormControl>
                <FormDescription>
                  Used to sign in until you claim your company mailbox. After that, your company address replaces it.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" {...field} />
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
                <FormLabel>Confirm password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Spinner />}
            Create organization
          </Button>
        </form>
      </Form>
    </AuthCard>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <SignupForm />
    </Suspense>
  );
}
