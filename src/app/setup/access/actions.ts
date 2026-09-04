'use server';

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '@/db/schema';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid, optionalText, requiredText } from '@/app/settings/validate';
import { persistStep } from '@/app/setup/persist';
import type { Executor } from '@/app/setup/state';
import {
  AuthConfigRefused,
  readAuthConfig,
  writeAuthConfig,
} from '@/lib/deploy/auth-config';
import {
  type PostureInput,
  entriesForPosture,
  isMultiTenantEndpoint,
  restartPlan,
} from '@/lib/deploy/posture';

/**
 * The access step: which deployment posture this box runs, and what it needs.
 *
 * ---------------------------------------------------------------------------
 * THE ONE STEP OF THIS WIZARD THAT WRITES A CREDENTIAL, AND IT WRITES IT TO A
 * FILE.
 *
 * Every other step writes to the database. This one must not: the `settings`
 * table is mirrored to SharePoint and dumped hourly to three destinations, so
 * a client secret or a tunnel token that arrived through this form and landed
 * in a row would be in every one of those copies, forever (design sections
 * 7.0 and 8.1). It goes to one file, on one volume, at mode 0600 --
 * `src/lib/deploy/auth-config.ts` -- and the only thing this action puts in
 * the database is the step marker, which is a timestamp.
 *
 * Nothing collected here is ever returned to a client component. The page
 * reads the file back through the redacting summariser, which reports whether
 * each secret is present and how long it is, and never its contents.
 * ---------------------------------------------------------------------------
 */

const accessLabels = {
  posture: 'Deployment posture',
  localUserEmail: 'Local user email',
  teamDomain: 'Team domain',
  accessAud: 'Access application audience',
  tunnelToken: 'Tunnel token',
  publicUrl: 'Public URL',
  googleClientId: 'Google client id',
  googleClientSecret: 'Google client secret',
  microsoftClientId: 'Microsoft client id',
  microsoftClientSecret: 'Microsoft client secret',
  microsoftTenantId: 'Microsoft directory (tenant) id',
};

/**
 * A pasted credential.
 *
 * Trimmed, because every console's copy button is a coin flip on trailing
 * whitespace. Interior spaces are ALLOWED: no provider issues a secret with a
 * space in it today, but refusing one would be the same mistake as a postal
 * code pattern -- a rule written for the values we happen to have seen, which
 * starts rejecting real ones the first time a provider changes its format. The
 * file format is what makes that safe, since it round-trips a space, a quote
 * and a `$` unchanged.
 *
 * Line breaks and control characters are refused, and that is not a taste
 * judgement: the file is line based, so a value carrying a newline could only
 * be stored truncated, and a credential silently cut short is a sign-in that
 * fails with nothing to point at.
 */
const credential = (max: number) =>
  requiredText(max).refine(
    (value) => !/[\r\n\t\0]/.test(value),
    'must be one line: this looks like a paste that took a line too many',
  );

/** The same optional shape, for a field only one branch of the form uses. */
const optionalCredential = (max: number) =>
  optionalText(max).refine(
    (value) => value === null || !/[\r\n\t\0]/.test(value),
    'must be one line: this looks like a paste that took a line too many',
  );

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const lanBranch = z.object({
  posture: z.literal('lan'),
  localUserEmail: requiredText(200)
    .transform((value) => value.toLowerCase())
    .refine((value) => EMAIL.test(value), 'must be an email address'),
});

/**
 * An https origin, with localhost as the one exception.
 *
 * Both halves matter. Cloudflare's team domain is where the Access signing
 * keys are fetched from, and `APP_PUBLIC_URL` is what every provider redirect
 * URI is built from and what the cross-origin refusal compares against -- so a
 * plain `http://` here is either an open door or a provider refusing the
 * redirect URI outright. Every one of the three providers refuses `http://`
 * outside localhost, and localhost is allowed because that is how the flow is
 * tested on a laptop before a domain exists.
 */
function isHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return url.hostname !== '';
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '[::1]');
}

