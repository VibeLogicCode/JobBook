'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Field, FieldGroup, FormError, SelectField } from '@/components/detail/Fields';
import type { FormAction } from '@/components/detail/form-state';
import { CONTRACT_TYPES, PROJECT_TYPES } from '@/components/detail/labels';

export interface ProjectDraft {
  id?: string;
  customerId?: string | null;
  name?: string | null;
  projectType?: string | null;
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
 * One form for creating and for editing a job.
 *
 * Stage is deliberately absent. It has its own control on the detail screen,
 * because every stage change writes a row of history through a trigger, and a
 * stage buried among fifteen other fields gets moved by accident on the way to
 * fixing a postal code.
 */
export function ProjectForm({
  action,
  project,
  customers,
  defaultProvince,
  cancelHref,
  submitLabel,
  showRealisedDates = false,
}: {
  action: FormAction;
  project?: ProjectDraft;
  customers: { id: string; name: string; companyName: string | null }[];
  /**
   * From `organization.province`. No database default on the column on
   * purpose: a default there would hardcode one tenant's region.
   */
  defaultProvince: string;
  cancelHref: string;
  submitLabel: string;
  /** Only once the job exists: nothing has actually happened to a new one. */
  showRealisedDates?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="grid gap-6">
      {project?.id ? <input type="hidden" name="id" value={project.id} /> : null}

      <FormError error={state && !state.ok ? state.error : null} />

      <FieldGroup legend="Job">
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
          hint="What this job is called on site."
          defaultValue={project?.name ?? ''}
        />
        <SelectField
          label="Type"
          name="projectType"
          required
          options={options(PROJECT_TYPES)}
          defaultValue={project?.projectType ?? 'renovation'}
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

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={pending}
          className="min-h-12 rounded-[4px] bg-accent px-4 text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link
          href={cancelHref}
          className="flex min-h-12 items-center rounded-[4px] border border-line-strong px-4 hover:bg-surface-2"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
