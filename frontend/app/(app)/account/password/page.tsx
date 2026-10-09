'use client';

// Change Password — screen-flow-inventory.md §2.11. PATCH /me/password
// { currentPassword, newPassword } — requires the current password even
// though the user is signed in. On success the backend signs out every
// OTHER session; this one stays.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { PasswordInput } from '@/components/common/password-input';
import { Spinner } from '@/components/common/spinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import { newPasswordSchema, PASSWORD_MIN } from '@/lib/validation';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'Passwords don’t match', path: ['confirmPassword'] })
  .refine((v) => v.password !== v.currentPassword, {
    message: 'Choose a password different from your current one',
    path: ['password'],
  });
type Values = z.infer<typeof schema>;

export default function ChangePasswordPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', password: '', confirmPassword: '' },
  });

  const onSubmit = async ({ currentPassword, password }: Values) => {
    setFormError(null);
    try {
      await api('/me/password', { method: 'PATCH', body: { currentPassword, newPassword: password } });
      form.reset();
      toast.success('Password changed', { description: 'Your other sessions have been signed out.' });
    } catch (err) {
      if (isApiError(err) && err.code === 'INVALID_CREDENTIALS') {
        form.setError('currentPassword', { message: 'Your current password is incorrect' });
        return;
      }
      if (isApiError(err) && err.code === 'PASSWORD_UNCHANGED') {
        form.setError('password', { message: err.message });
        return;
      }
      setFormError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader title="Password" description="Change the password you use to sign in." />
      <Card className="max-w-lg">
        <CardContent className="pt-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <FormError message={formError} />
              <FormField
                control={form.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current password</FormLabel>
                    <FormControl>
                      <PasswordInput autoComplete="current-password" {...field} />
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
                    <FormLabel>New password</FormLabel>
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
                    <FormLabel>Confirm new password</FormLabel>
                    <FormControl>
                      <PasswordInput autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Spinner />}
                Change password
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </>
  );
}
