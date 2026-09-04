import { notFound } from 'next/navigation';
import { Worksheet } from '@/components/worksheet/Worksheet';
import { loadQuote } from '@/lib/quote/load';

export const dynamic = 'force-dynamic';

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadQuote(id);
  if (!data) notFound();

  return (
    <Worksheet
      quote={data.quote}
      lines={data.lines}
      taxes={data.taxes}
      rateItems={data.rateItems}
    />
  );
}
