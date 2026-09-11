import { saveWorkPosture } from '@/app/settings/actions';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, SelectField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { CompanyScopeNotice } from '@/components/settings/CompanyScopeNotice';
import { Section } from '@/components/settings/Section';
import { POSTURE_LABELS, POSTURE_SUMMARIES, POSTURES } from '@/lib/posture/types';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Changing what kind of work a company does is reserved to an owner.';

/**
 * What kind of work this company does, after first run.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SCREEN AND NOT A WIZARD STEP ONLY
 * ---------------------------------------------------------------------------
 *
 * It was a wizard step only, and that was a false promise: the trade step
 * tells the installer *"Both of these are changeable afterwards"*, the design
 * says *"Changeable in Settings afterwards, always"*, and the column was in
 * fact written once by a screen that then permanently closes itself. A
 * contractor who picked Service work in his first five minutes and then signed
 * a contract job had no way back.
 *
 * ---------------------------------------------------------------------------
 * ITS OWN SCREEN, BESIDE THE COMPANY'S OTHER FIELDS
 * ---------------------------------------------------------------------------
 *
 * `work_posture` is a column on `companies`, not on the deployment -- two
 * sister corporations under one owner genuinely differ here, which is the
 * whole reason the service/contract split was worth building. So this screen
 * carries the same company switcher as Identity and Contact, and saves through
 * the same `patchOrganization` path with the company it rendered from named in
 * a hidden field.
 *
 * The trade PACK is not offered here. A pack is a one-time copy of starter
 * rows, and "load the electrical pack now" over a rate book somebody has been
 * pricing from for a year is the most destructive button this product could
 * grow. Changing posture changes what is offered; it never rewrites a list.
 */
export default async function WorkSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>;
}) {
  const { company } = await searchParams;
  const context = await loadSettings('organization.edit', company ?? null);
  const org = context.org;

  return (
    <div className="flex flex-col gap-4">
      <CompanyScopeNotice
        companies={context.companies}
        companyId={context.companyId}
        basePath="/settings/work"
      />
      <Section
        title="The kind of work"
        description={
          <p>
            This decides which job types are offered on new work, and which fields your forms
            carry — holdback, progress draws, a schedule, measurements.
          </p>
        }
      >
        <ActionForm
          action={saveWorkPosture}
          submitLabel="Save the kind of work"
          disabled={!context.allowed || context.companyId === null}
          disabledNote={readOnlyNote(context, OWNER_ONLY)}
        >
          {context.companyId ? (
            <input type="hidden" name="companyId" value={context.companyId} />
          ) : null}
          <FieldGrid>
            <SelectField
              name="workPosture"
              label="What kind of work does this company do?"
              required
              defaultValue={org?.workPosture ?? 'both'}
              options={POSTURES.map((posture) => ({
                value: posture,
                label: `${POSTURE_LABELS[posture]} — ${POSTURE_SUMMARIES[posture]}`,
              }))}
              wide
              hint="Service work is dispatched and billed once. Contract work is signed, scheduled and billed in draws."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      <Notice tone="info" title="Changing this does not change a job already booked">
        <p>
          A job keeps the paperwork rules of the type it was filed under. A contract already
          signed goes on withholding its holdback and offering its draws even if you switch to
          service work only — the alternative would quietly change the terms of something a
          customer has signed.
        </p>
        <p className="mt-2">
          What changes is what is <em>offered next</em>: which job types appear when you start a
          quote, and whether new jobs of those types ask for measurements, draws and a schedule.
          The rules themselves stay per job type, under{' '}
          <span className="font-semibold">Lists → Job types</span>, where a service company can
          still keep one contract type for the rewire it takes once a year.
        </p>
      </Notice>
    </div>
  );
}
