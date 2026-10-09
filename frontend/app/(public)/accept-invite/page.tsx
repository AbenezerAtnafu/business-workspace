'use client';

// Accept Invite — screen-flow-inventory.md §2.1 / Flow 3 (onboarding Path A).
// GET /invites/{token} previews what's being accepted (read-only context),
// then POST /invites/{token}/accept { name, password } creates the mailbox +
// user and signs the invitee straight in. Expired/accepted → 410
// INVITE_NOT_ACTIVE, shown explicitly so they know to ask for a new invite.

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MailX } from 'lucide-react';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/common/form-error';
import { PasswordInput } from '@/components/common/password-input';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Button, buttonVariants } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { InvitePreview, SessionResponse } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { homePathFor } from '@/lib/auth/navigation';
import { formatDateTime } from '@/lib/utils';
import { newPasswordSchema, PASSWORD_MIN } from '@/lib/validation';

const schema = z
  .object({
    name: z.string().trim().min(1, 'Enter your name').max(200, 'Use at most 200 characters'),
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'Passwords don’t match', path: ['confirmPassword'] });
type Values = z.infer<typeof schema>;

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; invite: InvitePreview }
  | { kind: 'inactive'; message: string }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

function InviteProblem({ title, message }: { title: string; message: string }) {
  return (
    <AuthCard title={title}>
      <div className="flex flex-col items-center gap-4 text-center text-sm">
        <MailX className="h-10 w-10 text-muted-foreground" />
        <p className="text-muted-foreground">{message}</p>
        <Link href="/login" className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
          Go to log in
        </Link>
      </div>
    </AuthCard>
  );
}

function AcceptInvite() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const { establishSession } = useAuth();
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' });
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', password: '', confirmPassword: '' },
  });

  useEffect(() => {
    if (!token) {
      setPreview({ kind: 'invalid' });
      return;
    }
    const controller = new AbortController();
    api<InvitePreview>(`/invites/${encodeURIComponent(token)}`, { auth: false, signal: controller.signal })
      .then((invite) => setPreview({ kind: 'ready', invite }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (isApiError(err) && err.status === 410) setPreview({ kind: 'inactive', message: err.message });
        else if (isApiError(err) && (err.status === 404 || err.status === 400)) setPreview({ kind: 'invalid' });
        else setPreview({ kind: 'error', message: errorMessage(err) });
      });
    return () => controller.abort();
  }, [token]);

  const onSubmit = async ({ name, password }: Values) => {
    if (!token) return;
    setFormError(null);
    try {
      const res = await api<SessionResponse>(`/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        auth: false,
        body: { name, password },
      });
      const me = await establishSession(res.accessToken);
      router.replace(homePathFor(me));
    } catch (err) {
      if (isApiError(err) && err.status === 410) {
        setPreview({ kind: 'inactive', message: err.message });
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  switch (preview.kind) {
    case 'loading':
      return <FullPageSpinner label="Checking your invite…" />;
    case 'invalid':
      return (
        <InviteProblem
          title="Invite link not recognised"
          message="This link is incomplete or doesn’t match any invite. Open it again from your invite email, or ask your administrator to resend it."
        />
      );
    case 'inactive':
      return (
        <InviteProblem
          title="This invite is no longer active"
          message={`${preview.message} Invites expire after 7 days and can only be accepted once.`}
        />
      );
    case 'error':
      return <InviteProblem title="We couldn’t load your invite" message={preview.message} />;
  }

  const { invite } = preview;
  const address = `${invite.localPart}@${invite.domainName}`;

  return (
    <AuthCard
      title={`Join ${invite.organizationName}`}
      description={`${invite.invitedByName} invited you to Business Workspace.`}
    >
      <div className="mb-6 rounded-lg border bg-muted/40 p-4 text-sm">
        <p className="text-muted-foreground">Your company email will be</p>
        <p className="mt-0.5 break-all text-base font-medium">{address}</p>
        <p className="mt-2 text-xs text-muted-foreground">Invite expires {formatDateTime(invite.expiresAt)}.</p>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FormError message={formError} />
          {/* Lets password managers save the credential against the right username. */}
          <input type="hidden" name="username" autoComplete="username" value={address} readOnly />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your full name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" autoFocus {...field} />
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
                <FormLabel>Choose a password</FormLabel>
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
            Accept invite
          </Button>
        </form>
      </Form>
    </AuthCard>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <AcceptInvite />
    </Suspense>
  );
}
