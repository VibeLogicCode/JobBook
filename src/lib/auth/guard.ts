import { headers } from 'next/headers';
import {
  PermissionError,
  requireCapability as requireCanonicalCapability,
  type Actor,
  type Capability,
} from '@/lib/auth/permissions';

/**
 * The guard a server action opens with.
 *
 * Authorization is a separate lookup from authentication, on every request
 * that changes anything (SSO design, section 10.1). The proxy establishes WHO
 * is asking and writes it to `x-identity-email`; this decides what they may
 * do, from their role, and never from anything the browser sent.
 *
 * It returns a result rather than throwing, because a server action's caller
 * is a form and a refusal is a sentence for a person to read -- not a stack
 * trace in a log with a blank screen in front of them.
 */

export type GuardResult =
  | { ok: true; actor: Actor }
  | { ok: false; error: string };

export async function guard(capability: Capability): Promise<GuardResult> {
  const email = (await headers()).get('x-identity-email');
  if (!email) {
    // Deny by default. This header is written by the proxy after it has
    // verified an Access token or read a session, and is deleted from the
    // inbound request first, so its absence means nothing established an
    // identity for this request.
    return { ok: false, error: 'This request carries no verified identity.' };
  }

  try {
    const actor = await requireCanonicalCapability({ email, local: false }, capability);
    return { ok: true, actor };
  } catch (error) {
    if (error instanceof PermissionError) {
      return { ok: false, error: refusalText(error, email) };
    }
    throw error;
  }
}

function refusalText(error: PermissionError, email: string): string {
  switch (error.reason) {
    case 'no-account':
      return `There is no account for ${email}. Ask an administrator to add you.`;
    case 'inactive':
      return 'This account has been deactivated.';
    case 'not-permitted':
      return 'Your role does not permit that.';
  }
}
