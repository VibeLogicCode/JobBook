import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization } from '@/db/schema';
import { createProject } from '@/app/projects/actions';
import { Panel } from '@/components/detail/Panel';
import { ProjectForm } from '@/components/detail/ProjectForm';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage({
  searchParams,
}: {
  /** Set when the job is started from a customer, so the field arrives filled. */
  searchParams: Promise<{ customer?: string }>;
}) {
  const { customer } = await searchParams;

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

  const customerList = await db
    .select({ id: customers.id, name: customers.name, companyName: customers.companyName })
    .from(customers)
    // Void customers are absent rather than disabled: new work cannot be
    // booked to a closed record, and the action refuses it as well.
    .where(eq(customers.recordStatus, 'active'))
    .orderBy(asc(customers.name));

  const preselected = customerList.some((row) => row.id === customer) ? customer : undefined;

  return (
    <div className="grid max-w-4xl gap-4 px-4 py-4 sm:px-6">
      <header>
        <h1 className="t-title">New opportunity</h1>
        <p className="t-small text-muted">
          Holds every quote for one piece of work, and becomes a job when one of them is accepted.
          Usually there is no need to come here:{' '}
          <Link href="/quotes/new" className="text-accent-text hover:underline">
            starting a quote
          </Link>{' '}
          creates the opportunity with it.
        </p>
      </header>

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
            // The site province defaults from the organization record. The
            // column has no database default on purpose: one there would
            // hardcode a tenant's region into every deployment.
            defaultProvince={org?.province ?? ''}
            cancelHref="/projects"
            submitLabel="Create opportunity"
          />
        )}
      </Panel>
    </div>
  );
}
