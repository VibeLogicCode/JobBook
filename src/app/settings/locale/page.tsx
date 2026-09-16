import { saveLocale } from '@/app/settings/actions';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, type Option, ReadOnlyField, SelectField, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';
import { formatCents } from '@/lib/money/format';
import { TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Editing locale is reserved to an owner.';

/** A sample amount for the currency preview. Deliberately not a real figure. */
const SAMPLE_CENTS = 123_456;

/**
 * The IANA zone list, from the platform rather than a checked-in table: a
 * hand-maintained list goes stale the next time a country changes its rules,
 * and this one comes from the same ICU data the formatter will use.
 *
 * Cast because the declaration lives in a newer lib than this project targets.
 * Guarded because a minimal ICU build has no list at all, in which case the
 * stored value is still offered and the field still works.
 */
function timeZoneOptions(current: string | null): Option[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  const zones = supported ? supported('timeZone') : [];
  const all = current && !zones.includes(current) ? [current, ...zones] : zones;
  return all.map((zone) => ({ value: zone, label: zone }));
}

/** Today's calendar date in a zone, built from parts rather than trusting one locale's format. */
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

function clockIn(timeZone: string, locale: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(at);
  } catch {
    return 'unavailable — the stored timezone or language tag is not one this system knows';
  }
}

export default async function LocaleSettingsPage() {
  const context = await loadSettings('organization.edit');
  const org = context.org;

  const timezone = org?.timezone ?? 'UTC';
  const locale = org?.locale ?? 'en';
  const now = new Date();

  let tenantDate: string;
  try {
    tenantDate = isoDateIn(timezone, now);
  } catch {
    tenantDate = 'unavailable';
  }
  const utcDate = now.toISOString().slice(0, 10);

  let currencySample: string;
  try {
    currencySample = formatCents(SAMPLE_CENTS, {
      locale,
      currencyCode: org?.currency ?? 'XXX',
    });
  } catch {
    currencySample = 'unavailable — the stored currency code is not one this system knows';
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Locale"
        description={
          <p>How figures print, and today&rsquo;s date; timezone alone changes stored data.</p>
        }
      >
        <ActionForm
          action={saveLocale}
          submitLabel="Save locale"
          disabled={!context.allowed}
          disabledNote={readOnlyNote(context, OWNER_ONLY)}
        >
          <FieldGrid>
            <TextField
              name="currency"
              label="Currency"
              required
              maxLength={3}
              defaultValue={org?.currency}
              placeholder="ISO code"
              hint="Three-letter ISO 4217 code."
            />
            <ReadOnlyField
              label="How money will print"
              value={<span className="num">{currencySample}</span>}
              hint="A sample amount, formatted with the currency and language below."
            />
            <TextField
              name="locale"
              label="Language and region"
              required
              maxLength={35}
              defaultValue={org?.locale}
              placeholder="language-REGION"
              hint="A BCP 47 tag. It decides digit grouping, decimal marks and how dates read."
            />
            <SelectField
              name="areaUnit"
              label="Area unit"
              required
              defaultValue={org?.areaUnit}
              options={[
                { value: 'sqft', label: 'Square feet (sqft)' },
                { value: 'sqm', label: 'Square metres (sqm)' },
              ]}
              hint="Labels an area quantity — it relabels, and does not convert existing values."
            />
            <SelectField
              name="timezone"
              label="Timezone"
              required
              wide
              defaultValue={org?.timezone}
              options={timeZoneOptions(org?.timezone ?? null)}
              hint="An IANA zone name, not an offset — offsets can't track clock changes."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      <Section title="Why the timezone matters">
        <div className="flex flex-col gap-3">
          <p className="max-w-prose t-small text-muted">
            The container&rsquo;s clock is UTC. Every date below is computed in{' '}
            <em>your</em> local day instead:
          </p>
          <ul className="ml-5 max-w-prose list-disc t-small text-muted">
            <li>
              <span className="font-semibold">The date a quote carries.</span> Written at 8pm,
              it could get tomorrow&apos;s date in a UTC container.
            </li>
            <li>
              <span className="font-semibold">The day it expires.</span> Validity counts
              forward from the quote date, so an error in one moves the other.
            </li>
            <li>
              <span className="font-semibold">Fiscal period boundaries.</span> Computed in UTC,
              a transaction late in the year could land in the next one.
            </li>
          </ul>

          <TableWrap minWidth="32rem">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Clock</th>
                <th role="columnheader" scope="col">Calendar date now</th>
                <th role="columnheader" scope="col">Full local time</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              <tr role="row">
                <td role="cell" data-label="Clock">Your timezone ({timezone})</td>
                <td role="cell" data-label="Calendar date now" className="cell-num">
                  {tenantDate}
                </td>
                <td role="cell" data-label="Full local time" className="t-small text-muted">
                  {clockIn(timezone, locale, now)}
                </td>
              </tr>
              <tr role="row">
                <td role="cell" data-label="Clock">The container (UTC)</td>
                <td role="cell" data-label="Calendar date now" className="cell-num">
                  {utcDate}
                </td>
                <td role="cell" data-label="Full local time" className="t-small text-muted">
                  {clockIn('UTC', locale, now)}
                </td>
              </tr>
            </tbody>
          </TableWrap>

          {tenantDate !== utcDate ? (
            <Notice tone="info" title="The two dates differ right now">
              A quote created right now is dated <span className="num">{tenantDate}</span>, not{' '}
              <span className="num">{utcDate}</span>.
            </Notice>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
