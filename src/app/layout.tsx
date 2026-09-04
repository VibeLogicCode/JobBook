import type { Metadata, Viewport } from 'next';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { ThemeScript } from '@/components/theme/theme-script';
import { AppShell } from '@/components/ui/AppShell';
import './globals.css';

export const dynamic = 'force-dynamic';

/**
 * The browser tab carries the tenant's name, not the product's. Everything
 * user-visible comes from the organization record (spec 2.1).
 */
export async function generateMetadata(): Promise<Metadata> {
  const org = await loadOrganization();
  return {
    title: org ? `${org.displayName} — Quotes` : 'Setup required',
    description: org?.tagline ?? undefined,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The worksheet is used one-handed in a truck; pinch-zoom stays available.
  maximumScale: 5,
};

async function loadOrganization() {
  try {
    const [row] = await db.select().from(organization).where(eq(organization.id, 1));
    return row ?? null;
  } catch {
    // A missing database is a setup problem, not a crash: the shell still
    // renders so the person can read the message telling them what to do.
    return null;
  }
}

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
