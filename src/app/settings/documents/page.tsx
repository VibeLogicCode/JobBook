import { saveDocuments } from '@/app/settings/actions';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, ReadOnlyField, TextAreaField, TextField } from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { addDays } from '@/lib/quote/dates';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Editing document text is reserved to an owner.';

/** Today in a zone, as an ISO date. The same construction the locale page explains. */
function isoDateIn(timeZone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export default async function DocumentSettingsPage() {
  const context = await loadSettings('organization.edit');
  const org = context.org;

  const validityDays = org?.quoteValidityDays ?? null;
  let expiryExample: string | null = null;
  if (validityDays !== null) {
    try {
      expiryExample = addDays(isoDateIn(org?.timezone ?? 'UTC'), validityDays);
    } catch {
      // A stored timezone the runtime does not know is the locale section's
      // problem to report, not a reason for this page to fail.
      expiryExample = null;
    }
  }

  // Every string on a generated document comes from the organization
  // record — there is no template with a company name in it.
  return (
    <Section
      title="Documents"
      description={<p>Text that prints on a quote, and how long one stands.</p>}
    >
      <ActionForm
        action={saveDocuments}
        submitLabel="Save document settings"
        disabled={!context.allowed}
        disabledNote={readOnlyNote(context, OWNER_ONLY)}
      >
        <FieldGrid>
          <TextField
            name="quoteValidityDays"
            label="Quote validity"
            required
            inputMode="numeric"
            numeric
            maxLength={4}
            suffix="days"
            defaultValue={validityDays === null ? '' : String(validityDays)}
            hint="Counted forward from the quote date to set the day it expires."
          />
          <ReadOnlyField
            label="A quote written today would stand until"
            value={expiryExample ? <span className="num">{expiryExample}</span> : '—'}
            hint="Computed in your timezone — expiry isn't stored, only calculated live."
          />
          <TextAreaField
            name="quoteTermsText"
            label="Quote terms"
            rows={6}
            defaultValue={org?.quoteTermsText}
            hint="The default terms paragraph on a new quote. A quote may carry its own instead."
          />
          <TextAreaField
            name="documentFooterText"
            label="Document footer"
            rows={3}
            defaultValue={org?.documentFooterText}
            hint="The line at the foot of every page."
          />
        </FieldGrid>
      </ActionForm>
    </Section>
  );
}
