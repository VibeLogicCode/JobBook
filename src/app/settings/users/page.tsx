import { and, asc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db/client';
import { userIdentities, users } from '@/db/schema';
import { can, resolveActor } from '@/app/settings/actor';
import { addUser, setUserActive, setUserRole } from '@/app/settings/users/actions';
import {
  PROVIDER_LABELS,
  accessTeamDomain,
  authMode,
  configuredProviders,
  localUserEmail,
} from '@/app/settings/users/sign-in-mode';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, SelectField, TextField } from '@/components/settings/Fields';
import { InlineSelectForm } from '@/components/settings/InlineSelectForm';
import { Notice } from '@/components/settings/Notice';
import { Section } from '@/components/settings/Section';
import { Pill } from '@/components/ui/Pill';

export const dynamic = 'force-dynamic';

const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'bookkeeper', label: 'Bookkeeper' },
];

/** What each role may do, from the authorization matrix. Shown, not hidden in a doc. */
const ROLE_SUMMARY: Record<string, string> = {
  owner:
    'Everything, including tax rates, company identity and document text, backups and the mirror.',
  admin:
    'Runs the office: customers, projects, quotes, rate items, cost codes, scope templates and users — but not tax rates or the company’s own identity.',
  bookkeeper:
    'Reads everything including cost and margin, and generates documents. Changes no priced record.',
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ inactive?: string }>;
}) {
  const { inactive } = await searchParams;
  const showInactive = inactive === '1';

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'users.manage') : false;
  const mode = authMode();
  const providers = configuredProviders();

  // The active identity row, if any, says whether a person has ever actually
  // signed in. It is a separate table because a link changes over time and
  // each change is worth keeping -- the old row is voided, not overwritten.
  const rows = await db
    .select({ user: users, identity: userIdentities })
    .from(users)
    .leftJoin(
      userIdentities,
      and(eq(userIdentities.userId, users.id), eq(userIdentities.recordStatus, 'active')),
    )
    .orderBy(asc(users.displayName));

  const visible = showInactive ? rows : rows.filter((row) => row.user.isActive);
  const inactiveCount = rows.filter((row) => !row.user.isActive).length;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Users"
        description={
          <p>
            Who has an account, and what their role permits. A role is decided here and
            checked by the application on every request — never read from whatever the
            identity provider happens to say, because a provider can be reconfigured by
            somebody who has never seen this application.
          </p>
        }
      >
        {mode === 'access' ? (
          <Notice tone="info" title="Sign-in is managed by Cloudflare Access">
            This deployment authenticates at the edge, so there is no per-user sign-in method
            to choose here. Restricting a person to one identity provider is a rule in the
            Access policy.
            {accessTeamDomain() ? (
              <>
                {' '}
                Team domain: <span className="num">{accessTeamDomain()}</span>.
              </>
            ) : null}
          </Notice>
        ) : null}

        {mode === 'sso' ? (
          providers.length > 0 ? (
            <Notice tone="info" title="This installation signs people in itself">
              Configured providers: {providers.map((p) => PROVIDER_LABELS[p]).join(', ')}. A
              provider absent from that list has no credentials in this deployment&apos;s
              environment, so it is not offered — a method that cannot work is a support call.
            </Notice>
          ) : (
            <Notice tone="warning" title="No sign-in provider is configured">
              This deployment is set to sign people in itself, but no provider credentials are
              present in its environment. Nobody can sign in until an installer adds them.
            </Notice>
          )
        ) : null}

        {mode === 'local' ? (
          <Notice tone="warning" title="No sign-in is enforced">
            Every request on this deployment arrives as{' '}
            <span className="num">{localUserEmail() ?? 'an unnamed local user'}</span>. Roles
            below still apply — the named identity is looked up in this table exactly as a
            signed-in one would be — but there is no password, no provider and no session.
            This mode is for a LAN or a laptop under test.
          </Notice>
        ) : null}

        {mode === 'unset' ? (
          <Notice tone="negative" title="Sign-in mode is not set">
            No recognised sign-in mode is configured, so nobody can be authenticated.
          </Notice>
        ) : null}

        {state.actor ? null : (
          <div className="mt-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="t-small text-muted">
            {visible.length} shown
            {inactiveCount > 0 ? ` · ${inactiveCount} inactive` : ''}
          </p>
          <Link
            href={showInactive ? '/settings/users' : '/settings/users?inactive=1'}
            className="min-h-11 rounded-[4px] border border-line-strong px-3 py-2 t-small hover:bg-surface-2"
          >
            {showInactive ? 'Hide inactive users' : 'Show inactive users'}
          </Link>
        </div>

        <div className="mt-2 overflow-x-auto rounded-[6px] border border-line">
          <table className="data-table data-table--stack" style={{ minWidth: '60rem' }}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Sign-in</th>
                <th scope="col">Status</th>
                <th scope="col">Account</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td data-label="Name" colSpan={6}>
                    No users to show. Add the first one below.
                  </td>
                </tr>
              ) : null}

              {visible.map(({ user, identity }) => {
                const isSelf = state.actor?.id === user.id;
                const ownerRowLockedToAdmin =
                  user.role === 'owner' && state.actor?.role !== 'owner';
                const roleLocked = !allowed || isSelf || ownerRowLockedToAdmin;

                const roleTitle = !allowed
                  ? 'Your role does not manage users.'
                  : isSelf
                    ? 'Nobody changes their own role. Another owner does it.'
                    : ownerRowLockedToAdmin
                      ? 'Owner rows are read-only to an admin.'
                      : undefined;

                return (
                  <tr key={user.id}>
                    <td data-label="Name">
                      <span className="flex flex-wrap items-center gap-2">
                        {user.displayName}
                        {isSelf ? <Pill tone="accent">You</Pill> : null}
                      </span>
                    </td>
                    <td data-label="Email" className="t-small text-muted">
                      {user.email}
                    </td>
                    <td data-label="Role">
                      <InlineSelectForm
                        action={setUserRole}
                        name="role"
                        label={`Role for ${user.displayName}`}
                        options={ROLE_OPTIONS}
                        defaultValue={user.role}
                        hidden={{ id: user.id }}
                        submitLabel="Set"
                        disabled={roleLocked}
                        disabledTitle={roleTitle}
                      />
                      <span className="block t-small text-subtle">{ROLE_SUMMARY[user.role]}</span>
                    </td>
                    <td data-label="Sign-in" className="t-small text-muted">
                      {mode === 'access' ? (
                        'Managed by Cloudflare Access'
                      ) : mode === 'local' ? (
                        'Not enforced in this mode'
                      ) : (
                        <>
                          <span className="block">
                            {user.loginMethod ? PROVIDER_LABELS[user.loginMethod] : 'Not set'}
                          </span>
                          <span className="block text-subtle">
                            {identity
                              ? `Linked${
                                  identity.lastSignInAt
                                    ? ` · last signed in ${identity.lastSignInAt
                                        .toISOString()
                                        .slice(0, 10)}`
                                    : ''
                                }`
                              : 'Not yet signed in'}
                          </span>
                        </>
                      )}
                    </td>
                    <td data-label="Status">
                      {user.isActive ? (
                        <Pill tone="positive">Active</Pill>
                      ) : (
                        <Pill tone="neutral">Inactive</Pill>
                      )}
                    </td>
                    <td data-label="Account">
                      <RowAction
                        action={setUserActive}
                        label={user.isActive ? 'Deactivate' : 'Reactivate'}
                        destructive={user.isActive}
                        disabled={!allowed || ownerRowLockedToAdmin}
                        title={
                          ownerRowLockedToAdmin ? 'Owner rows are read-only to an admin.' : undefined
                        }
                        fields={{ id: user.id, isActive: user.isActive ? 'false' : 'true' }}
                        confirm={
                          user.isActive
                            ? `Deactivate ${user.displayName}? Every session of theirs ends immediately. The row stays, so the same address can be brought back.`
                            : undefined
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4">
          <Notice tone="neutral" title="Four rules this screen will not let you break">
            <ul className="ml-5 list-disc">
              <li>An admin cannot change an owner’s account. Owner rows are read-only to them.</li>
              <li>An admin cannot grant the owner role, to anyone, including themselves.</li>
              <li>Nobody changes their own role — an owner included. A second owner does it.</li>
              <li>
                The last active owner cannot be demoted or deactivated. It is the only rule
                whose failure leaves no route back in through the interface, so the database
                refuses it too.
              </li>
            </ul>
          </Notice>
        </div>
      </Section>

      <Section
        title="Add a user"
        description={
          <p>
            Name, email, role — and, where this installation signs people in itself, which
            provider they use. Nothing is emailed: the application sends no mail. Tell the
            person the address; when they sign in with an account whose verified email
            matches, the row above changes from &ldquo;not yet signed in&rdquo; to linked.
          </p>
        }
      >
        <ActionForm
          action={addUser}
          submitLabel="Add user"
          disabled={!allowed}
          disabledNote={
            state.actor
              ? `Your role (${state.actor.role}) does not manage users.`
              : (state.reason ?? undefined)
          }
          resetOnSuccess
        >
          <FieldGrid>
            <TextField
              idPrefix="new-user"
              name="displayName"
              label="Name"
              required
              maxLength={200}
              disabled={!allowed}
              hint="As it should read on screen."
            />
            <TextField
              idPrefix="new-user"
              name="email"
              label="Email"
              type="email"
              inputMode="email"
              required
              maxLength={200}
              disabled={!allowed}
              hint="The address this account is keyed on. It must match the verified email their provider reports."
            />
            <SelectField
              idPrefix="new-user"
              name="role"
              label="Role"
              required
              defaultValue="bookkeeper"
              options={
                state.actor?.role === 'owner'
                  ? ROLE_OPTIONS
                  : // An admin is not offered a choice they would be refused.
                    ROLE_OPTIONS.filter((option) => option.value !== 'owner')
              }
              disabled={!allowed}
              hint={
                state.actor?.role === 'owner'
                  ? 'Owner is offered because you are one.'
                  : 'Only an owner can grant the owner role, so it is not on this list.'
              }
            />
            {mode === 'sso' ? (
              <SelectField
                idPrefix="new-user"
                name="loginMethod"
                label="Sign-in method"
                defaultValue=""
                blankLabel="Not set"
                options={providers.map((provider) => ({
                  value: provider,
                  label: PROVIDER_LABELS[provider],
                }))}
                disabled={!allowed || providers.length === 0}
                hint="Only the providers this installation has credentials for appear. Left unset, the person cannot sign in until it is chosen."
              />
            ) : null}
          </FieldGrid>
        </ActionForm>
      </Section>

      <Section title="Changing how someone signs in">
        {/*
          Not wired here on purpose. Switching a method is one transaction that
          voids the active identity row, sets the new method, revokes every
          session and drops the in-process cache -- and it belongs with the
          sign-in implementation that owns those pieces, not with this screen.
        */}
        <Notice tone="warning" title="Not available on this screen yet">
          A person&apos;s sign-in method can be set when their account is created, but changing
          it afterwards — along with resetting a provider link and signing someone out
          everywhere — is part of the sign-in implementation being built alongside this
          screen. Those three actions void the existing link and revoke every session in one
          transaction, and doing half of that from here would leave someone signed in with a
          method they no longer have.
        </Notice>
      </Section>
    </div>
  );
}
