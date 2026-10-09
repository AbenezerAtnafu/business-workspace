'use client';

// MFA Setup / Disable — screen-flow-inventory.md §2.11 / Flow 12.
// Setup:   POST /me/mfa/setup → { secret, otpauthUrl } (QR + manual key)
//          POST /me/mfa/verify-setup { code } → mfa_enabled = true
// Disable: POST /me/mfa/disable { password } or { code } — never a bare toggle.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { PasswordInput } from '@/components/common/password-input';
import { Spinner } from '@/components/common/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { MfaSetupResponse } from '@/lib/api/types';
import { useAuth, useCurrentUser } from '@/lib/auth/auth-context';
import { totpCodeSchema } from '@/lib/validation';

function CodeInput(props: React.ComponentProps<typeof Input>) {
  return (
    <Input
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="123456"
      className="max-w-[12rem] text-center font-mono text-lg tracking-[0.4em]"
      {...props}
      onChange={(e) => {
        e.target.value = e.target.value.replace(/\D/g, '');
        props.onChange?.(e);
      }}
    />
  );
}

/** Groups the base32 secret in 4s so it's typeable. */
function formatSecret(secret: string) {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

// ---- Enrollment ------------------------------------------------------------

const verifySchema = z.object({ code: totpCodeSchema });

function EnableMfa() {
  const { refreshMe } = useAuth();
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const form = useForm<z.infer<typeof verifySchema>>({
    resolver: zodResolver(verifySchema),
    defaultValues: { code: '' },
  });

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      // Calling setup again just replaces the pending secret server-side.
      setSetup(await api<MfaSetupResponse>('/me/mfa/setup', { method: 'POST' }));
      form.reset();
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const verify = async ({ code }: { code: string }) => {
    try {
      await api('/me/mfa/verify-setup', { method: 'POST', body: { code } });
      await refreshMe();
      toast.success('Two-step verification is on');
    } catch (err) {
      if (isApiError(err) && err.code === 'INVALID_CODE') {
        form.setError('code', { message: 'That code didn’t match. Check your device’s clock and try the next code.' });
        return;
      }
      if (isApiError(err) && err.code === 'MFA_NOT_STARTED') {
        setSetup(null);
        setStartError('Setup was reset. Start again to get a new QR code.');
        return;
      }
      form.setError('root', { message: errorMessage(err) });
    }
  };

  const copySecret = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Couldn’t copy. Select the key and copy it manually.');
    }
  };

  if (!setup) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Two-step verification</CardTitle>
            <Badge variant="warning">Off</Badge>
          </div>
          <CardDescription>
            Ask for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) every
            time you sign in, on top of your password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormError message={startError} />
        </CardContent>
        <CardFooter>
          <Button onClick={start} disabled={starting}>
            {starting ? <Spinner /> : <ShieldCheck />}
            Set up two-step verification
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your authenticator app</CardTitle>
        <CardDescription>Scan the QR code, then enter the 6-digit code the app shows.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="w-fit rounded-lg border bg-white p-3">
            <QRCodeSVG value={setup.otpauthUrl} size={176} marginSize={0} aria-label="QR code for authenticator app" />
          </div>
          <div className="space-y-2 text-sm">
            <p className="font-medium">Can’t scan it?</p>
            <p className="text-muted-foreground">Enter this key in your app instead (time-based):</p>
            <div className="flex items-center gap-2">
              <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">{formatSecret(setup.secret)}</code>
              <Button type="button" variant="ghost" size="icon" onClick={copySecret} aria-label="Copy key">
                {copied ? <Check className="text-success" /> : <Copy />}
              </Button>
            </div>
          </div>
        </div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(verify)} className="space-y-4" noValidate>
            <FormError message={form.formState.errors.root?.message} />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code from the app</FormLabel>
                  <FormControl>
                    <CodeInput autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Spinner />}
                Verify and turn on
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

// ---- Disable ---------------------------------------------------------------

const disableSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), password: z.string().min(1, 'Enter your password'), code: z.string() }),
  z.object({ method: z.literal('code'), password: z.string(), code: totpCodeSchema }),
]);
type DisableValues = z.infer<typeof disableSchema>;

function DisableMfa() {
  const { refreshMe } = useAuth();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<DisableValues>({
    resolver: zodResolver(disableSchema),
    defaultValues: { method: 'password', password: '', code: '' },
  });
  const method = form.watch('method');

  const onSubmit = async (values: DisableValues) => {
    setFormError(null);
    const body = values.method === 'password' ? { password: values.password } : { code: values.code };
    try {
      await api('/me/mfa/disable', { method: 'POST', body });
      await refreshMe();
      toast.success('Two-step verification is off');
    } catch (err) {
      if (isApiError(err) && err.code === 'INVALID_CREDENTIALS') {
        form.setError('password', { message: 'Incorrect password' });
        return;
      }
      if (isApiError(err) && err.code === 'INVALID_CODE') {
        form.setError('code', { message: 'That code didn’t match' });
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  const switchMethod = (m: 'password' | 'code') => {
    form.reset({ method: m, password: '', code: '' });
    setFormError(null);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Two-step verification</CardTitle>
          <Badge variant="success">On</Badge>
        </div>
        <CardDescription>You’ll be asked for a code from your authenticator app each time you sign in.</CardDescription>
      </CardHeader>
      {!open ? (
        <CardFooter>
          <Button variant="outline" onClick={() => setOpen(true)}>
            <ShieldOff /> Turn off
          </Button>
        </CardFooter>
      ) : (
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-sm space-y-4" noValidate>
              <p className="text-sm text-muted-foreground">
                Confirm it’s you with your{' '}
                {method === 'password' ? 'password' : 'authenticator code'} to turn this off.
              </p>
              <FormError message={formError} />
              {method === 'password' ? (
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Current password</FormLabel>
                      <FormControl>
                        <PasswordInput autoComplete="current-password" autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : (
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Authenticator code</FormLabel>
                      <FormControl>
                        <CodeInput autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => switchMethod(method === 'password' ? 'code' : 'password')}
              >
                {method === 'password' ? 'Use an authenticator code instead' : 'Use your password instead'}
              </button>
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting && <Spinner />}
                  Turn off two-step verification
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    switchMethod('password');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      )}
    </Card>
  );
}

export default function MfaPage() {
  const user = useCurrentUser();
  return (
    <>
      <PageHeader title="Two-step verification" description="Add a second step to signing in." />
      <div className="max-w-2xl">{user.mfaEnabled ? <DisableMfa /> : <EnableMfa />}</div>
    </>
  );
}
