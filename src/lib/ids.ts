/**
 * Is this string shaped like one of our identifiers?
 *
 * Every id in this product is a `uuid` column with `gen_random_uuid()` behind
 * it, so anything that is not this shape cannot name a row — and asking
 * Postgres about it is worse than not asking. A malformed id reaches the
 * driver as `invalid input syntax for type uuid`, which surfaces as a 500 and
 * an error page. A mistyped URL is not a server fault and should not be
 * reported as one; it is a 404.
 *
 * That is why the check exists at all. It is here rather than in six files
 * because it WAS in six files, each with its own copy of the same regex, which
 * is one edit away from six subtly different answers to "is this an id".
 *
 * Deliberately a shape check and nothing more. It does not care which UUID
 * version produced the value, because this product never asks: the row either
 * exists or it does not, and that question belongs to the database.
 *
 * The pattern is exported alongside the predicate because a zod schema wants
 * the pattern itself -- `z.string().regex(UUID, ...)`. No `g` flag, so `test`
 * carries no lastIndex between calls and two callers cannot interfere.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
