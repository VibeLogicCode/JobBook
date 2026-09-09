import { eq, sql } from 'drizzle-orm';
import { companies } from '@/db/schema';
import type { db as Database } from '@/db/client';

type Tx = Parameters<Parameters<typeof Database.transaction>[0]>[0];

/** Every numbered document series. Each keeps its own counter per year. */
export type DocumentKind = 'quote' | 'change_order' | 'project' | 'invoice' | 'purchase_order';

/**
 * Fallback codes, used only until the tenant sets its own in setup. These are
 * document codes rather than branding, so a default is safe -- but the stored
 * prefix always wins, and it is stored per year so renaming a series mid-year
 * leaves last year's numbers alone.
 */
const DEFAULT_PREFIX: Record<DocumentKind, string> = {
  quote: 'QT',
  change_order: 'CO',
  project: 'P',
  invoice: 'INV',
  purchase_order: 'PO',
};

/**
 * The tenant's current year, in the tenant's own timezone.
 *
 * `new Date().getUTCFullYear()` in a UTC container rolls the series over on 31
 * December at 7pm Toronto, so a quote issued that evening would be numbered
 * against next year while the accounts still call it this year.
 */
export async function tenantYear(tx: Tx): Promise<number> {
  const rows = await tx.execute(sql`
    select extract(year from (now() at time zone coalesce(o.timezone, 'UTC')))::int as year
    from organization o
    where o.id = 1
  `);
  const year = (rows as unknown as { year: number }[])[0]?.year;
  if (year === undefined) {
    throw new Error('organization row is missing; run setup first');
  }
  return year;
}

/**
 * Allocates the next number in a series, formatted `PREFIX-YYYY-0001`.
 *
 * One statement, so two concurrent callers cannot both read the same counter:
 * INSERT ... ON CONFLICT DO UPDATE takes the row lock and increments in place.
 * A read-then-write would let both read the same value and issue duplicate
 * document numbers -- a defect the customer finds, on paper, after the fact.
 *
 * Must be called inside the transaction that inserts the record, so a
 * rolled-back quote does not burn a number.
 *
 * ---------------------------------------------------------------------------
 * ONE SERIES PER COMPANY, AND WHY `companyId` COMES BEFORE `year`
 * ---------------------------------------------------------------------------
 *
 * Each company gets its own sequential series, which is what an auditor asks a
 * registrant for. Company one keeps its history and company two starts at
 * 0001; nothing is ever renumbered, and the existing principle that a gap is
 * the record of a voided document stays true PER COMPANY.
 *
 * `companyId` is a required positional BEFORE the optional `year` so that no
 * call site can pass one where the other belongs. Both are scalars, and a
 * mix-up would silently allocate against a series keyed by a uuid read as a
 * year -- which would succeed, and produce a document numbered from the wrong
 * counter.
 *
 * `tenantYear` still reads `organization.timezone` and is deliberately NOT
 * per-company: two companies sharing one office cannot disagree about what
 * year it is without one of them being wrong.
 */
export async function allocateDocumentNumber(
  tx: Tx,
  kind: DocumentKind,
  companyId: string,
  year?: number,
): Promise<string> {
  const seriesYear = year ?? (await tenantYear(tx));

  /**
   * This company's code, then the kind's: `RENO_QT`, or plain `QT` when the
   * company has no code of its own.
   *
   * The kind code is never REPLACED, only prefixed. A quote and a change order
   * are both rows in `quotes` and share the `quote_number` unique index, so a
   * flat per-company code would number both `RENO_-2026-0001`.
   *
   * The underscore lives here rather than in the stored value, so a prefix
   * typed as `RENO_` cannot become `RENO__QT` and two companies cannot
   * disagree about the separator.
   *
   * Null -- every existing installation and every single-company one -- leaves
   * this exactly as it was.
   */
  const [company] = await tx
    .select({ prefix: companies.documentPrefix })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) throw new Error(`company ${companyId} not found`);

  const code = company.prefix?.trim();
  const fallback = code ? `${code}_${DEFAULT_PREFIX[kind]}` : DEFAULT_PREFIX[kind];

  // next_seq holds the number to issue NEXT, so the row is created at 2 with 1
  // handed out, and the returned value is always one past what was allocated.
  const rows = await tx.execute(sql`
    insert into document_sequences (company_id, kind, year, next_seq, prefix, updated_at)
    values (${companyId}, ${kind}, ${seriesYear}, 2, ${fallback}, now())
    on conflict (company_id, kind, year) do update
      set next_seq = document_sequences.next_seq + 1, updated_at = now()
    returning next_seq, prefix
  `);

  const row = (rows as unknown as { next_seq: number; prefix: string | null }[])[0];
  if (!row) throw new Error(`failed to allocate a ${kind} number`);

  const seq = row.next_seq - 1;
  const prefix = row.prefix ?? fallback;
  return `${prefix}-${seriesYear}-${String(seq).padStart(4, '0')}`;
}
