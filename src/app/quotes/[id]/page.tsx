import type { Metadata } from 'next';
import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { projects, quoteClauses, quotes } from '@/db/schema';
import { AddReminderForm } from '@/components/reminders/AddReminderForm';
import { Acceptance } from '@/app/quotes/[id]/Acceptance';
import { loadRelations } from '@/app/quotes/[id]/related';
import { loadAcceptanceSiblings } from '@/app/quotes/[id]/siblings';
import { PageParentLink } from '@/components/ui/PageHeader';
import { Worksheet } from '@/components/worksheet/Worksheet';
import { flagsForQuote } from '@/lib/posture/read';
import { loadQuote } from '@/lib/quote/load';

export const dynamic = 'force-dynamic';

/**
 * Record first, tenant last: the quote number is what tells two open tabs
 * on the same job apart. `loadQuote` is `cache()`-wrapped, so this and the
 * page below share one read rather than paying for it twice.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const data = await loadQuote(id);
    if (!data) return { title: 'Quote' };
    return { title: `${data.quote.quoteNumber} — ${data.quote.projectName}` };
  } catch {
    return { title: 'Quote' };
  }
}

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // All five reads hit the same row set, so they go out together rather than
  // stacking round trips in front of the first paint. `flagsForQuote` joins
  // through to the project type rather than waiting on `loadQuote` for the
  // project id, which is the only reason it exists as its own reader.
  const [data, relations, siblings, owner, flags, clauses] = await Promise.all([
    loadQuote(id),
    loadRelations(id),
    loadAcceptanceSiblings(id),
    loadOwningProject(id),
    flagsForQuote(db, id),
    /**
     * The saved exclusions and assumptions, as suggestions for the sheet.
     *
     * Active and non-void only: a retired one is a sentence this company has
     * stopped putting on quotes, and the quotes that already carry its words
     * go on carrying them -- the text was copied onto the quote, never linked.
     */
    db
      .select({
        id: quoteClauses.id,
        kind: quoteClauses.kind,
        clauseText: quoteClauses.clauseText,
      })
      .from(quoteClauses)
      .where(and(eq(quoteClauses.isActive, true), eq(quoteClauses.recordStatus, 'active')))
      .orderBy(asc(quoteClauses.sortOrder), asc(quoteClauses.clauseText)),
  ]);
  if (!data) notFound();

  return (
    <>
      {/* A quote is the one document in the product that gets sent, bookmarked
          and reopened cold -- from a reminder, from the pipeline, from a link
          he mailed himself the night before. Arriving that way, the worksheet
          named the JOB in its <h1> but gave no route to it, so the record the
          quote belongs to was a name on screen and nowhere to press.

          Its own strip above the worksheet band rather than a slot inside it:
          the worksheet's header is a client component owning the quote's
          controls, and the way back is not a control of the quote. Same
          background, so the two read as one band; `no-print` because the
          customer's copy comes from /print and has no app to return to. */}
      {owner ? (
        <div className="no-print flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-surface px-4 pt-3 t-micro uppercase text-subtle sm:px-6">
          <PageParentLink
            href={`/projects/${owner.id}`}
            label={`${owner.projectNumber} · ${owner.name}`}
          />
          {/*
            * The next thing that happens to an accepted quote.
            *
            * Billing lives on the job, because a draw is the job's arithmetic
            * -- contract value, what was billed before, what is being
            * withheld. But the person who has just watched a customer accept
            * is looking at the QUOTE, and until now the route from here to
            * getting paid was: remember the job's name, go to the pipeline,
            * find it, open billing. Three screens to bill work that was
            * agreed on this one.
            *
            * Only on an accepted quote. A draft or a quote still out with the
            * customer has nothing to bill, and offering it would be inviting
            * somebody to invoice work nobody has agreed to.
            */}
          {data.quote.status === 'accepted' ? (
            <Link
              href={`/projects/${owner.id}/billing`}
              className="text-accent-text hover:underline"
            >
              Invoice this job
            </Link>
          ) : null}
        </div>
      ) : null}

      <Worksheet
        quote={data.quote}
        lines={data.lines}
        taxes={data.taxes}
        rateItems={data.rateItems}
        relations={relations}
        clauses={clauses}
        scopeInputs={flags.scopeInputs}
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

/**
 * The opportunity or job this quote was written against.
 *
 * Read here rather than folded into `loadQuote`: that loader builds the wire
 * shape the worksheet computes from, and the project's id and number are
 * navigation, not part of the document. It is a single indexed row on the join
 * the loader already makes, so it costs a round trip and nothing else.
 */
async function loadOwningProject(quoteId: string) {
  const [row] = await db
    .select({
      id: projects.id,
      projectNumber: projects.projectNumber,
      name: projects.name,
    })
    .from(quotes)
    .innerJoin(projects, eq(quotes.projectId, projects.id))
    .where(eq(quotes.id, quoteId));

  return row ?? null;
}
