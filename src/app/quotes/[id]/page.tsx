import { notFound } from 'next/navigation';
import { loadRelations } from '@/app/quotes/[id]/related';
import { Worksheet } from '@/components/worksheet/Worksheet';
import { loadQuote } from '@/lib/quote/load';

export const dynamic = 'force-dynamic';

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Both reads hit the same row set, so they go out together rather than
  // stacking two round trips in front of the first paint.
  const [data, relations] = await Promise.all([loadQuote(id), loadRelations(id)]);
  if (!data) notFound();

  return (
    <Worksheet
      quote={data.quote}
      lines={data.lines}
      taxes={data.taxes}
      rateItems={data.rateItems}
      relations={relations}
    />
  );
}
