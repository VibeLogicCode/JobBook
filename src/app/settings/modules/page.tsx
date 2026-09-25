import { saveModules } from '@/app/settings/actions';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { ActionForm } from '@/components/settings/ActionForm';
import { CheckboxField, FieldGrid } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';
import { MODULE_LABELS, MODULE_SUMMARIES, MODULES } from '@/lib/modules/types';
import { modulesOf } from '@/lib/modules/read';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Changing what this deployment uses is reserved to an owner.';

/** The form field each switch posts under, matching the organization column. */
const FIELD = {
  pipeline: 'modulePipeline',
  calendar: 'moduleCalendar',
  expenses: 'moduleExpenses',
  vendors: 'moduleVendors',
  templates: 'moduleTemplates',
  reminders: 'moduleReminders',
} as const;

/**
 * Which parts of the product this deployment uses.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LIST OF SWITCHES AND NOT A "SIMPLE MODE"
 * ---------------------------------------------------------------------------
 *
 * The owner asked whether this could be a quote-and-invoice tool for somebody
 * not ready for the rest, switched back on when they are. A mode would have
 * been the obvious shape and the wrong one: a mode is a second product, every
 * later feature needs a "which mode is this in" decision, every support
 * conversation starts with "which mode are you in", and the two halves drift
 * until one is quietly broken. Switches are one product with parts of the menu
 * put away.
 *
 * It is also a DIFFERENT QUESTION from the kind of work. That one asks what
 * paperwork a job needs — holdback, draws, a schedule. This asks how much of
 * the product the business wants in front of it. A one-van electrician may
 * well want expenses; a builder may want nothing but quotes for a month.
 *
 * ---------------------------------------------------------------------------
 * OFF MEANS NOT OFFERED, NEVER BLOCKED
 * ---------------------------------------------------------------------------
 *
 * The screens keep working. A link in a reminder, a bookmark, an address typed
 * from memory — all of them still open, because a switch that produced a dead
 * end would be a setting that breaks the product. What changes is the rail,
 * the phone bar and this menu.
 *
 * Nothing is migrated in either direction, which is what makes this safe to
 * change on a whim: every table stays where it is, so switching the pipeline
 * on after six months shows six months of jobs.
 */
export default async function ModulesSettingsPage() {
  const context = await loadSettings('organization.edit');
  const modules = modulesOf(context.org);

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="What this deployment uses"
        description={
          <p>
            Put away the parts you do not want in front of you. Quotes, invoices, customers, your
            rate book and settings are always here — the rest is yours to choose.
          </p>
        }
      >
        <Notice tone="info" title="Switching something off never deletes anything">
          <p>
            It leaves the menu, not the data. Everything already recorded stays exactly where it
            is, and switching it back on shows the same screens over the same records — so turning
            the pipeline on after six months shows six months of jobs.
          </p>
          <p className="mt-2">
            A link somebody already has still opens. This decides what is offered, the same way a
            retired job type stops being offered and still reads on the jobs that carry it.
          </p>
        </Notice>

        <div className="mt-4">
          <ActionForm
            action={saveModules}
            submitLabel="Save"
            disabled={!context.allowed}
            disabledNote={readOnlyNote(context, OWNER_ONLY)}
          >
            <FieldGrid>
              {MODULES.map((key) => (
                <CheckboxField
                  key={key}
                  name={FIELD[key]}
                  label={MODULE_LABELS[key]}
                  hint={MODULE_SUMMARIES[key]}
                  defaultChecked={modules[key]}
                  disabled={!context.allowed}
                  wide
                />
              ))}
            </FieldGrid>
          </ActionForm>
        </div>
      </Section>
    </div>
  );
}
