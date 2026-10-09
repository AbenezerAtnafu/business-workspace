'use client';

// Organization Settings — screen-flow-inventory.md §2.7, api-contract.md §2.
// GET /organization (any member, read-only for Members), PATCH /organization
// (Owner/Admin): name, logo (an https URL — MVP has no file upload), default
// time zone and language. Only changed fields are sent; each save is one
// `organization.updated` audit entry. The workspace ID (slug), owner and
// status are shown read-only — they have their own flows or none in MVP.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ImageOff } from 'lucide-react';
import { toast } from 'sonner';
import { CopyButton } from '@/components/common/copy-button';
import { FormError } from '@/components/common/form-error';
import { PageHeader } from '@/components/common/page-header';
import { FullPageSpinner, Spinner } from '@/components/common/spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { ListResponse, Organization, User } from '@/lib/api/types';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { useApiQuery } from '@/lib/hooks/use-api-query';
import { LOCALE_OPTIONS, localeLabel, timeZoneLabel, timeZones } from '@/lib/locales';
import { useOrganization } from '@/lib/organization-context';
import { formatDateTime } from '@/lib/utils';

const ZONES = timeZones();
const ZONE_SET = new Set(ZONES);

const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(200, 'At most 200 characters'),
  logoUrl: z
    .string()
    .trim()
    .max(2048, 'That URL is too long')
    .refine((v) => v === '' || /^https:\/\/[^\s]+$/i.test(v), 'Use an https:// link to an image'),
  defaultTimezone: z.string().refine((v) => ZONE_SET.has(v), 'Pick a time zone from the list'),
  defaultLocale: z.string().min(1, 'Pick a language'),
});
type Values = z.infer<typeof schema>;

const toValues = (o: Organization): Values => ({
  name: o.name,
  logoUrl: o.logoUrl ?? '',
  defaultTimezone: o.defaultTimezone,
  defaultLocale: o.defaultLocale,
});

