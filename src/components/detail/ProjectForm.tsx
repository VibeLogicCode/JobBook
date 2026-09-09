'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import { Button, buttonClass } from '@/components/ui/Button';
import { Field, FieldGroup, FormError, SelectField } from '@/components/detail/Fields';
import type { FormAction, FormResult } from '@/components/detail/form-state';
import { CONTRACT_TYPES } from '@/components/detail/labels';
import { listOptions, type ListRowRef } from '@/app/settings/project-lists';
import { restoreInto } from '@/lib/forms/restore-values';

export interface ProjectDraft {
  id?: string;
  customerId?: string | null;
  name?: string | null;
  projectTypeId?: string | null;
  contractType?: string | null;
  siteAddressLine1?: string | null;
  siteCity?: string | null;
  siteProvince?: string | null;
  sitePostalCode?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  actualStart?: string | null;
  actualEnd?: string | null;
  substantialPerformanceDate?: string | null;
  certificatePublishedDate?: string | null;
}

const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

/**
 * The fields of an opportunity, without a `<form>` around them.
 *
 * Split out from `ProjectForm` below so the same fields can be the whole page
 * (starting a new one, where there is nothing behind to blur) and the body of a
 * `Sheet` (editing an existing one, over the record it is about). Two field
 * lists would be two places to forget a column, which is the same reason
 * creating and editing shared one component to begin with.
 *
 * Stage is deliberately absent. It has its own control on the detail screen,
 * because every stage change writes a row of history through a trigger, and a
 * stage buried among fifteen other fields gets moved by accident on the way to
 * fixing a postal code.
 */
export function ProjectFields({
  project,
  customers,
  projectTypes,
  companies = [],
  constructionActDates = true,
  defaultProvince,
  showRealisedDates = false,
}: {
  project?: ProjectDraft;
  customers: { id: string; name: string; companyName: string | null }[];
  /** Every project type, retired and voided included -- see `listOptions`. */
  projectTypes: ListRowRef[];
  /**
   * The companies a NEW job may be filed under, active only.
   *
   * Passed as DATA rather than a rendered picker, because this is a client
   * component and the company list is read on the server. Data also means the
   * rule -- "no picker while there is one company" -- is one comparison in one
   * place rather than a prop somebody can forget to pass.
   *
   * Empty or one entry renders NOTHING: not a hidden input and not a disabled
   * select with one option. A single-company installation has no such concept,
   * and a hidden control is still in the DOM and still announced by a screen
   * reader.
   *
   * Absent on an EDIT, always. A job does not move between companies -- that
   * is what lets every document under it resolve its letterhead through one
   * join and its number series stay untouched forever.
   */
  companies?: { id: string; label: string }[];
  /**
   * From this job's project type. Off hides the substantial performance and
   * certificate dates.
   *
   * Those two dates exist to start the holdback release clock, so on a kind of
   * work that withholds nothing they are a question with no consequence --
   * and worse than merely useless: somebody who fills them in on a service
   * call has been invited to think a release is coming.
   *
   * Defaults to TRUE, so a caller that does not pass it gets today's
   * behaviour. Same direction as the column's own default: the off state is
   * what would change an existing job.
   */
  constructionActDates?: boolean;
  /**
   * From `companies.province`. No database default on the column on
   * purpose: a default there would hardcode one tenant's region.
   */
  defaultProvince: string;
  /** Only once the job exists: nothing has actually happened to a new one. */
  showRealisedDates?: boolean;
}) {
  return (
    <>
      <FieldGroup legend="Work">
        {companies.length > 1 ? (
          <SelectField
            label="Company"
            name="companyId"
            required
            placeholder="Choose a company"
            hint="Whose quotes and invoices this job produces. It cannot be changed later."
            options={companies.map((company) => ({ value: company.id, label: company.label }))}
          />
        ) : null}
        <SelectField
          label="Customer"
          name="customerId"
          required
          placeholder={project?.customerId ? undefined : 'Choose a customer'}
          options={customers.map((customer) => ({
            value: customer.id,
            label: customer.companyName ? `${customer.name} — ${customer.companyName}` : customer.name,
          }))}
          defaultValue={project?.customerId ?? ''}
        />
        <Field
          label="Name"
          name="name"
          required
          maxLength={200}
          hint="What this work is called on site."
          defaultValue={project?.name ?? ''}
        />
        <SelectField
          label="Type"
          name="projectTypeId"
          required
          placeholder={project?.projectTypeId ? undefined : 'Choose a type of work'}
          options={listOptions(projectTypes, project?.projectTypeId)}
          defaultValue={project?.projectTypeId ?? ''}
        />
        <SelectField
          label="Contract type"
          name="contractType"
          placeholder="Not decided"
          options={options(CONTRACT_TYPES)}
          defaultValue={project?.contractType ?? ''}
        />
      </FieldGroup>

      <FieldGroup legend="Site address">
        <Field
          label="Street"
          name="siteAddressLine1"
          maxLength={200}
          hint="Where the work happens, which is not always where the customer lives."
          defaultValue={project?.siteAddressLine1 ?? ''}
        />
        <Field
          label="City"
          name="siteCity"
          maxLength={120}
          defaultValue={project?.siteCity ?? ''}
        />
        <Field
          label="Province or state"
          name="siteProvince"
          maxLength={40}
          hint={defaultProvince ? 'Defaulted from your organization.' : undefined}
          defaultValue={project?.siteProvince ?? defaultProvince}
        />
        <Field
          label="Postal or ZIP code"
          name="sitePostalCode"
          maxLength={20}
          defaultValue={project?.sitePostalCode ?? ''}
        />
      </FieldGroup>

      <FieldGroup legend="Scheduled dates">
        <Field
          label="Scheduled start"
          name="scheduledStart"
          type="date"
          defaultValue={project?.scheduledStart ?? ''}
        />
        <Field
          label="Scheduled end"
          name="scheduledEnd"
          type="date"
          defaultValue={project?.scheduledEnd ?? ''}
        />
      </FieldGroup>

      {showRealisedDates ? (
        <FieldGroup legend="What actually happened">
          {/* Actual dates are their own columns rather than overwriting the
              scheduled ones, which is the only reason slippage stays
              measurable after the fact. */}
          <Field
            label="Actual start"
            name="actualStart"
            type="date"
            defaultValue={project?.actualStart ?? ''}
            hint="The day work really began."
            moreLabel="Why not just change the planned date?"
            more="The planned dates above stay as they were. Keeping both is how you can look back and see that this job started three weeks late — overwrite the plan and that fact is gone, along with any chance of quoting the next one better."
          />
          <Field
            label="Actual end"
            name="actualEnd"
            type="date"
            defaultValue={project?.actualEnd ?? ''}
            hint="The day work really finished."
          />
          {constructionActDates ? (
          <>
          <Field
            label="Substantial performance"
            name="substantialPerformanceDate"
            type="date"
            hint="Starts the clock on getting your holdback."
            moreLabel="What counts as substantial performance?"
            more="Roughly: the job is finished enough for the owner to use it for what it was built for, with only minor items left. It is a defined test under Ontario's Construction Act, not a judgement call, and there is a cost-to-complete threshold in the wording — worth checking with your lawyer on a job near the line. Filling this in is what makes the billing screen able to tell you when the money held back from you becomes yours to invoice."
            defaultValue={project?.substantialPerformanceDate ?? ''}
          />
          <Field
            label="Certificate published"
            name="certificatePublishedDate"
            type="date"
            hint="The day the certificate went out — not the day it was signed."
            moreLabel="Why the published date and not the signed date?"
            more="Once substantial performance is certified, the certificate has to be published. The statutory period runs from that publication. If the certificate sat on somebody's desk for a fortnight before it went out, using the signing date puts your holdback release two weeks earlier than it really is — which is the wrong direction to be wrong in."
            defaultValue={project?.certificatePublishedDate ?? ''}
          />
          </>
          ) : null}
        </FieldGroup>
      ) : null}
    </>
  );
}

