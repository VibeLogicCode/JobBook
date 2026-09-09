import type { Metadata, Viewport } from 'next';
import { ThemeScript } from '@/components/theme/theme-script';
import { AppShell } from '@/components/ui/AppShell';
import { loadOrganization } from '@/lib/organization/load';
import { primaryCompany } from '@/lib/company/load';
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
  /**
   * The tab title is the DEPLOYMENT's name -- the group's, when there are two
   * companies -- because a browser tab is not a document and cannot know which
   * company the reader is looking at. The tagline is a company's, so it goes
   * quiet rather than picking one.
   */
  const company = await primaryCompany();
  return {
    title: {
      template: org ? `%s — ${org.displayName}` : '%s',
      default: org?.displayName ?? 'Setup required',
    },
    description: company?.tagline ?? undefined,
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
  /**
   * Null when there are two companies, which paints the app in the default
   * token family and shows no owner name.
   *
   * That is the right answer rather than a gap: the accent colour and the
   * owner's name are one company's branding, and painting the whole
   * application in the builder's colour while somebody works on a repair job
   * would be a claim about which business they are in. `loadCompanies` is
   * `cache()`-wrapped and the layout is the reader it was wrapped for.
   */
  const company = await primaryCompany();

  return (
    <html lang={org?.locale ?? 'en-CA'} suppressHydrationWarning>
      <head>
        <ThemeScript />
        {company?.brandColor ? (
          // The company's accent overrides the token family for the whole app.
          <style>{`:root{--accent:${company.brandColor};--accent-text:${company.brandColor};--focus:${company.brandColor}}`}</style>
        ) : null}
      </head>
      <body>
        <AppShell
          displayName={org?.displayName ?? 'Not set up'}
          ownerName={company?.ownerName ?? null}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
