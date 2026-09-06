import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { leadSources, organization } from '@/db/schema';
import { createCustomer } from '@/app/customers/actions';
import { CustomerForm } from '@/components/detail/CustomerForm';
import { Panel } from '@/components/detail/Panel';
import { PageHeader } from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  /**
   * The province default comes from the organization record and nowhere else.
   * The column carries no database default because that would hardcode one
   * tenant's region into every deployment, and a contractor who works across a
   * border still has to be able to change it on the row in front of them.
   */
  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

  // Only active, non-void: this is a brand-new customer, so there is no
  // existing value to append a retired option for.
  const leadSourceList = await db
    .select({ id: leadSources.id, name: leadSources.name, isActive: leadSources.isActive, recordStatus: leadSources.recordStatus })
    .from(leadSources)
    .where(eq(leadSources.recordStatus, 'active'))
    .orderBy(asc(leadSources.sortOrder), asc(leadSources.name));

  return (
    <div className="grid gap-4 px-4 py-4 sm:px-6">
      <PageHeader
        title="New customer"
        description="A quote is written against a job, and a job belongs to a customer, so this comes first."
      />

      <Panel title="Customer">
        <CustomerForm
          action={createCustomer}
          leadSources={leadSourceList}
          defaultProvince={org?.province ?? ''}
          cancelHref="/customers"
          submitLabel="Create customer"
        />
      </Panel>
    </div>
  );
}
