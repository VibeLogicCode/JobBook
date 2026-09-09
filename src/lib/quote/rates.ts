import { and, asc, eq } from 'drizzle-orm';
import type { db as Database } from '@/db/client';
import { taxRates } from '@/db/schema';
import type { TaxRateInput } from '@/lib/quote/tax';

type Tx = Parameters<Parameters<typeof Database.transaction>[0]>[0];

/**
 * The active tax rates, in application order.
 *
 * One place, because three callers were about to grow their own copy of this
 * query and the ordering is load-bearing: `sortOrder` decides which rate a
 * compound rate compounds onto.
 *
 * Effective dating is NOT filtered here. The engine picks what was in force on
 * the quote's own date, which is a different question from what is configured
 * today, and answering it here would quietly make every quote use today's
 * rates.
 *
 * ---------------------------------------------------------------------------
 * THE COMPANY FILTER *IS* HERE, AND CANNOT BE ANYWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * Unlike effective dating, the company is not a question the engine can
 * answer. `computeTaxes` applies every rate it is handed that is in force, and
 * that is CORRECT rather than a bug: a GST+PST province needs exactly that,
 * and `isCompound` exists because Quebec stacks one on the other. So a second
 * province's tax and a second corporation's copy of the same tax are
 * indistinguishable once both are in the list -- nothing downstream can tell
 * them apart, and nothing downstream should try.
 *
 * Without this filter, the day a second company registered for HST every
 * quote in the deployment would have charged 26%. Silently, on a document a
 * customer signs, with the arithmetic entirely innocent.
 *
 * A rate belonging to another registrant is not a rate that was ever in force
 * on this document, at any date -- which is why this filter is different in
 * kind from the one deliberately left out above.
 */
export async function loadTaxRatesFor(tx: Tx, companyId: string): Promise<TaxRateInput[]> {
  const rows = await tx
    .select()
    .from(taxRates)
    .where(and(
      eq(taxRates.companyId, companyId),
      eq(taxRates.isActive, true),
      eq(taxRates.recordStatus, 'active'),
    ))
    .orderBy(asc(taxRates.sortOrder));

  return rows.map((row) => ({
    label: row.label,
    registrationNumber: row.registrationNumber,
    rateTenThou: row.rateTenThou,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    isCompound: row.isCompound,
    sortOrder: row.sortOrder,
  }));
}
