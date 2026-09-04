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
 */
export async function loadTaxRatesFor(tx: Tx): Promise<TaxRateInput[]> {
  const rows = await tx
    .select()
    .from(taxRates)
    .where(and(eq(taxRates.isActive, true), eq(taxRates.recordStatus, 'active')))
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
