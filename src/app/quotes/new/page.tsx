import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customers, leadSources, projects, projectTypes, quotes, scopeTemplates,
} from '@/db/schema';
import { defaultProvince } from '@/lib/company/load';
import { startQuote } from '@/app/quotes/new/actions';
import { StartQuoteForm } from '@/app/quotes/new/StartQuoteForm';
import { Panel } from '@/components/detail/Panel';
import { PageHeader } from '@/components/ui/PageHeader';

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
  /**
   * The province default comes from the issuing company's own address and
   * nowhere else. The column carries no database default because that would
   * hardcode one tenant's region into every deployment, and a contractor who
   * works across a border still has to be able to change it on the row in
   * front of them.
   *
   * Null when there is more than one company: two addresses have no single
   * answer, and a wrong pre-filled province is harder to notice than a blank
   * one, because nobody re-reads a field they did not have to fill in.
   */
  const province = await defaultProvince();
  const { customer, opportunity } = await searchParams;


  const [customerList, opportunityRows, templateList, projectTypeList, leadSourceList] = await Promise.all([
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
        projectTypeName: projectTypes.name,
      })
      .from(scopeTemplates)
      .innerJoin(projectTypes, eq(scopeTemplates.projectTypeId, projectTypes.id))
      .where(and(eq(scopeTemplates.recordStatus, 'active'), eq(scopeTemplates.isActive, true)))
      .orderBy(asc(scopeTemplates.name)),

    // Every project type, for the new-opportunity picker. Only active,
    // non-void ones: this is a brand-new opportunity, so there is no existing
    // value to append a retired option for, unlike the picker on an edit form.
    db
      .select({ id: projectTypes.id, name: projectTypes.name, isActive: projectTypes.isActive, recordStatus: projectTypes.recordStatus })
      .from(projectTypes)
      .where(eq(projectTypes.recordStatus, 'active'))
      .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name)),

    // Every lead source, for the new-customer picker. Same reasoning as
    // project types above: a brand-new customer has no existing value that
    // could be a retired one, so only active rows are ever offered.
    db
      .select({ id: leadSources.id, name: leadSources.name, isActive: leadSources.isActive, recordStatus: leadSources.recordStatus })
      .from(leadSources)
      .where(eq(leadSources.recordStatus, 'active'))
      .orderBy(asc(leadSources.sortOrder), asc(leadSources.name)),
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
      {/* No header action: on a form page the primary action IS the form's
          submit, and a second copy of it at the top would be a button that
          cannot say whether the fields below are filled in. */}
      <PageHeader
        title="New quote"
        description="A quote belongs to an opportunity, and an opportunity becomes a job once one of its quotes is accepted. Both can be created here."
      />

      <Panel title="Quote">
        <StartQuoteForm
          action={startQuote}
          customers={customerList}
          opportunities={opportunityList}
          templates={templateList}
          projectTypes={projectTypeList}
          leadSources={leadSourceList}
          defaultProvince={province ?? ''}
          preselectedCustomerId={preselected}
        />
      </Panel>
    </div>
  );
}
