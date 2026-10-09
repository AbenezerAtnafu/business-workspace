'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useCurrentUser } from '@/lib/auth/auth-context';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { homePathFor } from '@/lib/auth/navigation';
import { navFor } from './nav-config';
import { NotificationBell } from './notification-bell';
import { SidebarNav } from './sidebar-nav';
import { UserMenu } from './user-menu';

function Brand({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Building2 className="h-4 w-4" />
      </span>
      Business Workspace
    </Link>
  );
}

/** The customer's own org (name + optional logo) under the product brand. */
function OrgBadge() {
  const { organization } = useOrganization();
  const [broken, setBroken] = useState<string | null>(null);
  if (!organization) return <div className="h-9" />;
  const showLogo = organization.logoUrl && broken !== organization.logoUrl;
  return (
    <div className="flex items-center gap-2 px-5 py-3" data-testid="org-badge">
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary customer URL; next/image needs allow-listed hosts
        <img
          src={organization.logoUrl!}
          alt=""
          className="h-7 w-7 shrink-0 rounded object-contain"
          onError={() => setBroken(organization.logoUrl)}
        />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold text-muted-foreground">
          {organization.name.trim().charAt(0).toUpperCase()}
        </span>
      )}
      <span className="truncate text-sm font-medium" title={organization.name}>
        {organization.name}
      </span>
    </div>
  );
}

/**
 * Authenticated app shell (screen-flow-inventory.md §1): sidebar on desktop,
 * a slide-in drawer on mobile, top bar with the Notifications bell (§2.10)
 * and the account menu.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <OrganizationProvider>
      <Shell>{children}</Shell>
    </OrganizationProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const sections = navFor(user.role);
  const home = homePathFor(user);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r bg-muted/30 md:flex md:flex-col">
        <div className="flex h-14 items-center border-b px-5">
          <Brand href={home} />
        </div>
        <OrgBadge />
        <div className="flex-1 overflow-y-auto">
          <SidebarNav sections={sections} />
        </div>
      </aside>

      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent className="left-0 top-0 h-full max-w-[18rem] translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-none p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:rounded-none">
          <DialogTitle className="flex h-14 items-center border-b px-5">
            <Brand href={home} />
          </DialogTitle>
          <OrgBadge />
          <SidebarNav sections={sections} onNavigate={() => setMobileOpen(false)} />
        </DialogContent>
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur md:px-6">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)}>
            <Menu />
            <span className="sr-only">Open navigation</span>
          </Button>
          <div className="md:hidden">
            <Brand href={home} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8">{children}</main>
      </div>
    </div>
  );
}
