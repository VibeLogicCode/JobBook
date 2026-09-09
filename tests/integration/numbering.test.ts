import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { documentSequences, organization } from '@/db/schema';
import { allocateDocumentNumber, tenantYear } from '@/lib/quote/numbering';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { seedDeployment } from '../support/organization';

beforeEach(async () => {
  await db.execute(
    sql`truncate table audit_log, document_sequences, organization restart identity cascade`,
  );
  await seedDeployment({
    id: 1,
    legalName: 'Acme Ltd',
    displayName: 'Acme',
    timezone: 'America/Toronto',
  });
});

const allocate = (
  kind: 'quote' | 'project' | 'invoice' | 'change_order',
  year?: number,
  companyId: string = FIRST_COMPANY_ID,
) => db.transaction((tx) => allocateDocumentNumber(tx, kind, companyId, year));

describe('allocateDocumentNumber', () => {
  it('formats the prefix, year, and a zero-padded sequence', async () => {
    expect(await allocate('quote', 2026)).toBe('QT-2026-0001');
  });

  it('increments across sequential calls', async () => {
    expect(await allocate('quote', 2026)).toBe('QT-2026-0001');
    expect(await allocate('quote', 2026)).toBe('QT-2026-0002');
  });

  it('keeps a separate series per kind', async () => {
    // The counters were six columns on organization, and an earlier draft had
    // project numbers incrementing the invoice counter.
    expect(await allocate('quote', 2026)).toBe('QT-2026-0001');
    expect(await allocate('project', 2026)).toBe('P-2026-0001');
    expect(await allocate('invoice', 2026)).toBe('INV-2026-0001');
    expect(await allocate('change_order', 2026)).toBe('CO-2026-0001');
    expect(await allocate('quote', 2026)).toBe('QT-2026-0002');
  });

  it('restarts the sequence in a new year', async () => {
    await allocate('quote', 2026);
    await allocate('quote', 2026);
    expect(await allocate('quote', 2027)).toBe('QT-2027-0001');
    expect(await allocate('quote', 2026)).toBe('QT-2026-0003');
  });

  it('issues twenty unique numbers under concurrent allocation', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => allocate('quote', 2026)),
    );
    expect(new Set(numbers).size).toBe(20);
    expect(numbers.sort().at(-1)).toBe('QT-2026-0020');
  });

  it('does not burn a number when the transaction rolls back', async () => {
    await expect(
      db.transaction(async (tx) => {
        await allocateDocumentNumber(tx, 'quote', FIRST_COMPANY_ID, 2026);
        throw new Error('abandoned');
      }),
    ).rejects.toThrow('abandoned');
    expect(await allocate('quote', 2026)).toBe('QT-2026-0001');
  });

  it('honours a stored prefix over the built-in default', async () => {
    await db.insert(documentSequences).values({ companyId: FIRST_COMPANY_ID,
      kind: 'quote',
      year: 2026,
      nextSeq: 41,
      prefix: 'EST',
    });
    expect(await allocate('quote', 2026)).toBe('EST-2026-0041');
  });

  it('keeps the stored prefix when the counter advances', async () => {
    await db.insert(documentSequences).values({ companyId: FIRST_COMPANY_ID, kind: 'quote', year: 2026, prefix: 'EST' });
    await allocate('quote', 2026);
    const [row] = await db
      .select()
      .from(documentSequences)
      .where(eq(documentSequences.kind, 'quote'));
    expect(row?.prefix).toBe('EST');
  });
});

describe('tenantYear', () => {
  it('reads the year in the tenant timezone, not the container timezone', async () => {
    // A UTC container rolls the series over at 7pm Toronto on 31 December, so a
    // quote issued that evening would be numbered against the following year.
    await db.update(organization).set({ timezone: 'Pacific/Kiritimati' }).where(eq(organization.id, 1));
    const [expected] = (await db.execute(sql`
      select extract(year from (now() at time zone 'Pacific/Kiritimati'))::int as year
    `)) as unknown as { year: number }[];
    expect(await db.transaction((tx) => tenantYear(tx))).toBe(expected?.year);
  });

  it('defaults the series year from the tenant, with no year passed', async () => {
    const year = await db.transaction((tx) => tenantYear(tx));
    expect(await allocate('quote')).toBe(`QT-${year}-0001`);
  });

  it('refuses to allocate before setup has run', async () => {
    await db.execute(sql`truncate table audit_log, organization restart identity cascade`);
    await expect(allocate('quote')).rejects.toThrow(/run setup first/i);
  });
});
