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
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';
import { buttonClass } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { TableWrap } from '@/components/ui/Table';

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
      {/* A provider can be reconfigured by somebody who has never seen this
          application, so a role is never read from what it happens to say. */}
      <Section
        title="Users"
        description={
          <p>Who has an account, and what their role permits — never read from the identity provider.</p>
        }
        actions={
          // A press, then the form over a blurred page -- the same shape
          // "Change..." uses on every other settings screen. There is no
          // matching "Change..." sheet on this one -- a role is set inline,
          // per row, and there is no other field on a user to edit -- so
          // there is no second form to share these fields with.
          <SheetButton
            trigger="Add a user"
            variant="primary"
            label="Add a user"
            title="Add a user"
            subtitle="Nothing is emailed — tell the person the address; they link on first sign-in."
            discardPrompt="Throw away this user? Nothing has been saved yet."
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
                  hint="Must match the verified email their provider reports."
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
                    hint="Only providers with credentials appear. Left unset, they can't sign in yet."
                  />
                ) : null}
              </FieldGrid>
            </ActionForm>
          </SheetButton>
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
              Configured providers: {providers.map((p) => PROVIDER_LABELS[p]).join(', ')}. Others
              have no credentials in this deployment&apos;s environment, so they aren&apos;t
              offered.
            </Notice>
          ) : (
            <Notice tone="warning" title="No sign-in provider is configured">
              This deployment is set to sign people in itself, but no provider credentials are
              present in its environment. Nobody can sign in until an installer adds them.
            </Notice>
          )
        ) : null}

        {mode === 'local' ? (
          // For a LAN or a laptop under test.
          <Notice tone="warning" title="No sign-in is enforced">
            Every request on this deployment arrives as{' '}
            <span className="num">{localUserEmail() ?? 'an unnamed local user'}</span>. Roles
            below still apply, but there is no password, no provider and no session.
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
            className={buttonClass('secondary', { className: 't-small' })}
          >
            {showInactive ? 'Hide inactive users' : 'Show inactive users'}
          </Link>
        </div>

        <TableWrap minWidth="60rem" className="mt-2">
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
                  No users to show. Add the first one above.
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
                    {/* One wrapper, not two loose children. Below `sm` the cell
                        is a flex row, so the form and the summary under it were
                        competing for the same line: the select collapsed to
                        18px and the summary ran under the button. Wrapped, the
                        cell holds one shrinkable item and the control gets the
                        width. `min-w-0` is what lets it shrink at all. */}
                    <span className="block min-w-0">
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
                    </span>
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
        </TableWrap>

        <div className="mt-4">
          <Notice tone="neutral" title="Four rules this screen will not let you break">
            <ul className="ml-5 list-disc">
              <li>An admin cannot change an owner’s account. Owner rows are read-only to them.</li>
              <li>An admin cannot grant the owner role, to anyone, including themselves.</li>
              <li>Nobody changes their own role — an owner included. A second owner does it.</li>
              {/* The only rule whose failure leaves no route back in through
                  the interface, so the database refuses it too. */}
              <li>The last active owner cannot be demoted or deactivated.</li>
            </ul>
          </Notice>
        </div>
      </Section>

      <Section title="Changing how someone signs in">
        {/*
          Not wired here on purpose. Switching a method is one transaction that
          voids the active identity row, sets the new method, revokes every
          session and drops the in-process cache -- and it belongs with the
          sign-in implementation that owns those pieces, not with this screen.
        */}
        <Notice tone="warning" title="Not available on this screen yet">
          Can be set when the account is created. Changing it afterwards isn&apos;t available
          yet — that&apos;s part of the sign-in implementation being built alongside this
          screen.
        </Notice>
      </Section>
    </div>
  );
}