/**
 * The fields as a page's whole content: starting an opportunity.
 *
 * EDITING one no longer comes through here -- it opens in a `Sheet` over the
 * job, from `?edit=1`, which is what `EditSheet` is for. This shape is kept for
 * the CREATE screen, where a modal would be a box drawn over an empty page.
 */
export function ProjectForm({
  action,
  project,
  customers,
  projectTypes,
  companies = [],
  constructionActDates = true,
  defaultProvince,
  cancelHref,
  submitLabel,
  showRealisedDates = false,
}: {
  action: FormAction;
  project?: ProjectDraft;
  customers: { id: string; name: string; companyName: string | null }[];
  projectTypes: ListRowRef[];
  /** Only on create. See `ProjectFields`. */
  companies?: { id: string; label: string }[];
  /** From the job's project type. See `ProjectFields`. */
  constructionActDates?: boolean;
  defaultProvince: string;
  cancelHref: string;
  submitLabel: string;
  showRealisedDates?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  /** What was typed, kept so a refusal can put it back. See `restoreInto`. */
  const submitted = useRef<FormData | null>(null);

  const [state, formAction, pending] = useActionState(
    async (previous: FormResult | null, data: FormData) => {
      submitted.current = data;
      return action(previous, data);
    },
    null,
  );

  useEffect(() => {
    const element = form.current;
    if (element && state && !state.ok) restoreInto(element, submitted.current);
  }, [state]);

  return (
    <form ref={form} action={formAction} className="grid gap-6">
      {project?.id ? <input type="hidden" name="id" value={project.id} /> : null}

      <FormError error={state && !state.ok ? state.error : null} />

      <ProjectFields
        project={project}
        customers={customers}
        projectTypes={projectTypes}
        companies={companies}
        constructionActDates={constructionActDates}
        defaultProvince={defaultProvince}
        showRealisedDates={showRealisedDates}
      />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" pending={pending} pendingLabel="Saving…">
          {submitLabel}
        </Button>
        {/* A link, because it changes the URL. `buttonClass` rather than a
            hand-written copy of the same six utilities. */}
        <Link href={cancelHref} className={buttonClass('secondary', { size: 'lg' })}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
