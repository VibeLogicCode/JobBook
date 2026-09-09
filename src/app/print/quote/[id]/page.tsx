import type { Metadata } from 'next';
import { Fragment } from 'react';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { logoDataUri } from '@/lib/documents/branding';
import { loadQuote } from '@/lib/quote/load';
import { formatCents, formatQty, formatRate } from '@/lib/money/format';
import { CONTRACT_TYPES } from '@/components/detail/labels';
import { PageParentLink } from '@/components/ui/PageHeader';
import { holdbackNoticeFor } from '@/lib/quote/holdback-notice';

export const dynamic = 'force-dynamic';

/**
 * The quote number, and nothing else -- this title becomes the saved
 * filename in some browsers, and a customer must never see an internal id
 * or a job name that was not written for them. `loadQuote` is
 * `cache()`-wrapped, so this shares its one read with the page below.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const data = await loadQuote(id);
    return { title: data ? data.quote.quoteNumber : 'Quote' };
  } catch {
    return { title: 'Quote' };
  }
}

/**
 * The customer-facing document.
 *
 * A separate visual system from the application: Plex Serif headings, Plex Sans
 * body, Plex Mono figures. Every string comes from the organization record --
 * nothing about any one company is written into this file.
 *
 * Reached over localhost by headless Chromium from inside the container, so it
 * never passes through Cloudflare and authenticates with the render secret in
 * proxy.ts instead.
 */