const tunnelBranch = z.object({
  posture: z.literal('tunnel'),
  teamDomain: credential(200)
    // Trailing slashes stripped here rather than at every read: access.ts
    // builds `${domain}/cdn-cgi/access/certs` from this and also uses it as
    // the expected issuer, and a double slash makes the second comparison fail
    // in a way the first one does not.
    .transform((value) => value.replace(/\/+$/, ''))
    .refine(
      isHttpsOrigin,
      'must be the full https:// address of your Zero Trust team domain, the one the ' +
        'Access signing keys are fetched from',
    ),
  accessAud: credential(200).refine(
    (value) => !/\s/.test(value),
    'is a single opaque tag with no spaces in it — this looks like more than one value',
  ),
  tunnelToken: credential(4000),
});

const ssoBranch = z
  .object({
    posture: z.literal('sso'),
    publicUrl: credential(300)
      .transform((value) => value.replace(/\/+$/, ''))
      .refine(
        isHttpsOrigin,
        'must be the https:// origin people reach this deployment at. Every provider ' +
          'refuses a plain http:// redirect URI outside localhost, and it is never derived ' +
          'from the Host header — that is the classic route to an open redirect.',
      ),
    googleClientId: optionalCredential(300),
    googleClientSecret: optionalCredential(300),
    microsoftClientId: optionalCredential(300),
    microsoftClientSecret: optionalCredential(300),
    microsoftTenantId: optionalCredential(100).refine(
      (value) => value === null || !isMultiTenantEndpoint(value),
      'cannot be "common" or "organizations". On those endpoints any Entra directory in the ' +
        'world can mint a token this application would accept, and the email claim is then ' +
        'attacker-controlled: somebody creates a tenant, sets a user’s mail to the owner’s ' +
        'address, and the first-link match hands them the account. Use your directory’s GUID, ' +
        'or "consumers" for personal Microsoft accounts.',
    ),
  })
  .superRefine((value, ctx) => {
    const hasGoogle = value.googleClientId !== null;
    const hasMicrosoft = value.microsoftClientId !== null;

    if (!hasGoogle && !hasMicrosoft) {
      ctx.addIssue({
        code: 'custom',
        path: ['googleClientId'],
        message:
          'or a Microsoft client id is required: in this posture the application does its own ' +
          'signing in, and with no provider configured it refuses to boot rather than serve a ' +
          'sign-in page with no buttons on it',
      });
      return;
    }

    // A provider is configured when its client id is present, and a configured
    // provider missing any of its other variables refuses to BOOT (SSO spec
    // 7.2). Catching it here means the refusal is a red field beside the box
    // rather than a container that will not start.
    if (hasGoogle && value.googleClientSecret === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['googleClientSecret'],
        message: 'is required once a Google client id is set, or the deployment will not boot',
      });
    }
    if (hasMicrosoft && value.microsoftClientSecret === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['microsoftClientSecret'],
        message: 'is required once a Microsoft client id is set, or the deployment will not boot',
      });
    }
    if (hasMicrosoft && value.microsoftTenantId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['microsoftTenantId'],
        message:
          'is required once a Microsoft client id is set: a single directory is what makes the ' +
          'email claim in the token mean anything',
      });
    }
  });

/**
 * The three branches, keyed on the posture.
 *
 * A discriminated union rather than one object with everything optional,
 * because "which fields are required" is entirely decided by the choice at the
 * top -- and the alternative is a superRefine that reimplements the same
 * decision three times and disagrees with the page about it once.
 *
 * The form submits all three groups of fields, since all three are in the
 * document at once (there is no JavaScript on that page hiding any of them).
 * Zod objects strip what the chosen branch does not name, so the fields for a
 * posture nobody chose are ignored rather than validated.
 */
const accessSchema = z.discriminatedUnion('posture', [lanBranch, tunnelBranch, ssoBranch]);

/** The restart sentence, in the voice the success notice needs. */
function restartSentence(input: PostureInput): string {
  const plan = restartPlan(input.posture);
  const containers = plan.services.map((name) => `\`${name}\``).join(' and ');
  const first = plan.operatorMustFirst.length > 0 ? ` First: ${plan.operatorMustFirst[0]}` : '';
  return (
    `${first} Then restart ${containers} — ${plan.command}. Nothing here is in effect until ` +
    'you do: a process’s environment is fixed when it starts, this file is read at boot, and ' +
    'the application deliberately has no way to restart itself.'
  );
}

