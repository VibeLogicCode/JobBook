import { resolveActor } from '@/app/settings/actor';
import { OWNER_ONLY, canSync } from '@/app/settings/sync/guard';
import {
  saveMirrorLibraries,
  saveMirrorSchedule,
  saveMirrorSite,
  setMirrorEnabled,
} from '@/app/settings/sync/actions';
import { runEnvironmentChecks } from '@/app/setup/environment';
import { ActionForm } from '@/components/settings/ActionForm';
import { CheckboxField, FieldGrid, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/settings/Notice';
import { Section } from '@/components/settings/Section';
import { EnvironmentReport, StatusPill } from '@/components/setup/EnvironmentReport';
import { Pill, type Tone } from '@/components/ui/Pill';
import { entityTypeEnum } from '@/db/enums';
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_STALENESS_HOURS,
  LIBRARY_FOR_ATTACHMENT,
  LIBRARY_KINDS,
  LIBRARY_PURPOSE,
  type LibraryKind,
  MAX_INTERVAL_MINUTES,
  MAX_STALENESS_HOURS,
  MIN_INTERVAL_MINUTES,
  MIN_STALENESS_HOURS,
  NOT_MIRRORED_TABLES,
  SYNC_ENVIRONMENT_VARIABLES,
  VARIABLE_PURPOSE,
  defaultSyncConfig,
  readSyncConfig,
  readSyncEnvironment,
  syncReadiness,
  type SyncReadiness,
} from '@/lib/sync/config';
import { MIRROR_IS_BUILT } from '@/lib/sync/mirror';
import {
  HEALTH_EXPLANATION,
  HEALTH_LABEL,
  type SyncHealth,
  describeAge,
  readSyncState,
} from '@/lib/sync/state';

export const dynamic = 'force-dynamic';

/**
 * The SharePoint mirror's configuration surface.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO CREDENTIAL FIELD ON THIS PAGE, AND THAT IS THE POINT.
 *
 * The directory id, application id, certificate path and thumbprint are
 * environment variables. A form writes to the database; this database is
 * mirrored to a SharePoint site and dumped hourly to three destinations, so a
 * certificate typed into a text box would be in every one of those copies,
 * forever, encrypted with a key held on the same machine (design sections 7.0,
 * 7.6, 8.1). The report below says what is set and what is missing; the fixing
 * happens in a Compose file or a Docker secret.
 * ---------------------------------------------------------------------------
 *
 * The page is long because every field here has a consequence the form cannot
 * show: whether a company's records leave the machine, how much work a hardware
 * failure costs, and what an owner may and may not do with the copy that
 * arrives. Most of all it has to say that the mirror is not a restore path, and
 * that it is not built yet -- an owner who switches it on and waits for data
 * has been misled by a screen, not by a missing feature.
 */

/** Form labels for the six libraries. Screen wording, so it lives on the screen. */
const LIBRARY_LABEL: Record<LibraryKind, string> = {
  quote_documents: 'Quote documents',
  project_files: 'Project files',
  receipts: 'Receipts',
  vendor_invoices: 'Vendor invoices',
  backups: 'Backups',
  exports: 'Exports',
};

/** What the routing table calls each attachment kind. */
const ATTACHMENT_LABEL: Record<string, string> = {
  organization: 'Company logo and favicon',
  quote: 'Quote attachments and generated PDFs',
  project: 'Project files',
  customer: 'Customer attachments',
  receipt: 'Receipts',
  vendor_invoice: 'Vendor invoices',
  purchase_order: 'Purchase orders',
};

const READINESS: Record<SyncReadiness, { tone: Tone; label: string; detail: string }> = {
  'environment-off': {
    tone: 'neutral',
    label: 'Off in the container',
    detail:
      'SHAREPOINT_SYNC_ENABLED is not on, which is the default on a fresh install and a ' +
      'legitimate choice: not every company wants its records in a Microsoft tenant, and some ' +
      'have no Microsoft 365 at all. The gate is an environment variable and not a row in this ' +
      'database, so nothing on this page can override it — which is what stops a dump restored ' +
      'from a mirroring tenant pushing this company’s records to a site it has no credential for.',
  },
  'not-requested': {
    tone: 'neutral',
    label: 'Not switched on',
    detail:
      'The container permits the mirror and nobody has asked for it. Absence is the off state ' +
      'throughout this product: no default switches a feature on for somebody who never asked.',
  },
  'credential-missing': {
    tone: 'warning',
    label: 'No credential',
    detail:
      'The mirror is switched on and the environment does not supply the whole app-only ' +
      'credential, so nothing can authenticate. The variables are listed below.',
  },
  'site-missing': {
    tone: 'warning',
    label: 'No site',
    detail: 'The mirror is switched on and credentialed, and there is no site address to write to.',
  },
  ready: {
    tone: 'positive',
    label: 'Configured',
    detail:
      'Everything this screen can check is in place. Nothing is running: the sync job itself is ' +
      'not built.',
  },
};

