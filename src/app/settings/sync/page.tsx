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
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';
import { EnvironmentReport, StatusPill } from '@/components/setup/EnvironmentReport';
import { Pill, type Tone } from '@/components/ui/Pill';
import { TableWrap } from '@/components/ui/Table';
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
  // A dump restored from a mirroring tenant should not push this company's
  // records to a site it has no credential for — the gate is an environment
  // variable rather than a row here so nothing on this page can override it.
  'environment-off': {
    tone: 'neutral',
    label: 'Off in the container',
    detail:
      'The default on a fresh install, and a legitimate choice — not every company wants its ' +
      'records in a Microsoft tenant.',
  },
  'not-requested': {
    tone: 'neutral',
    label: 'Not switched on',
    detail: 'The container permits the mirror; nobody has asked for it yet.',
  },
  'credential-missing': {
    tone: 'warning',
    label: 'No credential',
    detail:
      "Switched on, but the environment doesn't supply the whole credential — variables listed " +
      'below.',
  },
  'site-missing': {
    tone: 'warning',
    label: 'No site',
    detail: "Switched on and credentialed, but there's no site address to write to.",
  },
  ready: {
    tone: 'positive',
    label: 'Configured',
    detail: "Everything checkable is in place. Nothing is running yet — the sync job isn't built.",
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
            Everything here is real except the part that talks to SharePoint — the Graph client,
            provisioning and the scheduled job aren&apos;t built yet.
          </p>
          <p className="mt-2">
            Switching it on changes a stored setting and starts nothing: the verdicts below will
            read <span className="font-semibold">Never run</span> until the job lands.
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

      {/* SharePoint holds a structured, queryable replica of this database,
          with matching tables and column names. */}
      <Section
        title="What the mirror is, and what it is not"
        description={
          <p>Read this before switching it on — what it does is narrower than it looks.</p>
        }
      >
        <div className="flex flex-col gap-3">
          <Notice tone="info" title="One way, and Postgres is authoritative">
            <p>
              Rows travel from this database to SharePoint and never back — the lists are
              read-only to people (Read at the site level; only the sync identity gets
              Contribute).
            </p>
            <p className="mt-2">
              Worse than being overwritten: an unchanged row is never resent, so an edit made in
              SharePoint is <em>not</em> overwritten — it persists and diverges silently. A wrong
              figure that survives is worse than one that gets corrected.
            </p>
          </Notice>

          <Notice tone="neutral" title="What it is for">
            <ul className="list-disc pl-5">
              <li>
                <span className="font-semibold">Reading.</span> If this machine dies, records
                are still openable in a familiar interface rather than locked in a database file.
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

          {/* Numbers round-trip through IEEE doubles, a Text column caps at
              255 characters and a Note column at roughly 64k, and a Choice
              column rejects any value not already in its member list. */}
          <Notice tone="negative" title="It is not a restore path">
            <p>
              Recovery is always from the encrypted database dump, never from these lists — the
              mirror can&apos;t round-trip every value exactly, and the dump is byte-exact.
            </p>
            <p className="mt-2">
              Read the lists, report from them, hand them to an accountant. Do not rebuild from
              them.
            </p>
          </Notice>

          <Notice tone="warning" title="With the mirror off, one copy fewer">
            <p>
              Legitimate, but not silent: with it off, and no USB destination configured either,
              this company&rsquo;s tax records exist on exactly one disk. The environment report
              below says which is true today.
            </p>
          </Notice>
        </div>
      </Section>

      {/* Deliberately not in the same place: a database row is mirrored to
          SharePoint and lands in every backup, and a flag that travels with
          a restored dump would switch the mirror on for a company that
          never asked. */}
      <Section
        title="On and off"
        description={
          <p>
            Two switches have to agree — this one is the owner&rsquo;s request, stored here. The
            other is <span className="num">SHAREPOINT_SYNC_ENABLED</span> in the container.
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
              // Safe to repeat: every write is an idempotent upsert.
              hint="Turning this on pushes every row again. Turning it off leaves SharePoint as it is — nothing is torn down."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      {/* The same check first-run setup runs, reading the same variable
          names, so the two screens cannot disagree about whether this
          deployment is configured. */}
      <Section
        title="Environment"
        description={
          <p>Read-only — every value here is an environment variable or a mounted file, not a field on this page.</p>
        }
      >
        <EnvironmentReport checks={sharePointCheck} />

        <p className="mt-4 mb-2 max-w-prose t-small text-muted">
          Lists all five at once — whether each is set, never what&rsquo;s in it. The commonest
          failure is the certificate never being mounted into the container, which looks just
          like a sync that quietly stopped.
        </p>

        <TableWrap minWidth="46rem">
          <caption className="sr-only">
            The five environment variables the mirror reads, and whether each is set
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Variable</th>
              <th role="columnheader" scope="col">Set</th>
              <th role="columnheader" scope="col">What it is for</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {SYNC_ENVIRONMENT_VARIABLES.map((variable) => (
              <tr role="row" key={variable}>
                <td role="cell" data-label="Variable" className="num t-small">
                  {variable}
                </td>
                <td role="cell" data-label="Set">
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
                <td role="cell" data-label="What it is for" className="t-small text-muted">
                  {VARIABLE_PURPOSE[variable]}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Section>

      <Section
        title="Site and list names"
        description={
          <p>
            The site the lists are created in, and an optional prefix for a site with lists of
            its own already. This application never creates the site itself — provisioning is
            run by hand.
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
              // Every Graph request path is built from this string.
              hint="Full https address, no query string or fragment. Blank clears it — a mirror with nowhere to write is off in practice."
            />
            <TextField
              idPrefix="site"
              name="listPrefix"
              label="List name prefix"
              maxLength={16}
              defaultValue={config.listPrefix}
              disabled={!allowed}
              // A SharePoint list's internal name derives from its title, so
              // punctuation is refused here rather than mangled there.
              hint="Letters and digits, starting with a letter. Blank names lists exactly as the tables."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      {/* Forced rather than chosen: Microsoft Graph cannot read or write
          SharePoint list item attachments at all, and libraries are the
          better storage model anyway, with metadata columns, versioning and
          folders. */}
      <Section
        title="Document libraries"
        description={
          <>
            <p>Attachments go into document libraries, never list attachments.</p>
            <p className="mt-2">
              Renaming here doesn&rsquo;t rename it in SharePoint — re-run provisioning; the old
              library stays behind with its contents.
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

        {/* Local disk is authoritative in any case, rather than filing those
            files somewhere an accountant would then find them. */}
        <p className="mt-4 mb-2 max-w-prose t-small text-muted">
          Two kinds have no destination — customer attachments and the company&rsquo;s own logo
          stay on local disk only.
        </p>

        <TableWrap minWidth="40rem">
          <caption className="sr-only">
            Which document library each kind of attachment is mirrored to
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Attached to</th>
              <th role="columnheader" scope="col">Library</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {entityTypeEnum.enumValues.map((kind) => {
              const library = LIBRARY_FOR_ATTACHMENT[kind];
              return (
                <tr role="row" key={kind}>
                  <td role="cell" data-label="Attached to">
                    {ATTACHMENT_LABEL[kind] ?? kind}
                    <span className="block num t-micro text-subtle">{kind}</span>
                  </td>
                  <td role="cell" data-label="Library" className="t-small">
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
        </TableWrap>
      </Section>

      <Section
        title="Schedule"
        description={
          <p>
            The interval is the recovery point objective — a four-hour interval risks losing up
            to four hours of work; hourly costs almost nothing.
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
              // The floor is the five-minute safety lag: a run cannot see a
              // row younger than that, so a shorter interval schedules work
              // with nothing to do.
              hint={`Between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}. Default ${DEFAULT_INTERVAL_MINUTES}.`}
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
              // Computed from the last success and this number on every
              // read, never stored.
              hint={`How long without a success before a list reports stale. Between ${MIN_STALENESS_HOURS} and ${MAX_STALENESS_HOURS}; default ${DEFAULT_STALENESS_HOURS}.`}
            />
          </FieldGrid>
        </ActionForm>

        {config.stalenessHours < twiceTheInterval ? (
          <Notice tone="warning">
            Shorter than twice the interval, so a single missed run reports as stale. Allowed,
            but worth knowing before the first banner.
          </Notice>
        ) : null}
      </Section>

      {/* No stored staleness flag, because a stored verdict is wrong the
          moment the clock passes it. */}
      <Section
        title="What each list has done"
        description={
          <>
            <p>One row per mirrored table. The verdict is computed live from the threshold above.</p>
            <p className="mt-2">
              Read as at <span className="num">{stamp(report.observedAt)}</span>. The cursor is a
              timestamp-and-row-id pair, not a single watermark — so a bulk insert can&rsquo;t
              lose rows past the last one it batched.
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

        <TableWrap minWidth="72rem">
          <caption className="sr-only">
            Every mirrored list, its health verdict, its cursor position and its last error
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">List</th>
              <th role="columnheader" scope="col">Verdict</th>
              <th role="columnheader" scope="col">Last success</th>
              <th role="columnheader" scope="col">Last run</th>
              <th role="columnheader" scope="col" className="cell-num">
                Rows
              </th>
              <th role="columnheader" scope="col" className="cell-num">
                Failures
              </th>
              <th role="columnheader" scope="col">Cursor</th>
              <th role="columnheader" scope="col">Last error</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {[...report.rows, ...report.orphans].map((row) => (
              <tr role="row" key={row.listName}>
                <td role="cell" data-label="List">
                  {row.listName}
                  {row.table === null ? (
                    <span className="ml-2">
                      <Pill tone="warning">Unmapped</Pill>
                    </span>
                  ) : null}
                </td>
                <td role="cell" data-label="Verdict">
                  <span className="flex flex-wrap items-center gap-1">
                    <Pill tone={HEALTH_TONE[row.health]}>{HEALTH_LABEL[row.health]}</Pill>
                    {row.escalated ? <Pill tone="negative">Escalated</Pill> : null}
                  </span>
                </td>
                <td role="cell" data-label="Last success" className="t-small">
                  {describeAge(row.sinceSuccessMs)}
                  <span className="block num t-micro text-subtle">
                    {stamp(row.lastSuccessAt)}
                  </span>
                </td>
                <td role="cell" data-label="Last run" className="num t-small text-muted">
                  {stamp(row.lastRunAt)}
                </td>
                <td role="cell" data-label="Rows" className="cell-num">
                  {row.rowsSynced}
                </td>
                <td role="cell" data-label="Failures" className="cell-num">
                  {row.consecutiveFailures}
                </td>
                <td role="cell" data-label="Cursor" className="num t-micro text-subtle">
                  {row.cursorUpdatedAt ? (
                    <>
                      {stamp(row.cursorUpdatedAt)}
                      <span className="block">{row.cursorId ?? 'no row id'}</span>
                    </>
                  ) : (
                    'not started'
                  )}
                </td>
                <td role="cell" data-label="Last error" className="t-small text-muted">
                  {row.lastError ?? <span className="text-subtle">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>

        {/* The first three are machine state, including the two tables this
            screen reads; the change log has no timestamp to sync on, will be
            the largest table in the database, and is already in every dump. */}
        <p className="mt-4 max-w-prose t-small text-subtle">
          {NOT_MIRRORED_TABLES.join(', ')} are deliberately absent — machine state, or already in
          every dump.
        </p>
      </Section>
    </div>
  );
}
