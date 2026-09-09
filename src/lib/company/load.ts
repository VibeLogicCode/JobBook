import { cache } from 'react';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies } from '@/db/schema';

export type Company = typeof companies.$inferSelect;

/**
 * Every company, in picker order.
 *
 * `cache()` for the reason `loadOrganization` gives: the root layout, a page
 * title and a page's own notice all want this within one request, and three
 * reads of a two-row table is three round trips for no reason. Per-request,
 * which is correct -- a company edited in Settings must be visible on the next
 * request, not after a deploy.
 *
 * Swallows errors to an EMPTY LIST, exactly as `loadOrganization` swallows to
 * null: a missing database is a setup problem, not a crash, and the caller
 * still has to render the screen that says so. Everything downstream of this
 * has to behave sensibly on an empty list for that reason -- see
 * `lib/posture/read.ts`, which turns it into the fuller form rather than the
 * shorter one.
 */
export const loadCompanies = cache(async (): Promise<Company[]> => {
  try {
    return await db
      .select()
      .from(companies)
      .where(eq(companies.recordStatus, 'active'))
      .orderBy(asc(companies.sortOrder), asc(companies.displayName));
  } catch {
    return [];
  }
});

/**
 * The company to default to when nothing in the request names one.
 *
 * The single ACTIVE company, or null when there are none or more than one.
 *
 * Null on ambiguity rather than "the first one": guessing which of two
 * registrants issued a document is precisely the mistake this whole change
 * exists to make impossible, and a caller that cannot name a company has to
 * ask rather than be handed one. The Input Tax Credit Information Regulations
 * put the supplier's own registration number on the invoice, so the wrong
 * guess makes the customer's tax credit defective.
 */
export const primaryCompany = cache(async (): Promise<Company | null> => {
  const active = (await loadCompanies()).filter((row) => row.isActive);
  return active.length === 1 ? active[0]! : null;
});

export async function loadCompany(id: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  return row ?? null;
}
