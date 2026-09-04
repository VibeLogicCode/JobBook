import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization, projects, quotes, scopeTemplates } from '@/db/schema';
import { startQuote } from '@/app/quotes/new/actions';
import { StartQuoteForm } from '@/app/quotes/new/StartQuoteForm';
import { Panel } from '@/components/detail/Panel';

export const dynamic = 'force-dynamic';

/**
 * The front door.
 *
 * Reachable with no customer and no opportunity in the database, because that
 * is the state of a fresh install and the first thing an owner wants to do is
 * price something. Both can be created from inside this one form.
 */
export default async function NewQuotePage({
  searchParams,
}: {
  /** Set when the quote is started from a customer or an opportunity. */
  searchParams: Promise<{ customer?: string; opportunity?: string }>;
}) {
  const { customer, opportunity } = await searchParams;

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

  const [customerList, opportunityRows, templateList] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.name, companyName: customers.companyName })
      .from(customers)
      // Void customers are absent rather than disabled: new work cannot be
      // booked to a closed record, and the action refuses it as well.
      .where(eq(customers.recordStatus, 'active'))
      .orderBy(asc(customers.name)),

    db
      .select({
        id: projects.id,
        customerId: projects.customerId,
        name: projects.name,
        projectNumber: projects.projectNumber,
        stage: projects.stage,
      })
      .from(projects)
      .where(eq(projects.recordStatus, 'active'))
      .orderBy(asc(projects.projectNumber)),

    db
      .select({
        id: scopeTemplates.id,
        name: scopeTemplates.name,
        projectType: scopeTemplates.projectType,
      })
      .from(scopeTemplates)
      .where(and(eq(scopeTemplates.recordStatus, 'active'), eq(scopeTemplates.isActive, true)))
      .orderBy(asc(scopeTemplates.name)),
  ]);

  // How many quotes already sit on each opportunity, so the picker can say so.
  // Grouped in one query rather than counted per row.
  const counts = opportunityRows.length
    ? await db
        .select({ projectId: quotes.projectId, quoteCount: count(quotes.id) })
        .from(quotes)
        .where(
          and(
            eq(quotes.recordStatus, 'active'),
            inArray(
              quotes.projectId,
              opportunityRows.map((row) => row.id),
            ),
          ),
        )
        .groupBy(quotes.projectId)
    : [];

  const countByProject = new Map(counts.map((row) => [row.projectId, Number(row.quoteCount)]));

  const opportunityList = opportunityRows.map((row) => ({
    ...row,
    quoteCount: countByProject.get(row.id) ?? 0,
  }));

  // An opportunity in the query string implies its customer, so the form opens
  // on the right pair rather than making the owner re-pick what they came from.
  const fromOpportunity = opportunityList.find((row) => row.id === opportunity);
  const preselected =
    fromOpportunity?.customerId ??
    (customerList.some((row) => row.id === customer) ? customer : undefined);

  return (
    <div className="grid max-w-4xl gap-4 px-4 py-4 sm:px-6">
      <header>
        <h1 className="t-title">New quote</h1>
        <p className="t-small text-muted">
          A quote belongs to an opportunity, and an opportunity becomes a job once one of its
          quotes is accepted. Both can be created here.
        </p>
      </header>

      <Panel title="Quote">
        <StartQuoteForm
          action={startQuote}
          customers={customerList}
          opportunities={opportunityList}
          templates={templateList}
          defaultProvince={org?.province ?? ''}
          preselectedCustomerId={preselected}
        />
      </Panel>
    </div>
  );
}
