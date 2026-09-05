import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { saveAccessStep } from '@/app/setup/access/actions';
import { requireOpenSetup } from '@/app/setup/guard';
import { OWNER_USER_ID_KEY } from '@/app/setup/state';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { StepPanel } from '@/components/setup/StepPanel';
import {
  type EffectiveKey,
  type ManagedKey,
  type RedactedEntry,
  authConfigPath,
  compareToProcessEnv,
  configState,
  readAuthConfig,
  redactAuthConfig,
} from '@/lib/deploy/auth-config';
import { type Posture, POSTURE_KEYS, postureOfEntries, restartPlan } from '@/lib/deploy/posture';
import { TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

/**
 * The access step: where this deployment sits on the network, and who may
 * reach it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE QUESTION THE SOFTWARE CANNOT ANSWER FOR ITSELF.
 *
 * A mini PC on an office LAN and a mini PC published to the internet through a
 * tunnel are indistinguishable from inside the container. So the posture is
 * asked, in words about reachability rather than about protocols, and the
 * consequence of each is stated beside it rather than in a manual — because
 * the wrong answer here is not a cosmetic mistake. `lan` treats every visitor
 * as one named user, which is correct on an office network and hands the whole
 * quoting system to the first stranger who finds it on anything reachable from
 * outside.
 *
 * All three groups of fields are in the document at once, in one DOM tree
 * reflowed by CSS — the same ruling the step indicator and the data tables
 * follow. There is no JavaScript on this page hiding the two the installer did
 * not pick, and that is a choice rather than a shortcut: the consequences of
 * the other two postures are exactly what a person needs to read BEFORE
 * committing to one, and a control that appears only after the decision is
 * made is a control that arrives too late to inform it. The action validates
 * the chosen branch and ignores the rest.
 *
 * Nothing secret comes back out. What is already on disk is read through the
 * redacting summariser, which reports whether each secret is present and how
 * long it is — never its contents, because a server component that returned a
 * client secret would put it in the HTML, the browser cache and any screenshot
 * the installer sends to support.
 * ---------------------------------------------------------------------------
 */

const POSTURE_COPY: Record<
  Posture,
  { title: string; who: string; needs: string; caution: string }
> = {
  lan: {
    title: 'Office network only',
    who: 'Anybody who can reach the machine is treated as one named user — no password, no session.',
    needs: 'One address, which must already have a user account.',
    caution:
      'Correct on a staff-only network. Wrong on anything reachable from the internet — there, reaching the box is being the owner.',
  },
  tunnel: {
    title: 'Cloudflare Tunnel, with Access in front',
    who: 'Cloudflare authenticates at its edge, before any request reaches this machine.',
    needs: 'A Zero Trust team domain, the Access application audience tag, and the tunnel token.',
    // No inbound port and no certificate to renew, since cloudflared dials
    // out rather than being published to.
    caution: 'A tunnel with no Access policy on it publishes this deployment with no sign-in at all.',
  },
  sso: {
    title: 'This application signs people in itself',
    who: 'Runs OpenID Connect against Google or Microsoft; issues its own session cookie.',
    needs: 'The public URL, and a client id and secret per provider — plus your directory id for Microsoft.',
    caution:
      'This makes the application itself the internet-facing authentication surface. Choose it only when nothing sits at the edge to do that job.',
  },
};

const EFFECT_COPY: Record<EffectiveKey['effect'], string> = {
  'in-effect': 'In effect now',
  'awaiting-restart': 'Awaiting restart',
  'overridden': 'Environment wins',
};

/**
 * A posture choice.
 *
 * No `defaultChecked` on any of the three unless one is already on disk. A
 * pre-selected posture is a decision made for the operator by whoever ordered
 * the list, and this is the one decision on the whole wizard where that is not
 * acceptable.
 */
function PostureChoice({ posture, checked }: { posture: Posture; checked: boolean }) {
  const copy = POSTURE_COPY[posture];
  return (
    <label
      htmlFor={`posture-${posture}`}
      className="flex min-w-0 cursor-pointer flex-col gap-1 rounded-panel border border-line-strong bg-surface-2 p-3 hover:border-accent has-checked:border-accent has-checked:bg-accent-soft"
    >
      <span className="flex items-center gap-2 t-small font-semibold">
        <input
          id={`posture-${posture}`}
          type="radio"
          name="posture"
          value={posture}
          defaultChecked={checked}
          className="size-4 shrink-0 accent-[var(--accent)]"
        />
        {copy.title}
      </span>
      <span className="t-small text-muted">{copy.who}</span>
      <span className="t-small text-subtle">{copy.needs}</span>
    </label>
  );
}

/** One field group, labelled with the posture it belongs to. */
function PostureFields({
  posture,
  children,
}: {
  posture: Posture;
  children: React.ReactNode;
}) {
  const copy = POSTURE_COPY[posture];
  return (
    <fieldset className="min-w-0 rounded-panel border border-line p-3">
      <legend className="px-1 t-small font-semibold">{copy.title}</legend>
      <p className="mb-3 max-w-prose t-small text-muted">{copy.caution}</p>
      {children}
    </fieldset>
  );
}

export default async function AccessStepPage() {
  const gate = await requireOpenSetup('access');

  // The owner this wizard created, offered as the default for the LAN
  // address. It matters beyond convenience: in that posture an address with no
  // active user row behind it is a deployment where every screen renders
  // read-only, and the failure looks like a broken installation rather than a
  // mistyped field.
  const ownerId = gate.values.get(OWNER_USER_ID_KEY);
  const [owner] = ownerId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, ownerId))
    : [];

  let onDisk: Awaited<ReturnType<typeof readAuthConfig>> = null;
  let readFailure: string | null = null;
  try {
    onDisk = await readAuthConfig();
  } catch (error) {
    // Reported, not thrown. A config file that exists and cannot be read is a
    // real finding — a volume mounted with the wrong owner, almost always —
    // and a step that 500ed on it would name nothing.
    readFailure = error instanceof Error ? error.message : String(error);
  }

  const chosen = onDisk ? postureOfEntries(onDisk.entries) : null;
  const keysOnDisk: readonly ManagedKey[] = chosen ? POSTURE_KEYS[chosen] : [];
  const summary: RedactedEntry[] = onDisk ? redactAuthConfig(onDisk.entries, keysOnDisk) : [];
  const effects = onDisk ? compareToProcessEnv(onDisk.entries) : [];
  const effectOf = new Map(effects.map((entry) => [entry.key, entry.effect]));
  const state = configState(effects);

  const origin = onDisk?.entries.get('APP_PUBLIC_URL') ?? null;

  return (
    <StepPanel slug="access" gate={gate}>
      <ActionForm action={saveAccessStep} submitLabel="Write the configuration">
        <Notice tone="warning" title="This is the one setting a wrong answer gives the company away">
          <p>
            These are the only values this wizard writes to a <em>file</em> rather than the
            database, since a database row is mirrored to SharePoint and every backup. They go
            to <span className="num">{authConfigPath()}</span> at permissions 0600, and nothing
            copies that file anywhere.
          </p>
          <p className="mt-2">
            Read all three below before choosing — the application can&rsquo;t tell whether this
            machine is reachable from the internet, so nothing here is pre-selected.
          </p>
        </Notice>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {(['lan', 'tunnel', 'sso'] as const).map((posture) => (
            <PostureChoice key={posture} posture={posture} checked={chosen === posture} />
          ))}
        </div>

        <PostureFields posture="lan">
          <FieldGrid>
            <TextField
              name="localUserEmail"
              label="Local user email"
              type="email"
              inputMode="email"
              maxLength={200}
              defaultValue={onDisk?.entries.get('LOCAL_USER_EMAIL') ?? owner?.email ?? ''}
              placeholder="The account every request arrives as"
              hint="Must match an active user account. This posture is not exempt from that check."
            />
          </FieldGrid>
          {/*
           * Not a missing feature: local mode makes every visitor the owner,
           * so if this application could turn it on by writing a file, anyone
           * who found a way to write one file inside it could promote
           * themselves to owner with nothing in the audit log. The config
           * file may tighten this deployment and must never loosen it, so the
           * loosest setting has to come from somewhere it cannot reach.
           */}
          <Notice tone="negative" title="This step cannot switch the application into local mode">
            <p>
              It writes the address and stops there. Turning local mode <em>on</em> is one line in
              the container environment — <span className="num">AUTH_MODE=local</span> in the
              compose file or the <span className="num">.env</span> beside it — and you have to
              add it yourself.
            </p>
          </Notice>
        </PostureFields>

        <PostureFields posture="tunnel">
          <FieldGrid>
            <TextField
              name="teamDomain"
              label="Team domain"
              type="url"
              maxLength={200}
              defaultValue={onDisk?.entries.get('CF_ACCESS_TEAM_DOMAIN') ?? ''}
              placeholder="https://your-team.cloudflareaccess.com"
              hint="Your Zero Trust team domain, in full."
            />
            <TextField
              name="accessAud"
              label="Access application audience"
              maxLength={200}
              numeric
              defaultValue={onDisk?.entries.get('CF_ACCESS_AUD') ?? ''}
              placeholder="The application's Audience tag"
              hint="From the Access application's overview page."
            />
            {/* cloudflared reads its environment from compose and does not
                mount this file's volume, so the token has to travel by hand. */}
            <TextField
              name="tunnelToken"
              label="Tunnel token"
              maxLength={4000}
              wide
              placeholder="Shown once, when the tunnel is created"
              hint="Never shown back — copy it into .env as TUNNEL_TOKEN before leaving this page."
            />
          </FieldGrid>
          {/* Two places that could disagree about the sign-in method is worse
              than one, so the per-user setting on the users screen is hidden
              in this posture. */}
          <Notice tone="info" title="Which sign-in methods are allowed is not a setting here">
            That&rsquo;s policy in the Access application, not here — the container never sees a
            credential. The per-user sign-in setting is hidden in this posture.
          </Notice>
        </PostureFields>

        <PostureFields posture="sso">
          <FieldGrid>
            <TextField
              name="publicUrl"
              label="Public URL"
              type="url"
              maxLength={300}
              wide
              defaultValue={origin ?? ''}
              placeholder="https://quotes.your-company.example"
              hint="The origin people reach this at. Every redirect URI is built from it."
            />
            <TextField
              name="googleClientId"
              label="Google client id"
              maxLength={300}
              defaultValue={onDisk?.entries.get('GOOGLE_CLIENT_ID') ?? ''}
              placeholder="Leave blank to skip Google"
              hint="From an OAuth client in Google Cloud Console."
            />
            <TextField
              name="googleClientSecret"
              label="Google client secret"
              maxLength={300}
              placeholder="Required if a client id is set"
              hint="Stored but never shown back."
            />
            <TextField
              name="microsoftClientId"
              label="Microsoft client id"
              maxLength={300}
              defaultValue={onDisk?.entries.get('MICROSOFT_CLIENT_ID') ?? ''}
              placeholder="Leave blank to skip Microsoft"
              hint="The Application (client) ID of an Entra app registration."
            />
            <TextField
              name="microsoftClientSecret"
              label="Microsoft client secret"
              maxLength={300}
              placeholder="Required if a client id is set"
              hint="Stored but never shown back."
            />
            <TextField
              name="microsoftTenantId"
              label="Microsoft directory (tenant) id"
              maxLength={100}
              defaultValue={onDisk?.entries.get('MICROSOFT_TENANT_ID') ?? ''}
              placeholder="Your directory's GUID, or consumers"
              hint="Not common and not organizations. Both are refused."
            />
          </FieldGrid>

          {/*
           * On those two endpoints any Entra directory in the world can mint
           * a token this application would accept, which makes the email
           * address in the token attacker-controlled: somebody registers a
           * tenant, sets a user's mail to the owner's address, signs in, and
           * the first-link match hands them the owner's account. The runtime
           * refuses both at boot; this form refuses them here so the refusal
           * arrives while the value is still on screen rather than as a
           * container that will not start.
           */}
          <Notice tone="negative" title="Why common and organizations are refused">
            Either would let any Entra directory mint a token this application accepts — refused
            at boot too, not only here.
          </Notice>

          <Notice tone="info" title="Paste these redirect URIs into each console, exactly">
            <p className="num">
              {origin ?? 'https://your-public-url'}/auth/callback/google
              <br />
              {origin ?? 'https://your-public-url'}/auth/callback/microsoft
            </p>
            <p className="mt-2">
              A trailing slash is the commonest cause of{' '}
              <span className="num">redirect_uri_mismatch</span>.
            </p>
            {/* Apple's client secret is a signed token minted per request
                from a mounted key, not a plain string, and its callback is a
                cross-site form POST — the runtime refuses it today, and a
                button that cannot work is a support call. */}
            <p className="mt-2">Apple is not offered — the runtime refuses it today.</p>
          </Notice>
        </PostureFields>

        {readFailure ? (
          <Notice tone="negative" title="The existing configuration file could not be read">
            <p>{readFailure}</p>
            <p className="mt-2">
              Almost always a volume mounted with an owner other than the user this application
              runs as. Writing below will still be attempted and will report what happens.
            </p>
          </Notice>
        ) : null}

        {onDisk && summary.length > 0 ? (
          <TableWrap minWidth="34rem">
            <caption className="sr-only">
              What the configuration file already holds, and whether this running process is
              using it
            </caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">On disk</th>
                <th scope="col">In this process</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((entry) => (
                <tr key={entry.key}>
                  <td data-label="Key" className="num t-small">
                    {entry.key}
                  </td>
                  <td data-label="On disk" className="t-small">
                    {!entry.present ? (
                      <span className="text-subtle">Not set</span>
                    ) : entry.secret ? (
                      // Present, and its length. Never the value. Length is
                      // the one fact that separates the two failures an
                      // installer actually hits: a value that never arrived,
                      // and one the console's copy button truncated.
                      <span className="text-muted">
                        Set, {entry.length} characters — not shown
                      </span>
                    ) : (
                      <span className="num">{entry.value}</span>
                    )}
                  </td>
                  <td data-label="In this process" className="t-small text-muted">
                    {/*
                      A key present on disk but absent from `effects` means
                      this process has no value for it, which is exactly what
                      awaiting-restart says — so that is the default rather
                      than a blank cell.
                    */}
                    {entry.present
                      ? EFFECT_COPY[effectOf.get(entry.key) ?? 'awaiting-restart']
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ) : null}

        {chosen && state !== 'empty' ? (
          <Notice
            tone={state === 'in-effect' ? 'positive' : 'warning'}
            title={
              state === 'in-effect'
                ? 'This posture is configured and running'
                : state === 'overridden'
                  ? 'Configured on disk, but the container environment is winning'
                  : 'Configured on disk, and not yet in effect'
            }
          >
            <p>
              {state === 'in-effect'
                ? 'Every value in the file matches what this process is running with.'
                : state === 'overridden'
                  ? 'One or more values are set to something else in the container environment, ' +
                    'and the environment wins by design — that is what keeps a value an operator ' +
                    'pinned in a compose file out of reach of anything the application writes. ' +
                    'Change it there, or remove it there to let the file take over.'
                  : 'This process has no value for at least one of these keys, which means the ' +
                    'file was written after it started. A process’s environment is fixed when it ' +
                    'starts, so nothing here changes until the containers come back.'}
            </p>
            {state !== 'in-effect' ? (
              <p className="mt-2">
                <span className="num">{restartPlan(chosen).command}</span>
              </p>
            ) : null}
            {restartPlan(chosen).operatorMustFirst.map((task) => (
              <p className="mt-2" key={task}>
                {task}
              </p>
            ))}
          </Notice>
        ) : null}

        {/* It could, by mounting the Docker socket into the container — but a
            container holding that socket is root on the host, and that
            trade is one saved command against a bug here becoming a
            compromise of the whole machine. */}
        <Notice tone="info" title="The application cannot restart itself, and should not be able to">
          That would need root-level access to the host. Restart manually, using the command
          above.
        </Notice>
      </ActionForm>
    </StepPanel>
  );
}
