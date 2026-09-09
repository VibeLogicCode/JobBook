import { describe, expect, it } from 'vitest';
import { AuthError } from '@/lib/auth/access';
import { soleOwnerFrom } from '@/lib/auth/sole-owner';

/**
 * The decision table behind a deployment that ships with no
 * `LOCAL_USER_EMAIL`.
 *
 * A per-customer compose file is not a product -- the owner's words:
 * "if i have to deploy this from git to 100 people i need to have 100 diff
 * compose files with their emails?" So the variable becomes optional, and when
 * it is absent the answer comes from the `users` table instead.
 *
 * The counting is pure and lives here so all four branches can be asserted
 * without a database. `tests/db/sole-owner.test.ts` covers the query and the
 * cache; this covers what the answer MEANS, which is the part that must not
 * drift.
 */
describe('soleOwnerFrom', () => {
  it('establishes no identity when there are no accounts', () => {
    // The bootstrap state. Nobody has claimed this deployment, so no request
    // may act as anybody -- and the setup wizard deliberately sits outside the
    // permission guard, so it still runs. That is what makes a fresh install
    // able to create its first user without an identity existing first.
    expect(soleOwnerFrom([])).toBeNull();
  });

  it('treats a single account as the owner of the deployment', () => {
    expect(soleOwnerFrom(['owner@example.com'])).toEqual({
      email: 'owner@example.com',
      local: true,
    });
  });

  it('REFUSES when more than one account exists', () => {
    // The branch that must never be guessed. With two accounts and nothing
    // naming which one a request belongs to, picking either would be silently
    // acting as a person who is not asking -- and in local mode there is no
    // password to distinguish them. Loud beats convenient.
    expect(() => soleOwnerFrom(['a@example.com', 'b@example.com'])).toThrow(AuthError);
    expect(() => soleOwnerFrom(['a@example.com', 'b@example.com'])).toThrow(/LOCAL_USER_EMAIL/);
  });

  it('names both the cause and the fix when it refuses', () => {
    // A refusal that does not say what to do is a support call. The message
    // has to survive being read on a NAS at 11pm by somebody who did not
    // write the deployment.
    let message = '';
    try {
      soleOwnerFrom(['a@example.com', 'b@example.com']);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/2 active/);
    expect(message).toMatch(/LOCAL_USER_EMAIL/);
  });

  it('counts three the same way it counts two', () => {
    expect(() => soleOwnerFrom(['a@x.com', 'b@x.com', 'c@x.com'])).toThrow(/3 active/);
  });
});