export default async function PrintQuote({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadQuote(id);
  if (!data) notFound();

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));
  if (!org) notFound();

  // Inlined, because Chromium fetches this page with only the render secret and
  // would get a 401 from the authenticated file route -- the customer would
  // receive a contract with a broken image where the letterhead should be.
  const logo = await logoDataUri(org.logoFileId);

  const { quote, lines, taxes } = data;
  const holdbackNotice = holdbackNoticeFor(quote.holdbackPctTenThou, org.holdbackTermsText);
  const included = lines.filter((line) => line.isIncluded);
  const upgrades = lines.filter((line) => !line.isIncluded);

  // group_totals by default: most residential contractors will not send a
  // homeowner a document reading 1,240.5 sqft x $4.00, because it invites
  // line-by-line negotiation of a price quoted as a whole.
  const groups = new Map<string, typeof included>();
  for (const line of included) {
    const bucket = groups.get(line.lineGroup) ?? [];
    bucket.push(line);
    groups.set(line.lineGroup, bucket);
  }

  const heading = quote.kind === 'change_order' ? 'Change Order' : 'Quotation';

  /**
   * What the customer is allowed to see is the project's commercial
   * arrangement, not a quote-level toggle: `contract_type` lives on the
   * project because it does not change quote to quote, and this document
   * has never read it before now.
   *
   * A lump sum is one price for a scope -- itemising it invites a customer to
   * argue one line and cherry-pick items out of what was priced as a whole,
   * which is the opposite of what a fixed price is for. `time_and_material`,
   * `cost_plus` and `unit_price` are the reverse: the customer pays for what
   * is actually used, so the rate and the amount per line IS the
   * arrangement, and today's per-trade grouping is not enough to show it.
   *
   * A project where nobody has decided yet keeps rendering exactly as this
   * document always has -- grouped, with amounts -- because a null is a fact
   * that has not been recorded, never a guess that it must mean lump sum.
   */
  const isLumpSum = quote.contractType === 'lump_sum';
  const isFullDetail =
    quote.contractType === 'time_and_material' ||
    quote.contractType === 'cost_plus' ||
    quote.contractType === 'unit_price';

  /** Same conversion `tax.rateTenThou` uses below: a `percent` line's rate IS the percentage, ten-thousandths scaled. */
  const percentOf = (rateTenThou: string) => `${(Number(rateTenThou) / 100).toFixed(2)}%`;

  return (
    <div className="doc">
      <style>{DOCUMENT_CSS}</style>

      {/* Screen-only: staff open this exact URL to preview what will render,
          and had no way back to the quote from it. `PageParentLink` already
          carries its own `no-print`, which is the whole point here -- this
          document goes to a customer, who must never receive a link back
          into the application. */}
      <div className="no-print mb-3">
        <PageParentLink href={`/quotes/${quote.id}`} label={`${quote.quoteNumber} · ${quote.projectName}`} />
      </div>

      <header className="letterhead">
        <div>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URI
            // must not go through the image optimiser, which would fetch it.
            <img src={logo} alt={org.displayName} className="logo" />
          ) : null}
          <h1 className="company">{org.displayName}</h1>
          {org.tagline ? <p className="tagline">{org.tagline}</p> : null}
          <p className="contact">
            {[org.addressLine1, org.city, org.province, org.postalCode].filter(Boolean).join(', ')}
            {org.phone ? ` · ${org.phone}` : ''}
            {org.email ? ` · ${org.email}` : ''}
          </p>
          {org.taxRegistrationNumber ? (
            <p className="contact">
              {org.taxRegistrationLabel ?? 'Tax number'}: {org.taxRegistrationNumber}
            </p>
          ) : null}
        </div>
        <div className="docmeta">
          <h2>{heading}</h2>
          <table>
            <tbody>
              <tr>
                <th>Number</th>
                <td className="num">{quote.quoteNumber}</td>
              </tr>
              <tr>
                <th>Version</th>
                <td className="num">{quote.version}</td>
              </tr>
              <tr>
                <th>Date</th>
                <td className="num">{quote.quoteDate}</td>
              </tr>
              <tr>
                <th>Valid until</th>
                <td className="num">{quote.validUntil}</td>
              </tr>
              {/* Absent rather than "Not decided": the row a customer reads is a
                  legal-ish document, and a blank fact does not belong on it --
                  it belongs in the application, where somebody can still set it. */}
              {quote.contractType ? (
                <tr>
                  <th>Contract type</th>
                  <td>{CONTRACT_TYPES[quote.contractType]}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </header>

      <section className="parties">
        <div>
          <h3>Prepared for</h3>
          <p>{quote.customerName}</p>
        </div>
        <div>
          <h3>Site</h3>
          <p>{quote.siteAddress ?? quote.projectName}</p>
        </div>
        <div>
          <h3>Project</h3>
          <p>{quote.projectName}</p>
        </div>
      </section>

      {isLumpSum ? (
        // No Amount column at all: a lump sum is one price for the whole
        // scope, and a dollar figure beside any single row -- even a
        // per-trade sum -- is something to argue down or cherry-pick out of
        // what was priced as a whole. Quantity and unit stay, because they
        // describe the work rather than price it.
        <table className="lines">
          <thead>
            <tr>
              <th>Scope of work</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([group, groupLines]) => (
              <tr key={group}>
                <td>
                  <strong>{group}</strong>
                  <ul>
                    {groupLines.map((line) => (
                      <li key={line.id}>
                        {line.description}
                        {line.calcMode === 'qty' ? (
                          <span className="num">
                            {' — '}
                            {formatQty(BigInt(line.qtyMilli))} {line.unitLabel}
                          </span>
                        ) : null}
                        {/* An allowance is a placeholder the final bill can still
                            true up against, not a price this scope was fixed at --
                            the one figure that stays even though every other row's
                            amount does not. */}
                        {line.isAllowance ? (
                          <span className="num"> (allowance {formatCents(line.lineTotalCents)})</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : isFullDetail ? (
        // Every line on its own row with its rate and its amount: on
        // time-and-material, cost-plus and unit-price work the customer pays
        // for what was actually used, so seeing the rate and the amount per
        // line IS the arrangement -- the per-trade sum below is not enough.
        <table className="lines">
          <thead>
            <tr>
              <th>Scope of work</th>
              <th className="num right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([group, groupLines]) => (
              <Fragment key={group}>
                <tr className="group-header">
                  <td colSpan={2}>
                    <strong>{group}</strong>
                  </td>
                </tr>
                {groupLines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      {line.description}
                      {line.isAllowance ? ' (allowance)' : ''}
                      {line.calcMode === 'qty' ? (
                        <span className="num">
                          {' — '}
                          {formatQty(BigInt(line.qtyMilli))} {line.unitLabel} ×{' '}
                          {formatRate(BigInt(line.unitPriceTenThou))}
                        </span>
                      ) : line.calcMode === 'percent' ? (
                        <span className="num">{' — '}{percentOf(line.unitPriceTenThou)}</span>
                      ) : null}
                    </td>
                    <td className="num right">{formatCents(line.lineTotalCents)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : (
        // Undecided prints exactly as this document always has: a null
        // contract type is a fact nobody has recorded yet, never a guess that
        // it must mean lump sum.
        <table className="lines">
          <thead>
            <tr>
              <th>Scope of work</th>
              <th className="num right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([group, groupLines]) => (
              <tr key={group}>
                <td>
                  <strong>{group}</strong>
                  <ul>
                    {groupLines.map((line) => (
                      <li key={line.id}>
                        {line.description}
                        {line.isAllowance ? ' (allowance)' : ''}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="num right">
                  {formatCents(groupLines.reduce((sum, line) => sum + line.lineTotalCents, 0))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <table className="totals">
        <tbody>
          <tr>
            <th>Subtotal</th>
            {/* `formatCents`, like every other amount on this page. Without it
                the subtotal printed as the raw scaled integer -- a customer's
                quote reading 5564884 where it should read $55,648.84. "Scale
                is internal" is a Phase 1 invariant precisely because this is
                what breaking it looks like: not a crash, a document. */}
            <td className="num right">{formatCents(quote.subtotalCents)}</td>
          </tr>
          {taxes.map((tax) => (
            <tr key={tax.label}>
              <th>
                {tax.label} {(Number(tax.rateTenThou) / 100).toFixed(2)}%
                {tax.registrationNumber ? ` · ${tax.registrationNumber}` : ''}
              </th>
              <td className="num right">{formatCents(tax.taxAmountCents)}</td>
            </tr>
          ))}
          <tr className="grand">
            <th>Total</th>
            <td className="num right">{formatCents(quote.totalCents)}</td>
          </tr>
        </tbody>
      </table>

      {upgrades.length > 0 ? (
        <section className="upgrades">
          <h3>Available upgrades</h3>
          <p className="note">
            Priced as an addition to the total above, and not included in it.
          </p>
          <table className="lines">
            <tbody>
              {upgrades.map((line) => (
                <tr key={line.id}>
                  <td>
                    {line.description}
                    {line.calcMode === 'qty' ? (
                      <span className="num">
                        {' — '}
                        {formatQty(BigInt(line.qtyMilli))} {line.unitLabel} ×{' '}
                        {formatRate(BigInt(line.unitPriceTenThou))}
                      </span>
                    ) : null}
                  </td>
                  {/* The grossed-up price: what accepting it actually adds. */}
                  <td className="num right">{formatCents(line.displayPriceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {/*
        * The holdback paragraph is a function of THIS QUOTE, not of the
        * organization's default. It printed unconditionally, so a job that
        * withheld nothing still told the customer that ten percent was being
        * retained from every payment -- while the settings screen that sets
        * the default said the opposite in as many words. See
        * `lib/quote/holdback-notice.ts` for why the rule is a tested function
        * rather than a condition here.
        */}
      {holdbackNotice || org.paymentTermsText ? (
        <section className="terms">
          <h3>Payment</h3>
          {org.paymentTermsText ? <p>{org.paymentTermsText}</p> : null}
          {holdbackNotice ? <p>{holdbackNotice}</p> : null}
        </section>
      ) : null}

      {org.quoteTermsText ? (
        <section className="terms">
          <h3>Terms</h3>
          <p>{org.quoteTermsText}</p>
        </section>
      ) : null}

      {org.insuranceStatement ? <p className="note">{org.insuranceStatement}</p> : null}

      <section className="signature">
        <div>
          <div className="rule" />
          <p>Accepted by</p>
        </div>
        <div>
          <div className="rule" />
          <p>Date</p>
        </div>
      </section>

      {org.documentFooterText ? <footer className="note">{org.documentFooterText}</footer> : null}
    </div>
  );
}

/**
 * Inline, and deliberately not Tailwind: this document is rendered by Chromium
 * over localhost and must not depend on a stylesheet request succeeding.
 * `break-inside: avoid` keeps a scope group off a page seam.
 */
const DOCUMENT_CSS = `
@page { margin: 18mm 16mm 20mm; }
.doc {
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  font-size: 10.5pt;
  line-height: 1.45;
  color: #16162b;
  background: #fff;
  max-width: 190mm;
  margin: 0 auto;
  padding: 8mm;
}
.doc h1, .doc h2, .doc h3 { font-family: 'IBM Plex Serif', Georgia, serif; margin: 0; }
.doc .num { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
.letterhead { display: flex; justify-content: space-between; gap: 12mm; border-bottom: 1.5pt solid #16162b; padding-bottom: 4mm; }
.logo { max-height: 22mm; max-width: 70mm; margin-bottom: 3mm; }
.company { font-size: 20pt; }
.tagline { font-style: italic; color: #5a5a72; margin: 1mm 0 2mm; }
.contact { color: #5a5a72; font-size: 9pt; margin: 0.5mm 0; }
.docmeta h2 { font-size: 14pt; text-align: right; margin-bottom: 2mm; }
.docmeta table { border-collapse: collapse; font-size: 9pt; }
.docmeta th { text-align: left; color: #5a5a72; font-weight: 400; padding-right: 4mm; }
.parties { display: flex; gap: 10mm; margin: 5mm 0; }
.parties h3 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.06em; color: #5a5a72; }
.parties p { margin: 1mm 0 0; }
table.lines { width: 100%; border-collapse: collapse; margin-top: 3mm; }
table.lines thead th { text-align: left; border-bottom: 1pt solid #16162b; padding: 2mm 0; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.06em; }
table.lines td { border-bottom: 0.5pt solid #e2e2ef; padding: 2.5mm 0; vertical-align: top; break-inside: avoid; }
table.lines ul { margin: 1mm 0 0 4mm; padding: 0; color: #5a5a72; font-size: 9.5pt; }
/* The per-trade heading row in full-detail mode: a break before the group's
   own lines, not another priced row, so it carries no bottom border. */
table.lines tr.group-header td { border-bottom: none; padding: 3mm 0 0.5mm; }
table.lines tr.group-header:first-child td { padding-top: 0; }
.right { text-align: right; }
table.totals { width: 70mm; margin-left: auto; margin-top: 4mm; border-collapse: collapse; }
table.totals th { text-align: left; font-weight: 400; color: #5a5a72; padding: 1mm 0; font-size: 9.5pt; }
table.totals .grand th, table.totals .grand td { border-top: 1pt solid #16162b; font-weight: 600; font-size: 12pt; padding-top: 2mm; }
.upgrades, .terms { margin-top: 6mm; break-inside: avoid; }
.upgrades h3, .terms h3 { font-size: 11pt; margin-bottom: 1mm; }
.note { color: #5a5a72; font-size: 9pt; }
.signature { display: flex; gap: 12mm; margin-top: 14mm; break-inside: avoid; }
.signature > div { flex: 1; }
.signature .rule { border-bottom: 0.75pt solid #16162b; height: 10mm; }
.signature p { font-size: 9pt; color: #5a5a72; margin: 1mm 0 0; }
footer.note { margin-top: 8mm; border-top: 0.5pt solid #e2e2ef; padding-top: 2mm; }
`;
