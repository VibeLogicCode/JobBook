import { notFound } from 'next/navigation';
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
      {/* Below the document, because the lines are what the decision is about:
          the owner reads down the quote and converts it at the end of it. The
          band renders nothing at all unless this quote can still be won. */}
      <Acceptance quote={data.quote} lines={data.lines} siblings={siblings} />
    </>
  );
}
