'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Button, buttonClass } from '@/components/ui/Button';
import { Field, FieldGroup, FormError, SelectField } from '@/components/detail/Fields';
import type { FormAction } from '@/components/detail/form-state';
import { CONTRACT_TYPES, CUSTOMER_TYPES, PROJECT_STAGES } from '@/components/detail/labels';
import { listOptions, type ListRowRef } from '@/app/settings/project-lists';

/** Matches SENTINEL_NEW in the action. */
const NEW = '__new';

export interface CustomerOption {
  id: string;
  name: string;
  companyName: string | null;
}

export interface OpportunityOption {
  id: string;
  customerId: string;
  name: string;
  projectNumber: string;
  stage: string;
  quoteCount: number;
}

export interface TemplateOption {
  id: string;
  name: string;
  projectTypeName: string;
}

const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

/**
 * One form for the whole beginning of a quote.
 *
 * The customer and the opportunity can each be chosen or typed, in the same
 * pass, because the alternative is what this replaced: create a customer,
 * navigate, create a job, navigate, and only then find the quote. Three screens
 * to price a bathroom is why an owner stops at the first one.
 *
 * The two selects are controlled -- the only client state here -- because what
 * the form shows depends on them: choosing a new customer means there cannot be
 * an existing opportunity to attach to, and the opportunity list has to narrow
 * to the customer that was picked. Everything else stays uncontrolled and is
 * read from the FormData, so a typed value survives a failed submit.
 */
