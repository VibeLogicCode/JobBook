import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
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

  return (
    <div className="grid gap-4 px-4 py-4 sm:px-6">
      <PageHeader
        title="New customer"
        description="A quote is written against a job, and a job belongs to a customer, so this comes first."
      />

      <Panel title="Customer">
        <CustomerForm
          action={createCustomer}
          defaultProvince={org?.province ?? ''}
          cancelHref="/customers"
          submitLabel="Create customer"
        />
      </Panel>
    </div>
  );
}