export default function OrganizationSettingsPage() {
  const me = useCurrentUser();
  const canEdit = me.role !== 'member';
  const { organization, setOrganization } = useOrganization();
  const users = useApiQuery<ListResponse<User>>('/users');

  if (!organization) return <FullPageSpinner />;
  const owner = users.data?.data.find((u) => u.id === organization.ownerUserId);

  return (
    <>
      <PageHeader
        title={canEdit ? 'Organization settings' : 'Organization'}
        description={
          canEdit
            ? 'Your organization’s profile and the defaults new people start with.'
            : 'Your organization’s profile. Only the Owner and Admins can change it.'
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {canEdit ? (
          <ProfileForm organization={organization} onSaved={setOrganization} />
        ) : (
          <ReadOnlyProfile organization={organization} />
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">About this workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Workspace ID</dt>
                <dd className="flex items-center gap-1 font-mono text-xs" data-testid="org-slug">
                  {organization.slug}
                  <CopyButton value={organization.slug} label="Copy workspace ID" />
                </dd>
                <dd className="text-xs text-muted-foreground">Set at sign-up. It doesn’t change when you rename.</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Owner</dt>
                <dd>
                  {owner ? (
                    canEdit ? (
                      <Link href={`/admin/users/${owner.id}`} className="underline underline-offset-4">
                        {owner.name}
                      </Link>
                    ) : (
                      owner.name
                    )
                  ) : (
                    '—'
                  )}
                  {me.id === organization.ownerUserId && <span className="text-muted-foreground"> (you)</span>}
                </dd>
                {canEdit && (
                  <dd className="text-xs text-muted-foreground">Change it with Transfer ownership on a user’s page.</dd>
                )}
              </div>
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <Badge variant={organization.status === 'active' ? 'success' : 'warning'}>
                    {organization.status === 'active' ? 'Active' : organization.status}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatDateTime(organization.createdAt)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ProfileForm({ organization, onSaved }: { organization: Organization; onSaved: (o: Organization) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues(organization) });

  // Re-seed when the org changes underneath (e.g. after our own save).
  useEffect(() => {
    form.reset(toValues(organization));
  }, [organization, form]);

  const localeOptions = useMemo(
    () =>
      LOCALE_OPTIONS.some((l) => l.value === organization.defaultLocale)
        ? LOCALE_OPTIONS
        : [...LOCALE_OPTIONS, { value: organization.defaultLocale, label: organization.defaultLocale }],
    [organization.defaultLocale],
  );

  const logo = form.watch('logoUrl').trim();
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [logo]);

  const onSubmit = async (raw: Values) => {
    setFormError(null);
    const v = schema.parse(raw);
    const current = toValues(organization);
    const body: Record<string, string | null> = {};
    if (v.name !== current.name) body.name = v.name;
    if (v.logoUrl !== current.logoUrl) body.logoUrl = v.logoUrl === '' ? null : v.logoUrl;
    if (v.defaultTimezone !== current.defaultTimezone) body.defaultTimezone = v.defaultTimezone;
    if (v.defaultLocale !== current.defaultLocale) body.defaultLocale = v.defaultLocale;
    if (Object.keys(body).length === 0) return;
    try {
      const updated = await api<Organization>('/organization', { method: 'PATCH', body });
      onSaved(updated);
      toast.success('Organization settings saved');
    } catch (err) {
      setFormError(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
        <CardDescription>Shown to everyone in your organization.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate data-testid="org-form">
            <FormError message={formError} />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Organization name</FormLabel>
                  <FormControl>
                    <Input autoComplete="organization" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="logoUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Logo URL</FormLabel>
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted">
                      {logo && /^https:\/\//i.test(logo) && !logoFailed ? (
                        // eslint-disable-next-line @next/next/no-img-element -- arbitrary customer URL
                        <img src={logo} alt="Logo preview" className="h-full w-full object-contain" onError={() => setLogoFailed(true)} />
                      ) : (
                        <ImageOff className="h-4 w-4 text-muted-foreground" aria-hidden />
                      )}
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex gap-2">
                        <FormControl>
                          <Input placeholder="https://example.com/logo.png" inputMode="url" spellCheck={false} {...field} />
                        </FormControl>
                        {field.value && (
                          <Button type="button" variant="ghost" onClick={() => form.setValue('logoUrl', '', { shouldDirty: true })}>
                            Remove
                          </Button>
                        )}
                      </div>
                      {logoFailed ? (
                        <p className="text-[0.8rem] text-warning">
                          Couldn’t load an image from this link. Check that it’s public and points at an image.
                        </p>
                      ) : (
                        <FormDescription>A public https link to a square image. Leave empty for none.</FormDescription>
                      )}
                      <FormMessage />
                    </div>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultTimezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Default time zone</FormLabel>
                  <FormControl>
                    <Input list="tz-options" autoComplete="off" spellCheck={false} {...field} />
                  </FormControl>
                  <datalist id="tz-options">
                    {ZONES.map((z) => (
                      <option key={z} value={z}>
                        {timeZoneLabel(z)}
                      </option>
                    ))}
                  </datalist>
                  <FormDescription>
                    Start typing a city, e.g. “Addis”. {ZONE_SET.has(field.value) && `Now: ${timeZoneLabel(field.value)}.`}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultLocale"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Default language</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger aria-label="Default language">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {localeOptions.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>The default for your organization. The app itself is in English for now.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex gap-2">
              <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
                {form.formState.isSubmitting && <Spinner />} Save changes
              </Button>
              {form.formState.isDirty && (
                <Button type="button" variant="ghost" onClick={() => form.reset(toValues(organization))}>
                  Discard
                </Button>
              )}
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function ReadOnlyProfile({ organization }: { organization: Organization }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-3 text-sm" data-testid="org-readonly">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{organization.name}</dd>
          <dt className="text-muted-foreground">Logo</dt>
          <dd>{organization.logoUrl ? 'Set' : 'None'}</dd>
          <dt className="text-muted-foreground">Default time zone</dt>
          <dd>{timeZoneLabel(organization.defaultTimezone)}</dd>
          <dt className="text-muted-foreground">Default language</dt>
          <dd>{localeLabel(organization.defaultLocale)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
