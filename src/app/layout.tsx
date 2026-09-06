import type { Metadata, Viewport } from 'next';
import { ThemeScript } from '@/components/theme/theme-script';
import { AppShell } from '@/components/ui/AppShell';
import { loadOrganization } from '@/lib/organization/load';
import './globals.css';

export const dynamic = 'force-dynamic';

/**
 * The browser tab carries the tenant's name, not the product's. Everything
 * user-visible comes from the organization record (spec 2.1).
 *
 * A `template` rather than a flat string: every route below now sets its own
 * `title` (the record or the list it shows), and this is where the tenant
 * name gets appended so a page never has to repeat it. Record first, tenant
 * last -- browsers truncate from the right, and the tenant name is the part
 * that reads the same in every tab.
 */
export async function generateMetadata(): Promise<Metadata> {
  const org = await loadOrganization();
  return {
    title: {
      template: org ? `%s — ${org.displayName}` : '%s',
      default: org?.displayName ?? 'Setup required',
    },
    description: org?.tagline ?? undefined,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The worksheet is used one-handed in a truck; pinch-zoom stays available.
  maximumScale: 5,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const org = await loadOrganization();

  return (
    <html lang={org?.locale ?? 'en-CA'} suppressHydrationWarning>
      <head>
        <ThemeScript />
        {org?.brandColor ? (
          // The tenant's accent overrides the token family for the whole app.
          <style>{`:root{--accent:${org.brandColor};--accent-text:${org.brandColor};--focus:${org.brandColor}}`}</style>
        ) : null}
      </head>
      <body>
        <AppShell
          displayName={org?.displayName ?? 'Not set up'}
          ownerName={org?.ownerName ?? null}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
