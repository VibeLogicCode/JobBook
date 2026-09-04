import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeBrowser, escapeHtml, renderPdf } from '@/lib/documents/pdf';

/**
 * The PDF pipeline.
 *
 * Plan 3 asked for the extracted text and the page count to be asserted and
 * never the rendered bytes, and until now nothing asserted anything: the
 * document is the product's whole output and it had no coverage at all.
 *
 * What this covers is the PIPELINE -- that Chromium launches, that the version
 * in the image matches the one the library expects, that the render secret is
 * demanded and sent, and that print CSS reaches the paginator rather than only
 * the DOM. That is deliberately the half worth automating first,
 * because it is the half that fails silently and catastrophically: Playwright
 * refuses to launch a browser build it did not ship with, and the error
 * surfaces only when somebody asks for their first PDF, long after the image
 * looked fine.
 *
 * It does NOT cover the quote template's content. `src/app/print/quote/[id]`
 * loads its own data inside a server component, so asserting on it needs the
 * Next server running, which is a bigger piece of test infrastructure than
 * this file. That gap is real and is recorded here rather than papered over.
 *
 * The page under test is served by a local HTTP server rather than the
 * application, so a template change cannot make this file fail for a reason
 * that has nothing to do with the pipeline.
 */

let server: Server;
let base: string;
let html = '';

const SECRET = 'test-render-secret';
let previousSecret: string | undefined;

/** Every request's headers, so the secret can be asserted rather than assumed. */
let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  previousSecret = process.env.INTERNAL_RENDER_SECRET;
  process.env.INTERNAL_RENDER_SECRET = SECRET;

  server = createServer((request, response) => {
    lastHeaders = request.headers;
    // The real print route refuses a request without the secret, so this one
    // does too: otherwise a pipeline that silently stopped sending the header
    // would still produce a document and the test would still pass.
    if (request.headers['x-render-secret'] !== SECRET) {
      response.writeHead(401).end('no render secret');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // The service keeps one browser for the life of the process, so the suite
  // would otherwise sit on a live Chromium and never exit.
  await closeBrowser();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousSecret === undefined) delete process.env.INTERNAL_RENDER_SECRET;
  else process.env.INTERNAL_RENDER_SECRET = previousSecret;
});

afterEach(() => {
  lastHeaders = {};
});

function documentOf(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; }
    body { font-family: sans-serif; margin: 0; }
    .page-break { break-before: page; }
  </style></head><body>${body}</body></html>`;
}

/**
 * Counts page objects in the PDF structure.
 *
 * Read from the bytes rather than through a parser dependency: `/Type /Page`
 * appears once per page and `/Type /Pages` once for the tree, and the negative
 * lookahead is what keeps the tree node from being counted as a page. Adding a
 * PDF parser to production dependencies to count pages in a test is a poor
 * trade; if this ever needs the text layer, that is when to add one.
 */
function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![sR])/g) ?? []).length;
}

describe('the PDF pipeline', () => {
  it('renders a one-page document', async () => {
    html = documentOf('<h1>Quote</h1><p>One page of content.</p>');

    const pdf = await renderPdf({ url: base });

    // The magic bytes, because a Buffer of the wrong thing is still a Buffer.
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pageCount(pdf)).toBe(1);
  });

  it('sends the render secret, which is what the print route authenticates on', async () => {
    html = documentOf('<p>Authenticated.</p>');

    await renderPdf({ url: base });

    expect(lastHeaders['x-render-secret']).toBe(SECRET);
  });

  it('refuses to render when no secret is configured', async () => {
    html = documentOf('<p>Should never be reached.</p>');
    const saved = process.env.INTERNAL_RENDER_SECRET;
    delete process.env.INTERNAL_RENDER_SECRET;

    try {
      await expect(renderPdf({ url: base })).rejects.toThrow(/INTERNAL_RENDER_SECRET/);
    } finally {
      process.env.INTERNAL_RENDER_SECRET = saved;
    }
  });

  it('surfaces a failing print page instead of returning a broken document', async () => {
    // A quote whose id does not exist renders a 404, and a pipeline that
    // printed it anyway would hand the owner a PDF of an error page.
    html = documentOf('<p>unused</p>');
    const saved = process.env.INTERNAL_RENDER_SECRET;
    process.env.INTERNAL_RENDER_SECRET = 'the-wrong-secret';

    try {
      await expect(renderPdf({ url: base })).rejects.toThrow(/401/);
    } finally {
      process.env.INTERNAL_RENDER_SECRET = saved;
    }
  });

  /**
   * Print CSS has to reach the paginator, not merely the DOM. `break-before:
   * page` is the mechanism the quote template uses to keep a group off a page
   * boundary, so if this stops working the document degrades silently -- the
   * text is all present, in the wrong places.
   */
  it('honours a forced page break, so print CSS reaches the paginator', async () => {
    html = documentOf(
      '<h1>First</h1><p>Page one.</p><div class="page-break"><h1>Second</h1><p>Page two.</p></div>',
    );

    const pdf = await renderPdf({ url: base });

    expect(pageCount(pdf)).toBe(2);
  });

  /**
   * The footer TEXT is not asserted, and that is a limit rather than an
   * oversight: a PDF's content streams are compressed, so the string is not in
   * the bytes, and reading it back needs a PDF parser this project does not
   * carry. An earlier version of this test matched a loose pattern against the
   * raw bytes and passed for no reason at all -- which is worse than an
   * acknowledged gap, because it read as coverage. What IS asserted is that
   * the multi-page path renders, and `escapeHtml` is asserted directly below.
   */
  it('paginates a three-page document', async () => {
    html = documentOf(
      '<p>One.</p><div class="page-break"><p>Two.</p></div><div class="page-break"><p>Three.</p></div>',
    );

    const pdf = await renderPdf({ url: base, footerText: 'Quote QT-0001' });

    expect(pageCount(pdf)).toBe(3);
  });

  it('escapes what goes into the footer template', () => {
    // The footer is assembled by string interpolation, so an unescaped angle
    // bracket in a company's legal name would close the surrounding div and
    // silently lose the page numbering on every document it prints.
    expect(escapeHtml('Smith & Sons <Contracting> "Ltd"')).toBe(
      'Smith &amp; Sons &lt;Contracting&gt; &quot;Ltd&quot;',
    );
    expect(escapeHtml('</div><script>alert(1)</script>')).toBe(
      '&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    // Ampersands first, or an escaped entity gets escaped a second time and
    // the customer's document reads "Smith &amp;amp; Sons".
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('escapes the footer text rather than injecting it as markup', async () => {
    html = documentOf('<p>One.</p>');

    // A company whose legal name contains an ampersand or a quote is ordinary,
    // and the footer is built by string interpolation, so this is the injection
    // point. It must render rather than break the footer template.
    const pdf = await renderPdf({ url: base, footerText: 'Smith & Sons <Contracting> "Ltd"' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
  });
});
