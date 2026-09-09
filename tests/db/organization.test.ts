import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { auditLog, documentSequences, organization, settings, taxRates, users } from '@/db/schema';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { ensureCompany } from '../support/organization';
import { seedDeployment } from '../support/organization';

beforeEach(async () => {
  await db.execute(
    sql`truncate table audit_log, tax_rates, users, organization, companies, document_sequences, settings restart identity cascade`,
  );
  // Tax rates and document sequences both carry a NOT NULL company_id: a rate
  // belongs to a registrant and a series belongs to a company, so neither can
  // be inserted before one exists.
  await ensureCompany();
});

describe('organization', () => {
  it('permits exactly one row', async () => {
    await seedDeployment({ id: 1, legalName: 'Acme Ltd', displayName: 'Acme' });
    await expect(
      db.insert(organization).values({ id: 2, legalName: 'Other Ltd', displayName: 'Other' }),
    ).rejects.toThrow();
  });

  it('stores fiscal year end as month and day, not a fixed date', async () => {
    await seedDeployment({
      id: 1,
      legalName: 'Acme Ltd',
      displayName: 'Acme',
      fiscalYearEndMonth: 6,
      fiscalYearEndDay: 30,
    });
    const [row] = await db.select().from(organization);
    expect(row?.fiscalYearEndMonth).toBe(6);
    expect(row?.fiscalYearEndDay).toBe(30);
  });

  it('always has a timezone, because dates are computed in the tenant local day', async () => {
    await seedDeployment({ id: 1, legalName: 'Acme Ltd', displayName: 'Acme' });
    const [row] = await db.select().from(organization);
    expect(row?.timezone).toBeTruthy();
  });

  it('defers tax on holdback by default', async () => {
    await seedDeployment({ id: 1, legalName: 'Acme Ltd', displayName: 'Acme' });
    const [row] = await db.select().from(organization);
    expect(row?.taxDeferredOnHoldback).toBe(true);
  });

  it('is audited, despite having an integer primary key', async () => {
    // audit_log.record_id is text for exactly this reason. As uuid it could not
    // record the one table where every change is a branding, tax or holdback
    // setting, and the insert failed outright.
    await seedDeployment({ id: 1, legalName: 'Acme Ltd', displayName: 'Acme' });
    await db.update(organization).set({ phone: '555-0100' }).where(eq(organization.id, 1));
    const entries = await db.select().from(auditLog).where(eq(auditLog.recordId, '1'));
    expect(entries.map((e) => e.action)).toEqual(['insert', 'update']);
  });

  it('holds no document sequence counters of its own', async () => {
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'organization' and column_name like 'next_%_seq'
    `);
    expect(rows).toHaveLength(0);
  });
});

describe('taxRates', () => {
  it('stores a rate in ten-thousandths with an open effective window', async () => {
    await db.insert(taxRates).values({ companyId: FIRST_COMPANY_ID,
      label: 'HST',
      rateTenThou: 1300n,
      effectiveFrom: '2010-07-01',
      sortOrder: 1,
    });
    const [row] = await db.select().from(taxRates);
    expect(row?.rateTenThou).toBe(1300n);
    expect(row?.effectiveTo).toBeNull();
    expect(row?.isCompound).toBe(false);
  });

  it('keeps a superseded rate alongside its replacement', async () => {
    // Versioning, not editing in place: an old quote must still print the tax
    // it was signed at, and a filing period straddling a change must split.
    await db.insert(taxRates).values([
      { companyId: FIRST_COMPANY_ID, label: 'HST', rateTenThou: 1300n, effectiveFrom: '2010-07-01', effectiveTo: '2026-03-31' },
      { companyId: FIRST_COMPANY_ID, label: 'HST', rateTenThou: 1200n, effectiveFrom: '2026-04-01' },
    ]);
    const rows = await db.select().from(taxRates);
    expect(rows).toHaveLength(2);
  });
});

describe('users', () => {
  it('defaults every row to active', async () => {
    await db.insert(users).values({
      email: 'a@example.com',
      displayName: 'A',
      role: 'owner',
    });
    const [row] = await db.select().from(users);
    expect(row?.recordStatus).toBe('active');
    expect(row?.isActive).toBe(true);
  });

  it('rejects a duplicate email', async () => {
    const base = { email: 'a@example.com', displayName: 'A', role: 'owner' as const };
    await db.insert(users).values(base);
    await expect(db.insert(users).values(base)).rejects.toThrow();
  });
});

describe('documentSequences', () => {
  it('keys a counter by kind and year together', async () => {
    await db.insert(documentSequences).values([
      { companyId: FIRST_COMPANY_ID, kind: 'quote', year: 2026, nextSeq: 7 },
      { companyId: FIRST_COMPANY_ID, kind: 'invoice', year: 2026, nextSeq: 1 },
      { companyId: FIRST_COMPANY_ID, kind: 'quote', year: 2027, nextSeq: 1 },
    ]);
    const rows = await db.select().from(documentSequences);
    expect(rows).toHaveLength(3);
    await expect(
      db.insert(documentSequences).values({ companyId: FIRST_COMPANY_ID, kind: 'quote', year: 2026, nextSeq: 99 }),
    ).rejects.toThrow();
  });
});

describe('settings', () => {
  it('treats absence as the off state rather than defaulting a value', async () => {
    const rows = await db.select().from(settings);
    expect(rows).toEqual([]);
    await db.insert(settings).values({ key: 'update.last_check_at', value: '2026-09-04T12:00:00Z' });
    const [row] = await db.select().from(settings);
    expect(row?.key).toBe('update.last_check_at');
  });
});
