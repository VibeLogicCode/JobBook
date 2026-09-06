import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';

/**
 * The single organization row, read once per request.
 *
 * `cache()` so every reader in the same request -- the root layout's title
 * and shell, and a page that also needs the tenant's name for its own title
 * or its own "not set up" notice -- shares this one read rather than each
 * running its own.
 */
export const loadOrganization = cache(async () => {
  try {
    const [row] = await db.select().from(organization).where(eq(organization.id, 1));
    return row ?? null;
  } catch {
    // A missing database is a setup problem, not a crash: callers still
    // render so the person can read the message telling them what to do.
    return null;
  }
});
