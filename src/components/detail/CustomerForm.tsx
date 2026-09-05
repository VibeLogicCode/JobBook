'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Button, buttonClass } from '@/components/ui/Button';
import { CheckField, Field, FieldGroup, FormError, SelectField } from '@/components/detail/Fields';
import type { FormAction, FormResult } from '@/components/detail/form-state';
import { CUSTOMER_TYPES, LEAD_SOURCES } from '@/components/detail/labels';
import { restoreInto } from '@/lib/forms/restore-values';

export interface CustomerDraft {
  id?: string;
  name?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  altContactName?: string | null;
  altContactEmail?: string | null;
  altContactPhone?: string | null;
  customerType?: string | null;
  leadSource?: string | null;
  isTaxExempt?: boolean;
  taxExemptNumber?: string | null;
  taxExemptReason?: string | null;
}

const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

/**
 * The fields of a customer, without a `<form>` around them.
 *
 * Split out from `CustomerForm` below so the same fields can be the whole page
 * (creating one, where there is nothing behind to blur) and the body of a
 * `Sheet` (editing one, over the record it is about). The fields, their
 * validation and the shape posted are identical either way, so two field lists
 * would be two places to forget a column.
 */
export function CustomerFields({
  customer,
  defaultProvince,
}: {
  customer?: CustomerDraft;
  /**
   * From `organization.province`. The column carries no database default on
   * purpose -- defaulting it to a province in the schema would hardcode one
   * tenant's region into every deployment -- so the default arrives here, from
   * the tenant's own record, and stays editable.
   */
  defaultProvince: string;
}) {
  // The exemption number and reason are only asked for once the box is ticked:
  // an exemption with no reason recorded is an audit gap, and two disabled
  // fields under an unticked box are noise.
  const [exempt, setExempt] = useState(customer?.isTaxExempt ?? false);

  return (
    <>
      <FieldGroup legend="Customer">
        <Field
          label="Name"
          name="name"
          required
          maxLength={200}
          autoComplete="name"
          defaultValue={customer?.name ?? ''}
        />
        <Field
          label="Company"
          name="companyName"
          maxLength={200}
          autoComplete="organization"
          defaultValue={customer?.companyName ?? ''}
        />
        <SelectField
          label="Type"
          name="customerType"
          required
          options={options(CUSTOMER_TYPES)}
          defaultValue={customer?.customerType ?? 'residential'}
        />
        <SelectField
          label="Lead source"
          name="leadSource"
          placeholder="Not recorded"
          options={options(LEAD_SOURCES)}
          defaultValue={customer?.leadSource ?? ''}
        />
      </FieldGroup>

      <FieldGroup legend="Contact">
        <Field
          label="Email"
          name="email"
          type="email"
          maxLength={200}
          autoComplete="email"
          defaultValue={customer?.email ?? ''}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          inputMode="tel"
          maxLength={40}
          autoComplete="tel"
          defaultValue={customer?.phone ?? ''}
        />
      </FieldGroup>

      <FieldGroup legend="Address">
        <Field
          label="Street"
          name="addressLine1"
          maxLength={200}
          autoComplete="address-line1"
          defaultValue={customer?.addressLine1 ?? ''}
        />
        <Field
          label="Unit or suite"
          name="addressLine2"
          maxLength={200}
          autoComplete="address-line2"
          defaultValue={customer?.addressLine2 ?? ''}
        />
        <Field
          label="City"
          name="city"
          maxLength={120}
          autoComplete="address-level2"
          defaultValue={customer?.city ?? ''}
        />
        <Field
          label="Province or state"
          name="province"
          maxLength={40}
          autoComplete="address-level1"
          hint={defaultProvince ? 'Defaulted from your organization.' : undefined}
          defaultValue={customer?.province ?? defaultProvince}
        />
        <Field
          label="Postal or ZIP code"
          name="postalCode"
          maxLength={20}
          autoComplete="postal-code"
          defaultValue={customer?.postalCode ?? ''}
        />
      </FieldGroup>

      <FieldGroup legend="Second contact">
        <Field
          label="Name"
          name="altContactName"
          maxLength={200}
          hint="A spouse, a property manager, a site contact — whoever also gets called."
          defaultValue={customer?.altContactName ?? ''}
        />
        <Field
          label="Email"
          name="altContactEmail"
          type="email"
          maxLength={200}
          defaultValue={customer?.altContactEmail ?? ''}
        />
        <Field
          label="Phone"
          name="altContactPhone"
          type="tel"
          inputMode="tel"
          maxLength={40}
          defaultValue={customer?.altContactPhone ?? ''}
        />
      </FieldGroup>

      <FieldGroup legend="Tax" columns={1}>
        <CheckField
          label="Exempt from tax"
          name="isTaxExempt"
          checked={exempt}
          onChange={(event) => setExempt(event.currentTarget.checked)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Exemption number"
            name="taxExemptNumber"
            maxLength={80}
            disabled={!exempt}
            hint="Prints on the quote."
            defaultValue={customer?.taxExemptNumber ?? ''}
          />
          <Field
            label="Reason"
            name="taxExemptReason"
            maxLength={300}
            required={exempt}
            disabled={!exempt}
            defaultValue={customer?.taxExemptReason ?? ''}
          />
        </div>
      </FieldGroup>
    </>
  );
}

/**
 * The fields as a page's whole content: creating a customer.
 *
 * EDITING one no longer comes through here -- it opens in a `Sheet` over the
 * record, from `?edit=1`, which is what `EditSheet` is for. This shape is kept
 * for the CREATE screen, where a modal would be a box drawn over an empty page.
 */
export function CustomerForm({
  action,
  customer,
  defaultProvince,
  cancelHref,
  submitLabel,
}: {
  action: FormAction;
  customer?: CustomerDraft;
  defaultProvince: string;
  cancelHref: string;
  submitLabel: string;
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
      {customer?.id ? <input type="hidden" name="id" value={customer.id} /> : null}

      <FormError error={state && !state.ok ? state.error : null} />

      <CustomerFields customer={customer} defaultProvince={defaultProvince} />

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
