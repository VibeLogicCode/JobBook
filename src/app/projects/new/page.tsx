import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projectTypes } from '@/db/schema';
import { defaultProvince, readCompanies } from '@/lib/company/load';
import { offeredWorkFrom, postureIsOffered } from '@/lib/posture/read';
import { createProject } from '@/app/projects/actions';
import { Panel } from '@/components/detail/Panel';
import { PageHeader } from '@/components/ui/PageHeader';
import { ProjectForm } from '@/components/detail/ProjectForm';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage({
  searchParams,
}: {
  /** Set when the job is started from a customer, so the field arrives filled. */
  searchParams: Promise<{ customer?: string }>;
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
  /**
   * Active companies only, and the form renders nothing when there is one.
   *
   * A retired company still resolves for every document it ever issued -- that
   * is what retiring rather than deleting is for -- but it must not be offered
   * on new work.
   */
  const companyRows = await readCompanies();
  const offeredCompanies = companyRows
    .filter((company) => company.isActive)
    .map((company) => ({
      id: company.id,
      // The code included, because it is what appears on every document the
      // choice produces.
      label: company.documentPrefix
        ? `${company.displayName} (${company.documentPrefix})`
        : company.displayName,
    }));
  const { customer } = await searchParams;


  const customerList = await db
    .select({ id: customers.id, name: customers.name, companyName: customers.companyName })
    .from(customers)
    // Void customers are absent rather than disabled: new work cannot be
    // booked to a closed record, and the action refuses it as well.
    .where(eq(customers.recordStatus, 'active'))
    .orderBy(asc(customers.name));

  const preselected = customerList.some((row) => row.id === customer) ? customer : undefined;

  // Only active, non-void: this is a brand-new opportunity, so there is no
  // existing value to append a retired option for.
  const projectTypeRows = await db
    .select({
      id: projectTypes.id, name: projectTypes.name, isActive: projectTypes.isActive,
      recordStatus: projectTypes.recordStatus, posture: projectTypes.posture,
    })
    .from(projectTypes)
    .where(eq(projectTypes.recordStatus, 'active'))
    .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name));

  /**
   * Only the kinds of work this deployment takes on. A contract-tagged type
   * stays in the table under a service-only company -- switching back to
   * `Both` re-offers it, which a pack that never inserted it could not do --
   * but it is not offered here.
   *
   * `createProject` does not refuse one that is submitted anyway: posture is
   * not a permission, and `lib/project-lists/guards.ts` settled this shape for
   * retired rows already. Filtered from the picker, accepted if it arrives.
   */
  const offered = offeredWorkFrom(companyRows);
  const projectTypeList = projectTypeRows.filter((row) => postureIsOffered(row.posture, offered));

  return (
    <div className="grid max-w-4xl gap-4 px-4 py-4 sm:px-6">
      <PageHeader
        title="New opportunity"
        description={
          <>
            Holds every quote for one piece of work, and becomes a job when one of them is
            accepted. Usually there is no need to come here:{' '}
            <Link href="/quotes/new" className="text-accent-text hover:underline">
              starting a quote
            </Link>{' '}
            creates the opportunity with it.
          </>
        }
      />

      <Panel title="Opportunity">
        {customerList.length === 0 ? (
          <p className="p-2 t-small text-muted">
            No customers yet, and an opportunity belongs to one.{' '}
            <Link href="/customers/new" className="text-accent-text hover:underline">
              Create a customer first
            </Link>
            .
          </p>
        ) : (
          <ProjectForm
            action={createProject}
            project={preselected ? { customerId: preselected } : undefined}
            customers={customerList}
            projectTypes={projectTypeList}
            companies={offeredCompanies}
            // The site province defaults from the organization record. The
            // column has no database default on purpose: one there would
            // hardcode a tenant's region into every deployment.
            defaultProvince={province ?? ''}
            cancelHref="/projects"
            submitLabel="Create opportunity"
          />
        )}
      </Panel>
    </div>
  );
}