export function StartQuoteForm({
  action,
  customers,
  opportunities,
  templates,
  projectTypes,
  companies = [],
  leadSources,
  defaultProvince,
  preselectedCustomerId,
}: {
  action: FormAction;
  customers: CustomerOption[];
  opportunities: OpportunityOption[];
  templates: TemplateOption[];
  /** Every project type, for the new-opportunity picker below. */
  projectTypes: ListRowRef[];
  /**
   * The companies a NEW opportunity may be filed under, active only.
   *
   * Shown only inside the new-opportunity branch: choosing an EXISTING
   * opportunity inherits its company, because a job never moves between them.
   * Empty or one entry renders nothing at all -- a single-company install has
   * no such concept, and a hidden control is still announced by a screen
   * reader.
   */
  companies?: { id: string; label: string }[];
  /** Every lead source, for the new-customer picker below. */
  leadSources: ListRowRef[];
  /**
   * From `organization.province`. The column has no database default on
   * purpose: one there would hardcode a tenant's region.
   */
  defaultProvince: string;
  preselectedCustomerId?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [customerChoice, setCustomerChoice] = useState(preselectedCustomerId ?? '');
  const [opportunityChoice, setOpportunityChoice] = useState('');
  const [templateChoice, setTemplateChoice] = useState('');

  const creatingCustomer = customerChoice === NEW;
  // A customer created in this same submit has nothing to attach to yet, so the
  // choice is not offered rather than offered and then refused.
  const creatingOpportunity = creatingCustomer || opportunityChoice === NEW;

  const mine = opportunities.filter((row) => row.customerId === customerChoice);

  return (
    <form action={formAction} className="grid gap-6">
      <FormError error={state && !state.ok ? state.error : null} />

      <FieldGroup legend="Customer">
        <SelectField
          label="Customer"
          name="customerChoice"
          required
          placeholder="Choose a customer"
          value={customerChoice}
          onChange={(event) => {
            setCustomerChoice(event.target.value);
            // The opportunity list is about to change under it.
            setOpportunityChoice('');
          }}
          options={[
            { value: NEW, label: '+ New customer' },
            ...customers.map((customer) => ({
              value: customer.id,
              label: customer.companyName
                ? `${customer.name} — ${customer.companyName}`
                : customer.name,
            })),
          ]}
        />
        {creatingCustomer ? (
          <>
            <Field
              label="Name"
              name="newCustomerName"
              required
              maxLength={200}
              hint="The person who signs."
            />
            <Field label="Company" name="newCustomerCompany" maxLength={200} />
            <SelectField
              label="Type"
              name="newCustomerType"
              required
              options={options(CUSTOMER_TYPES)}
              defaultValue="residential"
            />
            <Field label="Phone" name="newCustomerPhone" type="tel" maxLength={40} />
            <Field label="Email" name="newCustomerEmail" type="email" maxLength={200} />
            <SelectField
              label="Lead source"
              name="newCustomerLeadSourceId"
              placeholder="Not decided"
              options={listOptions(leadSources)}
              hint="How they found us."
            />
          </>
        ) : null}
      </FieldGroup>

      <FieldGroup legend="Opportunity">
        {creatingCustomer ? (
          <input type="hidden" name="opportunityChoice" value={NEW} />
        ) : (
          <SelectField
            label="Opportunity"
            name="opportunityChoice"
            required
            placeholder={customerChoice ? 'Choose one' : 'Choose a customer first'}
            disabled={!customerChoice}
            value={opportunityChoice}
            onChange={(event) => setOpportunityChoice(event.target.value)}
            hint="Holds every quote for one job; becomes a job once one is accepted."
            options={[
              { value: NEW, label: '+ New opportunity' },
              ...mine.map((row) => ({
                value: row.id,
                label:
                  `${row.projectNumber} — ${row.name} · ${PROJECT_STAGES[row.stage as keyof typeof PROJECT_STAGES] ?? row.stage}` +
                  (row.quoteCount > 0
                    ? ` · ${row.quoteCount} quote${row.quoteCount === 1 ? '' : 's'}`
                    : ''),
              })),
            ]}
          />
        )}

        {creatingOpportunity ? (
          <>
            <Field
              label="Name"
              name="newOpportunityName"
              required
              maxLength={200}
              hint="What this work is called on site."
            />
            {companies.length > 1 ? (
              <SelectField
                label="Company"
                name="companyId"
                required
                placeholder="Choose a company"
                hint="Whose quotes and invoices this job produces. It cannot be changed later."
                options={companies.map((company) => ({
                  value: company.id,
                  label: company.label,
                }))}
              />
            ) : null}
            <SelectField
              label="Type of work"
              name="newOpportunityTypeId"
              required
              placeholder="Choose a type of work"
              options={listOptions(projectTypes)}
            />
            <SelectField
              label="Contract type"
              name="newOpportunityContractType"
              placeholder="Not decided"
              options={options(CONTRACT_TYPES)}
              hint="Decides what the printed quote shows."
            />
            <Field
              label="Site street"
              name="siteAddressLine1"
              maxLength={200}
              hint="Where the work happens, which is not always where the customer lives."
            />
            <Field label="Site city" name="siteCity" maxLength={120} />
            <Field
              label="Province or state"
              name="siteProvince"
              maxLength={40}
              hint={defaultProvince ? 'Defaulted from your organization.' : undefined}
              defaultValue={defaultProvince}
            />
            <Field label="Postal or ZIP code" name="sitePostalCode" maxLength={20} />
          </>
        ) : null}
      </FieldGroup>

      <FieldGroup legend="Starting point" columns={1}>
        <SelectField
          label="Build the lines from"
          name="scopeTemplateId"
          value={templateChoice}
          onChange={(event) => setTemplateChoice(event.target.value)}
          hint="A template fills lines from your measurements below; blank starts empty."
          options={[
            { value: '', label: 'Blank quote — no lines' },
            ...templates.map((template) => ({
              value: template.id,
              label: `${template.name} (${template.projectTypeName})`,
            })),
          ]}
        />

        {/* Measurements drive a template's quantities and are meaningless
            without one: a blank quote has nothing to multiply them by. */}
        {templateChoice ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Floor area"
              name="areaSqft"
              numeric
              inputMode="decimal"
              maxLength={20}
              hint="Square feet. Used by the lines priced per area."
            />
            <Field label="Washrooms" name="washroomCount" numeric inputMode="numeric" maxLength={4} />
            <Field label="Kitchens" name="kitchenCount" numeric inputMode="numeric" maxLength={4} />
            <Field label="Bedrooms" name="bedroomCount" numeric inputMode="numeric" maxLength={4} />
          </div>
        ) : null}
      </FieldGroup>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" pending={pending} pendingLabel="Creating…">
          Create quote
        </Button>
        <Link href="/quotes" className={buttonClass('secondary', { size: 'lg' })}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
