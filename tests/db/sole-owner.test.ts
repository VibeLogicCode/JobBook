import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { AuthError } from '@/lib/auth/access';
import { forgetSoleOwner, resolveSoleOwner } from '@/lib/auth/sole-owner';

/**
 * The real query behind a deployment shipped with no `LOCAL_USER_EMAIL`.
 *
 * `tests/unit/sole-owner.test.ts` covers what each count MEANS. This covers
 * the parts only a database can: that the filter is on ACTIVE accounts, and
 * that the in-process cache cannot leave a stale answer in place across the
 * one transition that matters -- a second account appearing.
 */

beforeEach(async () => {
  await db.execute(sql`truncate table audit_log, users restart identity cascade`);
  forgetSoleOwner();
});

async function addUser(email: string, isActive = true) {
  await db.insert(users).values({ email, displayName: email, role: 'owner', isActive });
}

describe('resolveSoleOwner', () => {
  it('establishes no identity on an unclaimed deployment', async () => {
    expect(await resolveSoleOwner()).toBeNull();
  });

  it('resolves the single account', async () => {
    await addUser('owner@example.com');
    expect(await resolveSoleOwner()).toEqual({ email: 'owner@example.com', local: true });
  });

  it('ignores a deactivated account when counting', async () => {
    // The property that makes "deactivate the ones that should not be" a real
    // instruction rather than advice: the refusal message says to do it, so
    // doing it has to work.
    await addUser('owner@example.com');
    await addUser('left@example.com', false);
    expect(await resolveSoleOwner()).toEqual({ email: 'owner@example.com', local: true });
  });

  it('refuses two active accounts', async () => {
    await addUser('a@example.com');
    await addUser('b@example.com');
    await expect(resolveSoleOwner()).rejects.toThrow(AuthError);
  });

  it('reports the true count, not the number of rows it needed to decide', async () => {
    // An earlier draft read with `limit(2)`, which decides correctly and then
    // tells somebody with five accounts that he has two. A message that is
    // visibly wrong about the thing the reader can check is a message whose
    // instruction gets ignored too.
    for (const name of ['a', 'b', 'c', 'd', 'e']) await addUser(`${name}@example.com`);
    await expect(resolveSoleOwner()).rejects.toThrow(/5 active/);
  });

  it('does not cache the unclaimed state, so the first user works at once', async () => {
    // The installer finishes the first-user step and uses the product on his
    // next request. Caching "no accounts" would make him wait out a TTL on
    // the deployment he just set up, which reads as a broken install.
    expect(await resolveSoleOwner()).toBeNull();
    await addUser('owner@example.com');
    expect(await resolveSoleOwner()).toEqual({ email: 'owner@example.com', local: true });
  });

  it('goes on serving a cached answer until told to forget it', async () => {
    // Documents the cache as REAL rather than incidental -- the reason
    // `forgetSoleOwner` has call sites at every user write. Without them this
    // is what a second account would look like for up to a minute.
    await addUser('owner@example.com');
    expect(await resolveSoleOwner()).toEqual({ email: 'owner@example.com', local: true });

    await addUser('second@example.com');
    expect(await resolveSoleOwner()).toEqual({ email: 'owner@example.com', local: true });

    forgetSoleOwner();
    await expect(resolveSoleOwner()).rejects.toThrow(/2 active/);
  });
});
