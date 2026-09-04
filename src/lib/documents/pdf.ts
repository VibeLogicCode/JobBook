import { chromium, type Browser } from 'playwright';

/**
 * PDF generation through headless Chromium.
 *
 * Chrome's own print engine, so what the browser shows and what the customer
 * receives are the same rendering -- no second layout engine to keep in sync,
 * which is what makes an HTML-to-PDF library a permanent source of drift.
 *
 * One browser process is reused across requests. Launching Chromium per
 * request costs about a second and a few hundred megabytes, on a mini PC that
 * has neither to spare.
 */
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  const existing = await browserPromise?.catch(() => null);
  if (existing?.isConnected()) return existing;

  browserPromise = chromium.launch({
    // Chromium's sandbox needs kernel privileges the container does not grant.
    // The page it renders comes from our own server over localhost, so the
    // exposure is a document we generated ourselves.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return browserPromise;
}

export interface PdfOptions {
  /** Absolute URL the container can reach. Localhost, not the public hostname. */
  url: string;
  /** Printed at the foot of every page. */
  footerText?: string;
}

export async function renderPdf({ url, footerText }: PdfOptions): Promise<Buffer> {
  const secret = process.env.INTERNAL_RENDER_SECRET;
  if (!secret) throw new Error('INTERNAL_RENDER_SECRET is not set');

  const browser = await getBrowser();
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-render-secret': secret },
  });

  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    if (!response || !response.ok()) {
      throw new Error(`the print page returned ${response?.status() ?? 'no response'}`);
    }
    // Web fonts load asynchronously; printing before they arrive produces a
    // document in a fallback face, which for a contract is a visible defect.
    await page.evaluate(() => document.fonts.ready);

    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="width:100%;padding:0 16mm;font:8pt 'IBM Plex Sans',sans-serif;color:#5a5a72;display:flex;justify-content:space-between">
          <span>${escapeHtml(footerText ?? '')}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
      margin: { top: '14mm', bottom: '16mm', left: '0', right: '0' },
    });
  } finally {
    await context.close();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
