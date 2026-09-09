import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { leadSources } from '@/db/schema';
import { defaultProvince } from '@/lib/company/load';
import { createCustomer } from '@/app/customers/actions';
import { CustomerForm } from '@/components/detail/CustomerForm';
import { Panel } from '@/components/detail/Panel';
import { PageHeader } from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
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
          defaultProvince={province ?? ''}
          cancelHref="/customers"
          submitLabel="Create customer"
        />
      </Panel>
    </div>
  );
}
