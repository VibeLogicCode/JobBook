import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { trades, vendorTypes, vendors } from '@/db/schema';
import { DEFAULT_TRADES, DEFAULT_VENDOR_TYPES, seedVendorLists } from '@/db/seed/vendor-lists';

/**
 * `vendors.is_subcontractor` is derived, and this proves it against the real
 * database rather than against the code that usually writes it.
 *
 * The claim the whole change rests on is that the owner cannot restate a tax
 * rule by typing. Every assertion below is therefore made by writing SQL
 * DIRECTLY -- no server action, no zod schema, no form -- because a rule that
 * only holds when the application co-operates is not a rule. If somebody
 * later adds a code path that sets the column, or a psql session tries, the
 * trigger is what has to win.
 */

beforeEach(async () => {
  // Cascade, because expenses and assignments reference vendors. Each suite
  // seeds what it needs in its own beforeEach, so emptying them here costs
  // nothing and leaving stale vendors behind would make these counts lie.
  await db.execute(sql`truncate table vendors, vendor_types, trades restart identity cascade`);
});

const SUB = DEFAULT_VENDOR_TYPES.find((type) => type.isSubcontractor)!;
const SUPPLIER = DEFAULT_VENDOR_TYPES.find((type) => !type.isSubcontractor)!;
const TRADE = DEFAULT_TRADES[0]!;

async function readVendor(id: string) {
  const [row] = await db.select().from(vendors).where(eq(vendors.id, id));
  return row!;
}

describe('the seed', () => {
  it('loads both lists', async () => {
    await seedVendorLists();
    expect(await db.$count(vendorTypes)).toBe(DEFAULT_VENDOR_TYPES.length);
    expect(await db.$count(trades)).toBe(DEFAULT_TRADES.length);
  });

  it('is a no-op the second time, so a boot never restores an edited row', async () => {
    await seedVendorLists();
    await db
      .update(vendorTypes)
      .set({ name: 'Suppliers', isActive: false })
      .where(eq(vendorTypes.id, SUPPLIER.id));

    await seedVendorLists();

    const [row] = await db.select().from(vendorTypes).where(eq(vendorTypes.id, SUPPLIER.id));
    expect(row!.name).toBe('Suppliers');
    expect(row!.isActive).toBe(false);
    expect(await db.$count(vendorTypes)).toBe(DEFAULT_VENDOR_TYPES.length);
  });

  it('skips a default whose NAME a tenant row already holds', async () => {
    // Migration 0014 promoted every free-text `vendors.trade` value into this
    // table. A default that collided with one of those on `trades_name_unique`
    // has to be skipped rather than throw, which is why the conflict clause is
    // untargeted rather than keyed on the id.
    const [promoted] = await db
      .insert(trades)
      .values({ name: TRADE.name.toUpperCase() })
      .returning();

    await seedVendorLists();

    expect(await db.$count(trades)).toBe(DEFAULT_TRADES.length);
    const [kept] = await db.select().from(trades).where(eq(trades.id, promoted!.id));
    expect(kept!.name).toBe(TRADE.name.toUpperCase());
  });
});

