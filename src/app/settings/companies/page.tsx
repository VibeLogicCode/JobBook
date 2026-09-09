import { asc, count, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, projects } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import { addCompany, retireCompany } from '@/app/settings/companies/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the company list but not change it.';

/**
 * The companies this deployment issues documents as.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS AT ALL, GIVEN MOST INSTALLATIONS HAVE ONE COMPANY
 * ---------------------------------------------------------------------------
 *
 * Because the alternative was asking at first run, and that is the one place
 * the question must not be asked: the owner did not know his own legal
 * structure yet -- he said so -- and a contractor looking at a NAS in a
 * browser at 11pm knows less. The wrong answer in the "two companies"
 * direction burdens every single-company customer forever with a picker they
 * never wanted.
 *
 * So the wizard creates one company silently and this screen is where a second
 * one is added months later, by somebody who has since spoken to an
 * accountant. While there is one row, nothing anywhere else in the interface
 * mentions companies: no picker, no column, no filter.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT EDITED HERE
 * ---------------------------------------------------------------------------
 *
 * A name and a document code, and nothing else. The address, the HST
 * registration number, the holdback terms and the footer are edited on the
 * settings screens that exist for exactly those fields -- a second set of
 * forty inputs here would be a second place for them to disagree.
 */
export default async function CompaniesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'organization:edit') : false;

  // Retired rows stay in the list. Their documents are still out there under
  // their letterhead, and the code they issued under is still spoken for in
  // this year's `document_sequences`.
  const rows = await db
    .select()
    .from(companies)
    .orderBy(asc(companies.sortOrder), asc(companies.displayName));

  const jobCounts = await db
    .select({ id: projects.companyId, n: count() })
    .from(projects)
    .groupBy(projects.companyId);
  const jobs = new Map(jobCounts.map((row) => [row.id, Number(row.n)]));

  const activeCount = rows.filter((row) => row.isActive).length;
  const single = rows.length <= 1;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Companies"
        description={
          <p>
            Which legal company issues a job&rsquo;s quotes and invoices. Most businesses have
            one and never open this screen.
          </p>
        }
        actions={
          <SheetButton
            trigger="Add a company"
            variant="primary"
            label="Add a company"
            title="Add a company"
            discardPrompt="Throw away this company? Nothing has been saved yet."
          >
            <ActionForm
              action={addCompany}
              submitLabel="Add company"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <div className="flex flex-col gap-4">
                <Notice tone="info" title="Ask your accountant before you add one">
                  <p>
                    Two corporations under one owner each file their own return and each need
                    their own tax registration. The small-supplier threshold is added up across
                    associated companies, so a second company cannot skip registering just by
                    being small.
                  </p>
                  <p className="mt-2">
                    A job belongs to one company and never moves between them, so this decides
                    which name and tax number every document on it carries — permanently.
                  </p>
                </Notice>

                <FieldGrid>
                  <TextField
                    name="legalName"
                    label="Legal name"
                    hint="Exactly as it is registered. This prints on quotes and invoices."
                    idPrefix="new-company"
                    disabled={!allowed}
                    required
                    wide
                  />
                  <TextField
                    name="displayName"
                    label="Display name"
                    hint="The shorter name people actually use."
                    idPrefix="new-company"
                    disabled={!allowed}
                    required
                  />
                  <TextField
                    name="documentPrefix"
                    label="Document code"
                    hint="Letters and numbers, up to six: RENO gives RENO_QT-2026-0001. Leave blank to number without a code."
                    idPrefix="new-company"
                    disabled={!allowed}
                  />
                </FieldGrid>
              </div>
            </ActionForm>
          </SheetButton>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        {single ? (
          <Notice tone="info" title="Nothing else in the app mentions companies yet">
            <p>
              With one company there is no picker and no extra column anywhere — it is simply
              the company. Add a second and a picker appears on new jobs.
            </p>
          </Notice>
        ) : (
          <Notice tone="info" title="Each company numbers its own documents">
            <p>
              Company one keeps its history and a new company starts at 0001. Nothing is ever
              renumbered, and the code in front of the number is what tells them apart.
            </p>
          </Notice>
        )}

        <TableWrap minWidth="52rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Document code</th>
              <th scope="col" className="cell-num">Jobs</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Company" colSpan={5}>
                  No company yet. Finish first-run setup, which creates one.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const held = jobs.get(row.id) ?? 0;
              const isLastActive = row.isActive && activeCount <= 1;

              return (
                <tr key={row.id}>
                  <td data-label="Company">
                    <span className="flex flex-col">
                      <span>{row.displayName}</span>
                      {row.legalName === row.displayName ? null : (
                        <span className="t-small text-muted">{row.legalName}</span>
                      )}
                    </span>
                  </td>
                  <td data-label="Document code" className="num t-small">
                    {row.documentPrefix ? (
                      `${row.documentPrefix}_QT-2026-0001`
                    ) : (
                      <span className="text-muted">QT-2026-0001</span>
                    )}
                  </td>
                  <AmountCell data-label="Jobs">{held}</AmountCell>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {row.isActive
                        ? <Pill tone="positive">Issuing</Pill>
                        : <Pill tone="neutral">Retired</Pill>}
                    </span>
                  </td>
                  <td data-label="Manage">
                    {row.isActive ? (
                      <RowAction
                        action={retireCompany}
                        label="Retire…"
                        fields={{ id: row.id }}
                        title={`Retire ${row.displayName}`}
                        disabled={!allowed || isLastActive}
                        confirm={
                          held === 0
                            ? `Stop filing new jobs under ${row.displayName}? Nothing is deleted.`
                            : `Stop filing new jobs under ${row.displayName}? Its ${held} ` +
                              `existing ${held === 1 ? 'job keeps' : 'jobs keep'} their numbers ` +
                              `and letterhead.`
                        }
                      />
                    ) : (
                      /* No un-retire, deliberately: a company that stopped
                         issuing and then starts again is a decision with tax
                         consequences, and the honest way back is to say so to
                         whoever maintains the deployment rather than to make
                         it a button. */
                      <span className="t-small text-muted">Retired</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Section>
    </div>
  );
}
