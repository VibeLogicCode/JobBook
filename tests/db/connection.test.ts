import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';

describe('database connection', () => {
  it('answers a trivial query', async () => {
    const rows = await db.execute(sql`select 1 as one`);
    expect(rows[0]).toEqual({ one: 1 });
  });

  it('is pointed at the test database, not the development one', async () => {
    const rows = await db.execute(sql`select current_database() as name`);
    expect(rows[0]?.name).toBe('quote_test');
  });
});
