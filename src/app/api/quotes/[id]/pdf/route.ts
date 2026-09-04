import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization, quotes } from '@/db/schema';
import { renderPdf } from '@/lib/documents/pdf';

export const dynamic = 'force-dynamic';

/**
 * Generates the customer document.
 *
 * Chromium fetches the print page over localhost from inside this container,
 * which is why the URL is built from an internal base rather than from the
 * request's own host: the public hostname resolves to Cloudflare, and the
 * render would authenticate against Access instead of the render secret.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [quote] = await db
    .select({ number: quotes.quoteNumber, version: quotes.version, kind: quotes.kind })
    .from(quotes)
    .where(eq(quotes.id, id));
  if (!quote) return new Response('Not found', { status: 404 });

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

  const base = process.env.INTERNAL_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;

  try {
    const pdf = await renderPdf({
      url: `${base}/print/quote/${id}`,
      footerText: org?.documentFooterText ?? org?.displayName ?? '',
    });

    const label = quote.kind === 'change_order' ? 'change-order' : 'quote';
    const filename = `${label}-${quote.number}-v${quote.version}.pdf`;

    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        // inline, so the owner previews it at the kitchen table rather than
        // hunting through a downloads folder.
        'content-disposition': `inline; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return new Response(`PDF generation failed: ${message}`, { status: 500 });
  }
}
