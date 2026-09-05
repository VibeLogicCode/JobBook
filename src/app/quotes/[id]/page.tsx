import { notFound } from 'next/navigation';
import { AddReminderForm } from '@/components/reminders/AddReminderForm';
import { Acceptance } from '@/app/quotes/[id]/Acceptance';
import { loadRelations } from '@/app/quotes/[id]/related';
import { loadAcceptanceSiblings } from '@/app/quotes/[id]/siblings';
import { Worksheet } from '@/components/worksheet/Worksheet';
import { loadQuote } from '@/lib/quote/load';

export const dynamic = 'force-dynamic';

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // All three reads hit the same row set, so they go out together rather than
  // stacking three round trips in front of the first paint.
  const [data, relations, siblings] = await Promise.all([
    loadQuote(id),
    loadRelations(id),
    loadAcceptanceSiblings(id),
  ]);
  if (!data) notFound();

  return (
    <>
      <Worksheet
        quote={data.quote}
        lines={data.lines}
        taxes={data.taxes}
        rateItems={data.rateItems}
        relations={relations}
      />
      {/* Its own band rather than a slot in `Acceptance`, which renders
          nothing at all once a quote is won, declined or superseded. Chasing
          is exactly what a quote sitting unanswered needs, and "remind me
          about this one" outlives the decision it was waiting on. */}
      <section className="no-print border-t border-line px-4 py-3 sm:px-6">
        <AddReminderForm
          entityType="quote"
          entityId={data.quote.id}
          label={data.quote.quoteNumber}
        />
      </section>

      {/* Below the document, because the lines are what the decision is about:
          the owner reads down the quote and converts it at the end of it. The
          band renders nothing at all unless this quote can still be won. */}
      <Acceptance quote={data.quote} lines={data.lines} siblings={siblings} />
    </>
  );
}
