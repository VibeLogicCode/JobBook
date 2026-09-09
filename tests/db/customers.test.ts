import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import { costCodes, customers, projects } from '@/db/schema';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';

beforeEach(async () => {
  await db.execute(
    sql`truncate table stage_history, projects, customers, cost_codes restart identity cascade`,
  );
});

describe('customers', () => {
  it('defaults to a non-exempt customer with no assumed province', async () => {
    const [row] = await db
      .insert(customers)
      .values({ name: 'Eleanor Vance', customerType: 'residential' })
      .returning();
    expect(row?.isTaxExempt).toBe(false);
    // A schema default of 'ON' would hardcode a tenant's region. The UI
    // defaults this from organization.province instead.
    expect(row?.province).toBeNull();
  });

  it('stores an exemption number and reason together', async () => {
    const [row] = await db
      .insert(customers)
      .values({
        name: 'Regional Health',
        customerType: 'commercial',
        isTaxExempt: true,
        taxExemptNumber: 'EX-4471',
        taxExemptReason: 'Public body',
      })
      .returning();
    expect(row?.taxExemptNumber).toBe('EX-4471');
    expect(row?.taxExemptReason).toBe('Public body');
  });

  it('holds a second contact, because the spouse is who answers', async () => {
    const [row] = await db
      .insert(customers)
      .values({
        name: 'Eleanor Vance',
        customerType: 'residential',
        altContactName: 'Marcus Vance',
        altContactPhone: '555-0100',
      })
      .returning();
    expect(row?.altContactName).toBe('Marcus Vance');
  });
});

describe('projects', () => {
  async function seedCustomer() {
    const [customer] = await db
      .insert(customers)
      .values({ name: 'Eleanor Vance', customerType: 'residential' })
      .returning();
    return customer!;
  }

  it('keeps scheduled and actual dates as separate fields', async () => {
    const customer = await seedCustomer();
    const [row] = await db
      .insert(projects)
      .values({ companyId: FIRST_COMPANY_ID,
        customerId: customer.id,
        projectNumber: 'P-0001',
        name: 'Basement finish',
        projectTypeId: PROJECT_TYPE_IDS.basement,
        stage: 'lead',
        scheduledStart: '2026-09-01',
        scheduledEnd: '2026-11-15',
      })
      .returning();
    expect(row?.scheduledStart).toBe('2026-09-01');
    expect(row?.actualStart).toBeNull();
  });

  it('rejects a duplicate project number', async () => {
    const customer = await seedCustomer();
    const base = {
      customerId: customer.id,
      name: 'X',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'lead' as const,
    };
    await db.insert(projects).values({ companyId: FIRST_COMPANY_ID, ...base, projectNumber: 'P-0001' });
    await expect(
      db.insert(projects).values({ companyId: FIRST_COMPANY_ID, ...base, projectNumber: 'P-0001' }),
    ).rejects.toThrow();
  });

  it('stores no contract value, because it is derived from accepted quotes', async () => {
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'projects' and column_name like 'contract_value%'
    `);
    expect(rows).toHaveLength(0);
  });

  it('records the two Construction Act dates separately', async () => {
    const customer = await seedCustomer();
    const [row] = await db
      .insert(projects)
      .values({ companyId: FIRST_COMPANY_ID,
        customerId: customer.id,
        projectNumber: 'P-0002',
        name: 'Addition',
        projectTypeId: PROJECT_TYPE_IDS.addition,
        substantialPerformanceDate: '2026-10-01',
        certificatePublishedDate: '2026-10-06',
      })
      .returning();
    // The statutory clock runs from publication, not from certification.
    expect(row?.substantialPerformanceDate).toBe('2026-10-01');
    expect(row?.certificatePublishedDate).toBe('2026-10-06');
  });
});

describe('costCodes', () => {
  it('nests a section under a division', async () => {
    const [division] = await db
      .insert(costCodes)
      .values({ code: '06', name: 'Wood and Plastics' })
      .returning();
    const [section] = await db
      .insert(costCodes)
      .values({ code: '06-10', name: 'Rough Carpentry', parentId: division!.id })
      .returning();
    expect(section?.parentId).toBe(division?.id);
  });

  it('rejects a duplicate code', async () => {
    await db.insert(costCodes).values({ code: '06', name: 'Wood and Plastics' });
    await expect(
      db.insert(costCodes).values({ code: '06', name: 'Something else' }),
    ).rejects.toThrow();
  });
});
