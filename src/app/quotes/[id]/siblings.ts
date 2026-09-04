import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { quotes } from '@/db/schema';

/** One other estimate on the opportunity, still in play. */
export interface AcceptanceSibling {
  id: string;
  quoteNumber: string;
  sequence: number;
  status: 'draft' | 'sent';
  totalCents: number;
}

/**
 * The other estimates the customer could still say yes to.
 *
 * Loaded separately from `loadRelations` rather than folded into it: that
 * function answers "what is this quote attached to", which is navigation shown
 * on every quote, and this answers "what else is in the running", which only
 * matters at the moment of winning one.
 *
 * The filter here MUST match `declineOtherEstimates` in
 * `src/lib/quote/accept.ts`. The screen promises to decline a specific list of
 * quote numbers, and a promise that names three documents while the transaction
 * declines two is worse than no promise: the person walks away believing a
 * competing price is dead.
 */
export async function loadAcceptanceSiblings(quoteId: string): Promise<AcceptanceSibling[]> {
  const [self] = await db
    .select({
      projectId: quotes.projectId,
      kind: quotes.kind,
      sequence: quotes.sequence,
    })
    .from(quotes)
    .where(eq(quotes.id, quoteId));

  // A change order is never accepted through this path, so it never competes
  // with anything and needs no list.
  if (!self || self.kind !== 'estimate') return [];

  return db
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      sequence: quotes.sequence,
      status: quotes.status,
      totalCents: quotes.totalCents,
    })
    .from(quotes)
    .where(
      and(
        eq(quotes.projectId, self.projectId),
        eq(quotes.kind, 'estimate'),
        eq(quotes.recordStatus, 'active'),
        ne(quotes.sequence, self.sequence),
        inArray(quotes.status, ['draft', 'sent']),
      ),
    )
    .orderBy(asc(quotes.sequence))
    .then((rows) => rows.map((row) => ({ ...row, status: row.status as 'draft' | 'sent' })));
}
