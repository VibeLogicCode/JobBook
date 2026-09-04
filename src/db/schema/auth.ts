import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';
import { loginMethodEnum } from '@/db/enums';
import { users } from '@/db/schema/organization';

/**
 * Which provider account is linked to which user. Mirrored.
 *
 * A table rather than columns on `users` because a person's link changes over
 * time -- an administrator switches them from Google to Microsoft, or their
 * Workspace account is deleted and recreated with a new subject -- and each of
 * those is an event worth keeping. Columns would overwrite; rows are voided
 * with a reason and replaced, which is the pattern `tax_rates` already uses.
 *
 * Nothing here is a secret. A Google `sub` is a number that means nothing
 * outside Google, and an Entra `oid` is a directory GUID.
 */
export const userIdentities = pgTable('user_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  provider: loginMethodEnum('provider').notNull(),
  /** Google `sub`, Microsoft `oid`, Apple `sub`. Stable across email changes. */
  subject: text('subject').notNull(),
  /** Microsoft `tid`. NULL for Google and Apple. */
  tenantId: text('tenant_id'),
  /** What the provider reported when the link was made, for the audit trail. */
  emailAtLink: text('email_at_link').notNull(),
  emailVerifiedAtLink: boolean('email_verified_at_link').notNull().default(false),
  /** What the provider reported most recently. Information, never a credential. */
  lastSeenEmail: text('last_seen_email'),
  /** Apple's private relay address, which is not routable to a real inbox. */
  isPrivateEmail: boolean('is_private_email').notNull().default(false),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  ...auditColumns,
}, (t) => [
  // NULLS NOT DISTINCT is load-bearing: tenant_id is NULL for Google and
  // Apple, and under PostgreSQL's default NULLS DISTINCT the constraint would
  // be a no-op for two of the three providers -- every Google row would be
  // considered unique regardless of subject.
  //
  // A table constraint rather than a unique index, because Drizzle 0.45
  // exposes nullsNotDistinct() on unique() and not on uniqueIndex(). The SSO
  // spec says otherwise in its section 2.3; the spec is wrong on that detail.
  unique('user_identities_provider_subject_unique')
    .on(t.provider, t.tenantId, t.subject)
    .nullsNotDistinct(),
  // One ACTIVE identity per user. History is kept as voided rows.
  uniqueIndex('user_identities_one_active_per_user')
    .on(t.userId)
    .where(sql`record_status = 'active'`),
  index('user_identities_user_idx').on(t.userId),
]);

/**
 * Sessions. Local only, not mirrored, and carrying no audit columns: machine
 * state has no business in SharePoint, and a session row is as far from a tax
 * record as a table gets.
 *
 * Stateful on purpose. The whole administrative story is revocation -- an
 * administrator changes a login method, deactivates a person, or presses Sign
 * out everywhere, and the effect has to be immediate. A signed stateless
 * cookie cannot be revoked, only expired, and "your access ends within seven
 * days" is not what that button was pressed for.
 *
 * Nothing deletes from here. Two thousand rows a year, a few hundred bytes
 * each, does not justify a carve-out from the no-DELETE rule; rows past
 * `expires_at` are simply ignored.
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  /**
   * SHA-256 of the cookie value. The value itself is never stored, so a
   * database dump yields no cookie anybody can present.
   */
  tokenHash: text('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Advanced at most once per hour, so a busy afternoon costs one write. */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Absolute expiry, fixed at creation. There is no renewal past it. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
  userAgent: text('user_agent'),
  ip: text('ip'),
}, (t) => [
  uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
  index('sessions_user_idx').on(t.userId),
]);