const HEALTH_TONE: Record<SyncHealth, Tone> = {
  // Neutral, and neither green nor red. A green tick beside a mirror that is
  // switched off would read as "the mirror works"; a red cross beside a feature
  // the owner deliberately declined teaches him to ignore red.
  off: 'neutral',
  'never-run': 'info',
  healthy: 'positive',
  stale: 'warning',
  failing: 'negative',
};

/** A machine timestamp, in UTC, because machine state is not a calendar date. */
function stamp(value: Date | null): string {
  if (!value) return '—';
  return `${value.toISOString().slice(0, 10)} ${value.toISOString().slice(11, 16)}Z`;
}

export default async function SyncSettingsPage() {
  const state = await resolveActor();
  const allowed = state.actor ? canSync(state.actor.role) : false;

  const read = await readSyncConfig();
  // A configuration this module refuses to parse still has to render: the
  // fields are how somebody fixes it, and a 500 would leave no route back in
  // except SQL. The stored problems are named above the forms instead.
  const config = read.ok ? read.config : defaultSyncConfig();
  const environment = readSyncEnvironment();
  const readiness = syncReadiness(config, environment);
  const report = await readSyncState(config, environment);

  /**
   * The credential verdict comes from the setup wizard's own check rather than
   * from a second implementation here.
   *
   * It is the same variables, the same shell-boolean rule and the same
   * certificate load, so the two screens cannot disagree — which is the defect
   * this reuse exists to prevent: a screen and a runtime reading different
   * variable names once had a configured deployment reporting itself
   * unconfigured.
   */
  const sharePointCheck = (await runEnvironmentChecks()).filter(
    (check) => check.id === 'sharepoint',
  );

  const twiceTheInterval = (config.intervalMinutes * 2) / 60;

  return (
    <div className="flex flex-col gap-4">
      {MIRROR_IS_BUILT ? null : (
        <Notice tone="warning" title="The mirror is not built yet">
          <p>
            Everything on this page is real: the settings are stored, the permission is checked,
            and the state below is read from the database. What does not exist yet is the part
            that talks to SharePoint — the Graph client, the provisioning generator and the
            scheduled job. They are being written once the schema has settled.
          </p>
          <p className="mt-2">
            So switching the mirror on here changes a stored setting and starts nothing. No list
            is created, no row is sent, and the verdicts below will read{' '}
            <span className="font-semibold">Never run</span> forever until the job lands. This
            notice is here so nobody switches it on and waits for data that will never arrive.
          </p>
        </Notice>
      )}

      {state.actor ? null : <Notice tone="warning">{state.reason}</Notice>}

      {read.ok ? null : (
        <Notice tone="negative" title="Some stored values are not what they claim to be">
          <p>
            These rows were refused rather than quietly replaced with defaults. Coercing them
            would mean a deployment running on a schedule nobody chose, or a mirror pointed at no
            site while this screen showed a tick. Re-save the affected sections below to fix
            them.
          </p>
          <ul className="mt-2 list-disc pl-5">
            {read.problems.map((problem) => (
              <li key={problem.key}>
                <span className="font-semibold">{problem.label}</span> {problem.message}{' '}
                <span className="num t-micro text-subtle">({problem.key})</span>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <Section
        title="What the mirror is, and what it is not"
        description={
          <p>
            SharePoint holds a structured, queryable replica of this database, with matching
            tables and column names. Read this section before switching it on: what it is for is
            narrower than it looks, and one of the things people expect from it is a thing it
            cannot do.
          </p>
        }
      >
        <div className="flex flex-col gap-3">
          <Notice tone="info" title="One way, and Postgres is authoritative">
            <p>
              Rows travel from this database to SharePoint and never back. Postgres is
              authoritative for every field, so the SharePoint lists are read-only to people:
              provisioning grants everyone Read at the site level and Contribute to the sync
              identity alone.
            </p>
            <p className="mt-2">
              The reason is worse than “an edit would be overwritten”. An unchanged row is never
              resent, so an edit made in SharePoint is <em>not</em> overwritten — it persists and
              diverges silently, and the mirror quietly stops matching the database. A wrong
              figure that survives is worse than one that gets corrected.
            </p>
          </Notice>

          <Notice tone="neutral" title="What it is for">
            <ul className="list-disc pl-5">
              <li>
                <span className="font-semibold">Reading.</span> If this machine dies on a Friday,
                the quotes, customers and projects are still openable in a familiar interface
                rather than locked inside a database file.
              </li>
              <li>
                <span className="font-semibold">Reporting.</span> Power BI Desktop and Excel both
                connect to SharePoint lists natively, at no extra licence cost.
              </li>
              <li>
                <span className="font-semibold">Handing work to an accountant,</span> as a shared
                folder and a list view rather than an export request.
              </li>
              <li>
                <span className="font-semibold">An exit path.</span> Structured data in the
                company’s own tenant, in its own format.
              </li>
            </ul>
          </Notice>

          <Notice tone="negative" title="It is not a restore path">
            <p>
              Recovery is from the encrypted database dump, never from these lists. The mirror is
              the wrong artifact for a rebuild and always will be: numbers round-trip through
              IEEE doubles, a Text column caps at 255 characters and a Note column at roughly
              64k, and a Choice column rejects any value not already in its member list. The dump
              is byte-exact and has the same recovery point.
            </p>
            <p className="mt-2">
              Read the lists, report from them, hand them to an accountant. Do not rebuild from
              them.
            </p>
          </Notice>

          <Notice tone="warning" title="With the mirror off, one copy fewer">
            <p>
              Switching it off is a legitimate decision, and it is not a silent one. With the
              mirror off, SharePoint leaves the backup picture entirely; if no USB destination is
              configured either, this company’s tax records exist on exactly one disk. The
              environment report below says which of those is true today.
            </p>
          </Notice>
        </div>
      </Section>

      <Section
        title="On and off"
        description={
          <p>
            Two switches have to agree, and they are deliberately not in the same place. This one
            is the owner’s request and is stored in the database. The other is{' '}
            <span className="num">SHAREPOINT_SYNC_ENABLED</span> in the container, which lives
            beside the credentials it gates — because a database row is mirrored to SharePoint and
            lands in every backup, and a flag that travels with a restored dump would switch the
            mirror on for a company that never asked.
          </p>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Pill tone={READINESS[readiness].tone}>{READINESS[readiness].label}</Pill>
          <span className="t-small text-muted">{READINESS[readiness].detail}</span>
        </div>

        <ActionForm
          action={setMirrorEnabled}
          submitLabel="Save this setting"
          disabled={!allowed}
          disabledNote={state.actor ? OWNER_ONLY : (state.reason ?? undefined)}
        >
          <FieldGrid>
            <CheckboxField
              idPrefix="mirror"
              name="enabled"
              label="Copy this database to SharePoint"
              defaultChecked={config.enabled}
              disabled={!allowed}
              wide
              hint="Switching this on resets the list cursors so the first run pushes every row — safe to repeat, because every write is an idempotent upsert. Switching it off leaves whatever is already in SharePoint in place; it stops updating and is not torn down."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      <Section
        title="Environment"
        description={
          <p>
            Read-only. Every value here is an environment variable or a mounted file, and not one
            of them is a field on this page. The verdict is the same check first-run setup runs,
            reading the same variable names, so the two screens cannot disagree about whether
            this deployment is configured.
          </p>
        }
      >
        <EnvironmentReport checks={sharePointCheck} />

        <p className="mt-4 mb-2 max-w-prose t-small text-muted">
          The check above stops at the first thing missing, so this table lists all five
          variables at once — whether each is set, never what is in it. The certificate is a
          Docker secret; the commonest failure by a wide margin is that it was never mounted into
          the container, and from outside that looks exactly like a sync that has quietly
          stopped.
        </p>

        <div className="overflow-x-auto rounded-[6px] border border-line">
          <table className="data-table data-table--stack" style={{ minWidth: '46rem' }}>
            <caption className="sr-only">
              The five environment variables the mirror reads, and whether each is set
            </caption>
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Set</th>
                <th scope="col">What it is for</th>
              </tr>
            </thead>
            <tbody>
              {SYNC_ENVIRONMENT_VARIABLES.map((variable) => (
                <tr key={variable}>
                  <td data-label="Variable" className="num t-small">
                    {variable}
                  </td>
                  <td data-label="Set">
                    <StatusPill
                      status={
                        variable === 'SHAREPOINT_SYNC_ENABLED'
                          ? environment.flagOn
                            ? 'pass'
                            : 'off'
                          : environment.present[variable]
                            ? 'pass'
                            : 'fail'
                      }
                    />
                  </td>
                  <td data-label="What it is for" className="t-small text-muted">
                    {VARIABLE_PURPOSE[variable]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Site and list names"
        description={
          <p>
            The site the lists are created in, and an optional prefix on every list name for a
            site that already holds lists of its own. Provisioning is run by hand against the
            tenant from a workstation, using the owner’s own credentials; this application never
            creates a site.
          </p>
        }
      >
        <ActionForm
          action={saveMirrorSite}
          submitLabel="Save site"
          disabled={!allowed}
          disabledNote={allowed ? undefined : OWNER_ONLY}
        >
          <FieldGrid>
            <TextField
              idPrefix="site"
              name="siteUrl"
              label="SharePoint site address"
              type="url"
              wide
              maxLength={400}
              defaultValue={config.siteUrl}
              disabled={!allowed}
              placeholder="https://example.sharepoint.com/sites/site-name"
              hint="The full https address of the site collection. No query string and no fragment: every Graph request path is built from this string. Leave it blank to clear it — a mirror with nowhere to write is off in practice."
            />
            <TextField
              idPrefix="site"
              name="listPrefix"
              label="List name prefix"
              maxLength={16}
              defaultValue={config.listPrefix}
              disabled={!allowed}
              hint="Letters and digits, starting with a letter. Blank means the lists are named exactly as the tables. A SharePoint list's internal name derives from its title, so punctuation is refused here rather than mangled there."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      <Section
        title="Document libraries"
        description={
          <>
            <p>
              Attachments go into document libraries, never into list attachments. That is forced
              rather than chosen: Microsoft Graph cannot read or write SharePoint list item
              attachments at all — there is no such relationship on a list item in the v1.0 API —
              and libraries are the better storage model anyway, with metadata columns, versioning
              and folders.
            </p>
            <p className="mt-2">
              Renaming one here does not rename it in SharePoint. Re-run provisioning, which is
              idempotent; the old library stays behind with its contents, because nothing in this
              product is deleted.
            </p>
          </>
        }
      >
        <ActionForm
          action={saveMirrorLibraries}
          submitLabel="Save library names"
          disabled={!allowed}
          disabledNote={allowed ? undefined : OWNER_ONLY}
        >
          <FieldGrid>
            {LIBRARY_KINDS.map((kind) => (
              <TextField
                key={kind}
                idPrefix="library"
                name={kind}
                label={LIBRARY_LABEL[kind]}
                maxLength={50}
                required
                defaultValue={config.libraries[kind]}
                disabled={!allowed}
                hint={LIBRARY_PURPOSE[kind]}
              />
            ))}
          </FieldGrid>
        </ActionForm>

        <p className="mt-4 mb-2 max-w-prose t-small text-muted">
          Which library a file lands in follows from what it is attached to. Two kinds have no
          destination: the design names six libraries and none of them is for a customer
          attachment or for the company’s own logo. Those files stay on local disk, which is
          authoritative in any case, rather than being filed somewhere an accountant would then
          find them.
        </p>

        <div className="overflow-x-auto rounded-[6px] border border-line">
          <table className="data-table data-table--stack" style={{ minWidth: '40rem' }}>
            <caption className="sr-only">
              Which document library each kind of attachment is mirrored to
            </caption>
            <thead>
              <tr>
                <th scope="col">Attached to</th>
                <th scope="col">Library</th>
              </tr>
            </thead>
            <tbody>
              {entityTypeEnum.enumValues.map((kind) => {
                const library = LIBRARY_FOR_ATTACHMENT[kind];
                return (
                  <tr key={kind}>
                    <td data-label="Attached to">
                      {ATTACHMENT_LABEL[kind] ?? kind}
                      <span className="block num t-micro text-subtle">{kind}</span>
                    </td>
                    <td data-label="Library" className="t-small">
                      {library ? (
                        config.libraries[library]
                      ) : (
                        <span className="flex flex-wrap items-center gap-2">
                          <Pill tone="neutral">Local disk only</Pill>
                          <span className="text-subtle">No library is named for this kind.</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Schedule"
        description={
          <p>
            The interval is the recovery point objective. Since the mirror is one of the copies a
            hardware failure is measured against, a four-hour interval means losing up to four
            hours of quoting work; hourly costs almost nothing, because a working day changes
            tens of rows.
          </p>
        }
      >
        <ActionForm
          action={saveMirrorSchedule}
          submitLabel="Save schedule"
          disabled={!allowed}
          disabledNote={allowed ? undefined : OWNER_ONLY}
        >
          <FieldGrid>
            <TextField
              idPrefix="schedule"
              name="intervalMinutes"
              label="Interval"
              required
              numeric
              inputMode="numeric"
              suffix="minutes"
              maxLength={4}
              defaultValue={String(config.intervalMinutes)}
              disabled={!allowed}
              hint={`Between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}. The default is ${DEFAULT_INTERVAL_MINUTES}. The floor is the five-minute safety lag: a run cannot see a row younger than that, so a shorter interval schedules work with nothing to do.`}
            />
            <TextField
              idPrefix="schedule"
              name="stalenessHours"
              label="Staleness threshold"
              required
              numeric
              inputMode="numeric"
              suffix="hours"
              maxLength={3}
              defaultValue={String(config.stalenessHours)}
              disabled={!allowed}
              hint={`How long without a success before a list is reported stale. Between ${MIN_STALENESS_HOURS} and ${MAX_STALENESS_HOURS}; the default is ${DEFAULT_STALENESS_HOURS}, which is twice the default interval. Staleness is computed from the last success and this number, never stored.`}
            />
          </FieldGrid>
        </ActionForm>

        {config.stalenessHours < twiceTheInterval ? (
          <Notice tone="warning">
            The threshold is shorter than twice the interval, so a single missed run reports as
            stale. That is allowed — it is a deliberately twitchy setting on a link that should
            never miss — but it is worth knowing before the first banner.
          </Notice>
        ) : null}
      </Section>

      <Section
        title="What each list has done"
        description={
          <>
            <p>
              One row per mirrored table, whether or not the sync has ever touched it. The
              verdict is computed here and now from the last success and the threshold above —
              there is no stored staleness flag, because a stored verdict is wrong the moment the
              clock passes it.
            </p>
            <p className="mt-2">
              Read as at <span className="num">{stamp(report.observedAt)}</span>. The cursor is a
              pair — a timestamp and a row id — and not a single watermark: a bulk insert stamps
              many rows with one timestamp, and advancing past “the highest in this batch” would
              drop the rest of that group. A forty-line quote losing lines 21 to 40 is the failure
              that pair prevents.
            </p>
          </>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Pill tone={HEALTH_TONE[report.worst]}>{HEALTH_LABEL[report.worst]}</Pill>
          <span className="t-small text-muted">
            {HEALTH_EXPLANATION[report.worst]} {report.rowsSynced.toLocaleString()} rows have been
            written across all lists.
          </span>
        </div>

        <div className="overflow-x-auto rounded-[6px] border border-line">
          <table className="data-table data-table--stack" style={{ minWidth: '72rem' }}>
            <caption className="sr-only">
              Every mirrored list, its health verdict, its cursor position and its last error
            </caption>
            <thead>
              <tr>
                <th scope="col">List</th>
                <th scope="col">Verdict</th>
                <th scope="col">Last success</th>
                <th scope="col">Last run</th>
                <th scope="col" className="cell-num">
                  Rows
                </th>
                <th scope="col" className="cell-num">
                  Failures
                </th>
                <th scope="col">Cursor</th>
                <th scope="col">Last error</th>
              </tr>
            </thead>
            <tbody>
              {[...report.rows, ...report.orphans].map((row) => (
                <tr key={row.listName}>
                  <td data-label="List">
                    {row.listName}
                    {row.table === null ? (
                      <span className="ml-2">
                        <Pill tone="warning">Unmapped</Pill>
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Verdict">
                    <span className="flex flex-wrap items-center gap-1">
                      <Pill tone={HEALTH_TONE[row.health]}>{HEALTH_LABEL[row.health]}</Pill>
                      {row.escalated ? <Pill tone="negative">Escalated</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Last success" className="t-small">
                    {describeAge(row.sinceSuccessMs)}
                    <span className="block num t-micro text-subtle">
                      {stamp(row.lastSuccessAt)}
                    </span>
                  </td>
                  <td data-label="Last run" className="num t-small text-muted">
                    {stamp(row.lastRunAt)}
                  </td>
                  <td data-label="Rows" className="cell-num">
                    {row.rowsSynced}
                  </td>
                  <td data-label="Failures" className="cell-num">
                    {row.consecutiveFailures}
                  </td>
                  <td data-label="Cursor" className="num t-micro text-subtle">
                    {row.cursorUpdatedAt ? (
                      <>
                        {stamp(row.cursorUpdatedAt)}
                        <span className="block">{row.cursorId ?? 'no row id'}</span>
                      </>
                    ) : (
                      'not started'
                    )}
                  </td>
                  <td data-label="Last error" className="t-small text-muted">
                    {row.lastError ?? <span className="text-subtle">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 max-w-prose t-small text-subtle">
          {NOT_MIRRORED_TABLES.join(', ')} are deliberately absent. The first three are machine
          state — including the two tables this screen reads — and the change log has no
          timestamp to sync on, will be the largest table in the database, and is already in
          every dump.
        </p>
      </Section>
    </div>
  );
}
