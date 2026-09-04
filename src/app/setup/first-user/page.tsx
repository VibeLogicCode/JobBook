import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { saveFirstUserStep } from '@/app/setup/actions';
import { configuredOidcProviders } from '@/app/setup/environment';
import { requireOpenSetup } from '@/app/setup/guard';
import { OWNER_USER_ID_KEY } from '@/app/setup/state';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, ReadOnlyField, SelectField, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/settings/Notice';
import { StepPanel } from '@/components/setup/StepPanel';
import { authMode } from '@/lib/auth/mode';

export const dynamic = 'force-dynamic';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
};

/**
 * Step 6. The owner account.
 *
 * The role is not on this form. Step 6 exists to produce the identity that can
 * then grant every other role, and a role picker here would let the first
 * account be created as a bookkeeper — a deployment with no owner, where
 * nobody can grant the role back through the interface and recovery is a
 * script run on the box. The database enforces the other half of that rule:
 * the last active owner cannot be demoted or deactivated.
 */
export default async function FirstUserStepPage() {
  const gate = await requireOpenSetup('first-user');

  const existingId = gate.values.get(OWNER_USER_ID_KEY);
  const [existing] = existingId
    ? await db.select().from(users).where(eq(users.id, existingId))
    : [];

  let mode: 'access' | 'sso' | 'local' | 'unset';
  try {
    mode = authMode();
  } catch {
    mode = 'unset';
  }
  const providers = configuredOidcProviders();

  /**
   * The address this very request arrived as, offered as the default.
   *
   * Read from `x-identity-email`, which the proxy deletes from the inbound
   * request and rewrites only after verifying the Access token or the session
   * — so it is the verified identity and not something a browser can set.
   *
   * It matters beyond convenience: behind Cloudflare Access or SSO, an owner
   * row whose address is not the one the provider asserts cannot sign in at
   * all, and the failure looks like a broken installation rather than a
   * mistyped field.
   */
  const verifiedEmail = (await headers()).get('x-identity-email');

  return (
    <StepPanel slug="first-user" gate={gate}>
      <ActionForm action={saveFirstUserStep} submitLabel="Save owner account">
        {mode === 'local' ? (
          <Notice tone="warning" title="This deployment enforces no sign-in">
            Every request arrives as one address named in the environment, with no password, no
            provider and no session — a LAN or a laptop under test. The role below still
            applies: authorization is a lookup against this table on every request, and local
            mode is not exempt from it.{' '}
            {verifiedEmail ? (
              <>
                Requests are currently arriving as <span className="num">{verifiedEmail}</span>,
                so use that address here unless you also change the environment.
              </>
            ) : null}
          </Notice>
        ) : null}

        {mode === 'access' ? (
          <Notice tone="info" title="Sign-in is decided at the edge">
            Cloudflare Access authenticates before a request reaches this application, so there
            is no sign-in method to choose here — restricting a person to one identity provider
            is a rule in the Access policy. The address below must match what Access asserts,
            or this account cannot sign in.
          </Notice>
        ) : null}

        {mode === 'sso' && providers.length === 0 ? (
          <Notice tone="negative" title="No sign-in provider is configured">
            This deployment is set to sign people in itself, but no provider credentials are
            present in its environment. This account will exist and will not be able to sign
            in until an installer adds them — the environment check on the next step names the
            variables.
          </Notice>
        ) : null}

        <FieldGrid>
          <TextField
            name="displayName"
            label="Name"
            required
            maxLength={200}
            defaultValue={existing?.displayName}
            placeholder="The person's name"
            hint="Shown in the application. It is not used to decide anything."
          />
          <TextField
            name="email"
            label="Email"
            type="email"
            inputMode="email"
            required
            maxLength={200}
            defaultValue={existing?.email ?? verifiedEmail ?? ''}
            placeholder="The address they sign in with"
            hint="The row's identity, and the field that is unique. After a first successful sign-in, authentication keys on the provider's stable subject instead, because an email address changes."
          />
          <ReadOnlyField
            label="Role"
            value="Owner"
            hint="Not a choice. The first account has to be able to grant every other role, and a deployment whose only account is not an owner has no way back in through the interface."
          />
          {mode === 'sso' && providers.length > 0 ? (
            <SelectField
              name="loginMethod"
              label="Sign-in method"
              defaultValue={existing?.loginMethod}
              blankLabel="Not chosen yet"
              options={providers.map((provider) => ({
                value: provider,
                label: PROVIDER_LABELS[provider] ?? provider,
              }))}
              hint="Which provider this person signs in through. Only the providers with credentials in this deployment's environment are offered — a method that cannot work is a support call. Leaving it unchosen means this account cannot sign in yet."
            />
          ) : (
            <ReadOnlyField
              label="Sign-in method"
              value={
                mode === 'access'
                  ? 'Decided by the Access policy'
                  : mode === 'local'
                    ? 'None — the environment names the user'
                    : 'Unavailable until sign-in is configured'
              }
              hint="Per-user sign-in methods only mean something where this application does the signing in itself."
            />
          )}
        </FieldGrid>
      </ActionForm>
    </StepPanel>
  );
}
