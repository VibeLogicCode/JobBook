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
  /**
   * THE KEYBOARD MUST SHRINK THE PAGE, NOT COVER IT.
   *
   * A sheet is `max-h-[85dvh]` anchored to the bottom with its Save button in
   * a `shrink-0` footer. `dvh` does not shrink for the on-screen keyboard --
   * the default `resizes-visual` moves the visual viewport and leaves the
   * layout viewport alone -- so the footer stayed exactly where it was, behind
   * the keyboard. `ScopeSheet` autofocuses a measurement field, which means
   * Save was already covered the instant the sheet opened: the tape-measure
   * flow, on site, unrecoverable without dismissing the keyboard first.
   *
   * `resizes-content` makes the keyboard take real layout space, so 85dvh is
   * 85% of what is left and the footer stays on screen.
   */
  interactiveWidget: 'resizes-content',
  /**
   * `env(safe-area-inset-bottom)` was dead code without this. `AppShell` and
   * `SaveBanner` both add it to their bottom offsets, and on a notched phone
   * it evaluated to 0 because the viewport never extended under the inset.
   */
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * Together, not one after the other. Neither depends on the other, both are
   * `cache()`-wrapped, and this runs on EVERY page in the application before
   * the page's own queries start -- so a serial pair here is a round trip
   * added to every navigation in the product.
   */
  const [org, company] = await Promise.all([loadOrganization(), primaryCompany()]);
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