/**
 * Writes the posture.
 *
 * The order inside is deliberate. The file is written BEFORE the step marker,
 * so the only half-finished state this can leave is a written file with the
 * step still showing as unfinished -- which costs one re-submit and is
 * harmless, because the writer replaces the file wholesale. The other order
 * leaves a step reported as done with nothing configured, which is a
 * deployment that will not sign anybody in and a wizard that says it will.
 */
export async function saveAccessStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = accessSchema.safeParse(formValues(formData));
  if (!parsed.success) {
    return invalid(
      parsed.error,
      accessLabels,
      'Nothing was written. Some of these values need another look.',
    );
  }
  const submitted = parsed.data;

  return persistStep('access', async (tx) => {
    let input: PostureInput;

    if (submitted.posture === 'lan') {
      const email = submitted.localUserEmail;
      // Local mode is not exempt from authorization: the named identity is
      // looked up in `users` on every request exactly as a signed-in one would
      // be. Without a matching active row every screen renders read-only and
      // says so, which reads as a broken install rather than a missing row --
      // so it is refused here, where the address is still on screen.
      const [account] = await tx
        .select({ isActive: users.isActive, role: users.role })
        .from(users)
        .where(eq(users.email, email));

      if (!account) {
        return refused(
          `No user account has the address ${email}, so nothing was written. In this posture ` +
            'every request arrives as one named user and authorization is a lookup against the ' +
            'users table, so an address with no row behind it is a deployment where every ' +
            'screen is read-only. Use the address from the first-user step, or go back and ' +
            'change that one.',
        );
      }
      if (!account.isActive) {
        return refused(
          `The account for ${email} exists but is deactivated, so nothing was written. A ` +
            'deactivated row is refused on every request, in every mode.',
        );
      }

      input = { posture: 'lan', localUserEmail: email };
    } else if (submitted.posture === 'tunnel') {
      input = {
        posture: 'tunnel',
        teamDomain: submitted.teamDomain,
        accessAud: submitted.accessAud,
        tunnelToken: submitted.tunnelToken,
      };
    } else {
      // Carried over rather than regenerated: rotating the cookie secret
      // invalidates sign-ins in flight, and an installer fixing a typo in a
      // client id has no reason to expect somebody mid-sign-in to be bounced.
      let existingCookieSecret: string | null = null;
      try {
        existingCookieSecret = (await readAuthConfig())?.entries.get('SSO_COOKIE_SECRET') ?? null;
      } catch {
        // Unreadable is the same as absent for this purpose: a fresh secret is
        // minted below, and the write that follows reports the real problem.
      }

      input = {
        posture: 'sso',
        publicUrl: submitted.publicUrl,
        google:
          submitted.googleClientId && submitted.googleClientSecret
            ? { clientId: submitted.googleClientId, clientSecret: submitted.googleClientSecret }
            : null,
        microsoft:
          submitted.microsoftClientId &&
          submitted.microsoftClientSecret &&
          submitted.microsoftTenantId
            ? {
                clientId: submitted.microsoftClientId,
                clientSecret: submitted.microsoftClientSecret,
                tenantId: submitted.microsoftTenantId,
              }
            : null,
        cookieSecret: existingCookieSecret,
      };
    }

    let written;
    try {
      written = await writeAuthConfig(entriesForPosture(input));
    } catch (error) {
      // A refusal is a rule of the format and is reported as itself. Anything
      // else is a filesystem fact -- a read-only volume, a directory owned by
      // another uid -- and naming it beats a stack trace the browser turns
      // into an opaque digest.
      if (error instanceof AuthConfigRefused) {
        return refused(`Nothing was written. ${error.message}`);
      }
      return refused(
        'Nothing was written: the configuration file could not be saved. ' +
          `${error instanceof Error ? error.message : String(error)}. Check that the config ` +
          'volume is mounted and writable by the user this application runs as.',
      );
    }

    const count = written.keys.length;
    return saved(
      `${count} ${count === 1 ? 'value' : 'values'} written to ${written.path}, at ` +
        `permissions 0600 and mirrored nowhere.${restartSentence(input)}`,
    );
  });
}