describe('is_subcontractor, derived by trigger', () => {
  beforeEach(async () => {
    await seedVendorLists();
  });

  it('is set from the type on insert, without the insert mentioning it', async () => {
    const [row] = await db
      .insert(vendors)
      .values({ name: 'A crew', vendorTypeId: SUB.id })
      .returning();
    expect(row!.isSubcontractor).toBe(true);

    const [other] = await db
      .insert(vendors)
      .values({ name: 'A yard', vendorTypeId: SUPPLIER.id })
      .returning();
    expect(other!.isSubcontractor).toBe(false);
  });

  it('overrules a value the writer supplied, which is the whole point', async () => {
    // This is the hand-made POST, the stale tab and the well-meaning future
    // code path, all at once. The column is not an opinion anybody may state.
    const [row] = await db
      .insert(vendors)
      .values({ name: 'A yard', vendorTypeId: SUPPLIER.id, isSubcontractor: true })
      .returning();
    expect(row!.isSubcontractor).toBe(false);
  });

  it('follows the vendor when it is moved to another type', async () => {
    const [row] = await db
      .insert(vendors)
      .values({ name: 'A crew', vendorTypeId: SUPPLIER.id })
      .returning();

    await db
      .update(vendors)
      .set({ vendorTypeId: SUB.id })
      .where(eq(vendors.id, row!.id));

    expect((await readVendor(row!.id)).isSubcontractor).toBe(true);
  });

  it('cannot be flipped by an update that leaves the type alone', async () => {
    const [row] = await db
      .insert(vendors)
      .values({ name: 'A yard', vendorTypeId: SUPPLIER.id })
      .returning();

    await db.update(vendors).set({ isSubcontractor: true }).where(eq(vendors.id, row!.id));

    expect((await readVendor(row!.id)).isSubcontractor).toBe(false);
  });

  it('cannot be flipped by renaming the type either', async () => {
    // The failure the design exists to prevent: relabelling a row must never
    // restate who is owed a T5018. The screen offers no way to edit the flag,
    // and this proves that a rename alone changes nothing downstream.
    const [row] = await db
      .insert(vendors)
      .values({ name: 'A yard', vendorTypeId: SUPPLIER.id })
      .returning();

    await db
      .update(vendorTypes)
      .set({ name: 'Trade contractors' })
      .where(eq(vendorTypes.id, SUPPLIER.id));
    // Touch the vendor so the trigger runs against the renamed type.
    await db.update(vendors).set({ city: 'Somewhere' }).where(eq(vendors.id, row!.id));

    expect((await readVendor(row!.id)).isSubcontractor).toBe(false);
  });

  it('leaves a vendor that predates the list exactly as it was', async () => {
    // With no type there is nothing to derive from, and inventing one would be
    // inventing a tax filing. The form asks the next time such a row is saved.
    const [row] = await db
      .insert(vendors)
      .values({ name: 'From before', isSubcontractor: true })
      .returning();
    expect(row!.isSubcontractor).toBe(true);

    await db.update(vendors).set({ city: 'Somewhere' }).where(eq(vendors.id, row!.id));
    expect((await readVendor(row!.id)).isSubcontractor).toBe(true);
  });
});

describe('a retired or voided row still resolves', () => {
  beforeEach(async () => {
    await seedVendorLists();
  });

  it('keeps the sub on his trade after that trade is retired', async () => {
    const [row] = await db
      .insert(vendors)
      .values({ name: 'A crew', vendorTypeId: SUB.id, tradeId: TRADE.id })
      .returning();

    await db.update(trades).set({ isActive: false }).where(eq(trades.id, TRADE.id));

    const after = await readVendor(row!.id);
    expect(after.tradeId).toBe(TRADE.id);
    const [trade] = await db.select().from(trades).where(eq(trades.id, TRADE.id));
    expect(trade!.name).toBe(TRADE.name);
  });

  it('keeps the vendor on his type, and his standing, after that type is retired', async () => {
    const [row] = await db
      .insert(vendors)
      .values({ name: 'A crew', vendorTypeId: SUB.id })
      .returning();

    await db.update(vendorTypes).set({ isActive: false }).where(eq(vendorTypes.id, SUB.id));
    await db.update(vendors).set({ city: 'Somewhere' }).where(eq(vendors.id, row!.id));

    expect((await readVendor(row!.id)).isSubcontractor).toBe(true);
  });
});

describe('the housekeeping columns', () => {
  it('advances updated_at on both tables without the application setting it', async () => {
    // Both are mirrored tables, and a row that updates without moving the sync
    // cursor stops mirroring after its first change.
    await seedVendorLists();
    const [before] = await db.select().from(trades).where(eq(trades.id, TRADE.id));

    await db.execute(sql`select pg_sleep(0.01)`);
    await db.update(trades).set({ name: 'Site works' }).where(eq(trades.id, TRADE.id));

    const [after] = await db.select().from(trades).where(eq(trades.id, TRADE.id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it('refuses a second row whose name differs only by case', async () => {
    await db.insert(vendorTypes).values({ name: 'Equipment rental' });
    await expect(
      db.insert(vendorTypes).values({ name: 'EQUIPMENT RENTAL' }),
    ).rejects.toThrow();
  });
});
