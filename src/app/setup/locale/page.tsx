import { saveLocaleStep } from '@/app/setup/actions';
import { requireOpenSetup } from '@/app/setup/guard';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, type Option, SelectField, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { StepPanel } from '@/components/setup/StepPanel';

export const dynamic = 'force-dynamic';

/**
 * Step 3. Currency, language, timezone, area unit.
 *
 * The timezone is the one setting in this wizard that changes stored DATA
 * rather than its presentation, which is why this step argues its case with a
 * live comparison instead of a hint.
 */

/**
 * The IANA zone list from the platform rather than a checked-in table: a
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
function isoDateIn(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export default async function LocaleStepPage() {
  const gate = await requireOpenSetup('locale');
  const org = gate.org;

  const now = new Date();
  const stored = org?.timezone ?? null;
  let tenantDate = 'unavailable';
  try {
    if (stored) tenantDate = isoDateIn(stored, now);
  } catch {
    // A stored zone this system does not know. The field below still offers
    // it, and the report simply says so rather than throwing on a setup screen.
  }
  const containerDate = now.toISOString().slice(0, 10);

  return (
    <StepPanel slug="locale" gate={gate}>
      <ActionForm action={saveLocaleStep} submitLabel="Save locale">
        <Notice tone="warning" title="Why the timezone is asked before the first quote exists">
          <p>
            This application runs in a container whose clock is UTC. Three things it decides are
            calendar <em>dates</em> rather than timestamps, and each is computed in your local
            day instead:
          </p>
          <ul className="mt-2 ml-5 list-disc">
            <li>
              <span className="font-semibold">The date a quote carries.</span> A quote written
              in the evening gets <em>tomorrow&apos;s</em> date in a UTC container — dating a
              document a day after the conversation that produced it.
            </li>
            <li>
              <span className="font-semibold">The day it expires.</span> Validity counts forward
              from the quote date, so an error in one moves the other.
            </li>
            <li>
              <span className="font-semibold">Fiscal period boundaries.</span> A year end falls
              on a local calendar day. Computed in UTC, a transaction on the last evening of the
              year lands in the next one — and the document series rolls over with it.
            </li>
          </ul>
          <p className="mt-2">
            Right now this container reads <span className="num">{containerDate}</span> and the
            stored zone reads <span className="num">{tenantDate}</span>.
            {tenantDate !== containerDate
              ? ' They differ at this moment, which is exactly the case the setting exists for.'
              : ' They agree at this moment, which they will not at some hour of every day.'}
          </p>
        </Notice>

        <FieldGrid>
          <TextField
            name="currency"
            label="Currency"
            required
            maxLength={3}
            defaultValue={org?.currency}
            placeholder="ISO 4217 code"
            hint="Three letters. The money formatter takes the symbol from it, so no currency mark is written into the product."
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
            hint="What an area quantity is labelled on a worksheet and a document. It relabels; it does not convert."
          />
          <SelectField
            name="timezone"
            label="Timezone"
            required
            defaultValue={org?.timezone}
            options={timeZoneOptions(stored)}
            hint="An IANA zone name, not an offset: an offset cannot know when the clocks change."
          />
        </FieldGrid>
      </ActionForm>
    </StepPanel>
  );
}
