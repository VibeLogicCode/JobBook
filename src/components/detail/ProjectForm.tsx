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
  defaultProvince,
  showRealisedDates = false,
}: {
  project?: ProjectDraft;
  customers: { id: string; name: string; companyName: string | null }[];
  /** Every project type, retired and voided included -- see `listOptions`. */
  projectTypes: ListRowRef[];
  /**
   * From `organization.province`. No database default on the column on
   * purpose: a default there would hardcode one tenant's region.
   */
  defaultProvince: string;
  /** Only once the job exists: nothing has actually happened to a new one. */
  showRealisedDates?: boolean;
}) {
  return (
    <>
      <FieldGroup legend="Work">
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
          />
          <Field
            label="Actual end"
            name="actualEnd"
            type="date"
            defaultValue={project?.actualEnd ?? ''}
          />
          <Field
            label="Substantial performance"
            name="substantialPerformanceDate"
            type="date"
            hint="Starts the holdback release clock."
            defaultValue={project?.substantialPerformanceDate ?? ''}
          />
          <Field
            label="Certificate published"
            name="certificatePublishedDate"
            type="date"
            hint="The statutory clock runs from publication, not from the date certified."
            defaultValue={project?.certificatePublishedDate ?? ''}
          />
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
  defaultProvince,
  cancelHref,
  submitLabel,
  showRealisedDates = false,
}: {
  action: FormAction;
  project?: ProjectDraft;
  customers: { id: string; name: string; companyName: string | null }[];
  projectTypes: ListRowRef[];
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
