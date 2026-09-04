import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { quotes, scopeTemplates } from '@/db/schema';
import type { WireQuoteRef, WireRelations } from '@/components/worksheet/types';

const REF = {
  id: quotes.id,
  quoteNumber: quotes.quoteNumber,
  sequence: quotes.sequence,
  status: quotes.status,
  reason: quotes.reason,
  scheduleImpactDays: quotes.scheduleImpactDays,
  totalCents: quotes.totalCents,
} as const;

/**
 * What the worksheet header needs to place this quote in the job.
 *
 * Loaded here rather than folded into `loadQuote`: a change order's parent and
 * an estimate's change orders are navigation, not part of the document the
 * engine computed, and the worksheet renders both kinds from the same view.
 */
export async function loadRelations(quoteId: string): Promise<WireRelations> {
  const [self] = await db
    .select({
      parentQuoteId: quotes.parentQuoteId,
      reason: quotes.reason,
      scheduleImpactDays: quotes.scheduleImpactDays,
      templateName: scopeTemplates.name,
    })
    .from(quotes)
    .leftJoin(scopeTemplates, eq(quotes.scopeTemplateId, scopeTemplates.id))
    .where(eq(quotes.id, quoteId));

  if (!self) {
    return { parent: null, changeOrders: [], amendment: null, templateName: null };
  }

  const [parentRows, changeOrders] = await Promise.all([
    self.parentQuoteId
      ? db.select(REF).from(quotes).where(eq(quotes.id, self.parentQuoteId))
      : Promise.resolve([] as WireQuoteRef[]),
    // Voided change orders are hidden, never deleted -- they stay on the
    // record and out of the header, which is a navigation aid.
    db
      .select(REF)
      .from(quotes)
      .where(and(eq(quotes.parentQuoteId, quoteId), eq(quotes.recordStatus, 'active')))
      .orderBy(asc(quotes.sequence)),
  ]);

  return {
    parent: parentRows[0] ?? null,
    changeOrders,
    amendment: self.parentQuoteId
      ? { reason: self.reason, scheduleImpactDays: self.scheduleImpactDays }
      : null,
    templateName: self.templateName ?? null,
  };
}
