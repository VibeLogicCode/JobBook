import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { userIdentities, users } from '@/db/schema';
import { normaliseEmail, type VerifiedIdentity } from '@/lib/auth/oidc/flow';

/**
 * Turning a verified provider identity into a user of this application.
 *
 * Two rules carry the whole design.
 *
 * **Sign-in never creates a user.** An administrator adds people and chooses
 * their role; a quoting system with cost and margin on every line is not
 * something a stranger with a Google account should reach.
 *
 * **Email matches the FIRST sign-in only.** It is the single thing the app
 * knows about a person before they have ever signed in, so there is no
 * alternative for the first match. It is also mutable at the provider,
 * sometimes unverified, and with Apple sometimes a relay — so afterwards the
 * provider's stable subject is the key, and the email the provider reports is
 * information rather than a credential.
 */

export type SignInRefusal =
  | { kind: 'no-account'; email: string }
  | { kind: 'inactive' }
  | { kind: 'method-not-set' }
  | { kind: 'wrong-method'; expected: string }
  | { kind: 'already-linked' }
  | { kind: 'unverified-email' };

export type SignInOutcome =
  | { ok: true; userId: string; linked: 'existing' | 'new' }
  | { ok: false; refusal: SignInRefusal };

/**
 * Messages a person actually sees.
 *
 * Deliberately unhelpful about which of "no such account" and "wrong method"
 * happened where that would confirm an address exists — except that this app
 * has no self-service signup and its URL is not public, so telling somebody
 * their account has no method chosen saves a support call at no real cost.
 */
export function refusalMessage(refusal: SignInRefusal): string {
  switch (refusal.kind) {
    case 'no-account':
      return 'There is no account for this email address. Ask an administrator to add you.';
    case 'inactive':
      return 'This account has been deactivated.';
    case 'method-not-set':
      return 'An administrator has not chosen a sign-in method for this account yet.';
    case 'wrong-method':
      return `This account signs in with ${refusal.expected}. Use that instead.`;
    case 'already-linked':
      return 'This account is already linked to a different provider account. Ask an administrator to reset the link.';
    case 'unverified-email':
      return 'The provider did not confirm this email address, so it cannot be matched to an account.';
  }
}

export async function resolveSignIn(identity: VerifiedIdentity): Promise<SignInOutcome> {
  const email = normaliseEmail(identity.email);

  return db.transaction(async (tx) => {
    // The subject is the key once a link exists, so it is tried first --
    // before email, and regardless of what email the provider now reports. A
    // person whose address changed at the provider keeps their account.
    const [existing] = await tx
      .select({ identity: userIdentities, user: users })
      .from(userIdentities)
      .innerJoin(users, eq(userIdentities.userId, users.id))
      .where(
        and(
          eq(userIdentities.provider, identity.provider),
          eq(userIdentities.subject, identity.subject),
          eq(userIdentities.recordStatus, 'active'),
        ),
      );

    if (existing) {
      if (!existing.user.isActive || existing.user.recordStatus !== 'active') {
        return { ok: false, refusal: { kind: 'inactive' } };
      }
      if (existing.user.loginMethod && existing.user.loginMethod !== identity.provider) {
        // The administrator changed the method but this old link is still
        // active, which should not happen -- changing a method voids it. Refuse
        // rather than honour a link the administrator has moved away from.
        return {
          ok: false,
          refusal: { kind: 'wrong-method', expected: existing.user.loginMethod },
        };
      }

      await tx
        .update(userIdentities)
        .set({ lastSeenEmail: email, lastSignInAt: new Date() })
        .where(eq(userIdentities.id, existing.identity.id));

      return { ok: true, userId: existing.user.id, linked: 'existing' };
    }

    if (!identity.emailVerified) {
      return { ok: false, refusal: { kind: 'unverified-email' } };
    }

    const [user] = await tx.select().from(users).where(eq(users.email, email));
    if (!user) return { ok: false, refusal: { kind: 'no-account', email } };
    if (!user.isActive || user.recordStatus !== 'active') {
      return { ok: false, refusal: { kind: 'inactive' } };
    }
    if (!user.loginMethod) return { ok: false, refusal: { kind: 'method-not-set' } };
    if (user.loginMethod !== identity.provider) {
      return { ok: false, refusal: { kind: 'wrong-method', expected: user.loginMethod } };
    }

    const [alreadyLinked] = await tx
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(
        and(eq(userIdentities.userId, user.id), eq(userIdentities.recordStatus, 'active')),
      );
    if (alreadyLinked) {
      // A different provider account presenting the same address, trying to
      // take over an account that is already linked. The administrator resolves
      // this deliberately with Reset link.
      return { ok: false, refusal: { kind: 'already-linked' } };
    }

    await tx.insert(userIdentities).values({
      userId: user.id,
      provider: identity.provider,
      subject: identity.subject,
      tenantId: identity.tenantId,
      emailAtLink: email,
      emailVerifiedAtLink: identity.emailVerified,
      lastSeenEmail: email,
      isPrivateEmail: identity.isPrivateEmail,
      lastSignInAt: new Date(),
    });

    return { ok: true, userId: user.id, linked: 'new' };
  });
}
