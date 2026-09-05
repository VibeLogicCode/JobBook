import { and, asc, count, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { reminderRules, reminders } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createReminderRule,
  setReminderRuleActive,
  updateReminderRule,
  voidReminderRule,
} from '@/app/settings/reminder-rules/actions';
import {
  FIELD_NOTES,
  KIND_OPTIONS,
  STAGE_OPTIONS,
  TEMPLATE_FIELDS,
  TRIGGER_LABELS,
  TRIGGER_NOTES,
  TRIGGER_OPTIONS,
  directionOf,
  offsetPhrase,
} from '@/app/settings/reminder-rules/schema';
import { PROJECT_STAGES, type ProjectStage } from '@/components/detail/labels';
import { REMINDER_KINDS } from '@/components/reminders/labels';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, ReadOnlyField, SelectField, TextField } from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { Reveal } from '@/components/ui/Reveal';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import type { ReminderTrigger } from '@/lib/reminders/types';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the reminder rules but not change them.';

type RuleRow = typeof reminderRules.$inferSelect;

/** The direction the offset controls default to when a rule is opened. */
const DIRECTION_OPTIONS = [
  { value: 'after', label: 'after' },
  { value: 'before', label: 'before' },
];

/**
 * Grouped by what a rule watches, in the order a job actually goes through it:
 * a quote goes out, it approaches its expiry, a visit is booked, a job is won,
 * a customer goes quiet.
 *
 * Sorted here rather than in SQL because the order is editorial. Alphabetical
 * by name would interleave the two quote rules with the one about silence, and
 * the question this screen is read to answer -- "which of these is making the
 * noise" -- is asked about a kind of event rather than about a name.
 */
function inReadingOrder(rows: RuleRow[]): RuleRow[] {
  const rank = new Map(TRIGGER_OPTIONS.map((option, index) => [option.value, index] as const));
  return [...rows].sort(
    (a, b) =>
      (rank.get(a.trigger) ?? 99) - (rank.get(b.trigger) ?? 99) || a.name.localeCompare(b.name),
  );
}

/** One row per rule, counted once, rather than a count query per row. */
function tally(rows: { id: string | null; n: number }[]): Map<string, number> {
  return new Map(rows.flatMap((row) => (row.id === null ? [] : [[row.id, row.n] as const])));
}

/** The placeholders this trigger can fill, spelled out rather than listed bare. */
function placeholderHint(trigger: ReminderTrigger) {
  return (
    <>
      A closed set of named fields, not a template language. “{TRIGGER_LABELS[trigger]}” can fill
      in{' '}
      {TEMPLATE_FIELDS[trigger].map((field, index) => (
        <span key={field}>
          {index > 0 ? ', ' : ''}
          <span className="font-semibold">{`{${field}}`}</span> ({FIELD_NOTES[field]})
        </span>
      ))}
      . Anything else is refused when you save.
    </>
  );
}

export default async function ReminderRulesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Voided rules stay on the list rather than being filtered away. The
  // evaluator ignores them in SQL, so hiding one would leave the owner unable
  // to see why a rule he remembers writing never fires, and the reminders it
  // produced still point at the row.
  const all = await db.select().from(reminderRules).orderBy(asc(reminderRules.name));
  const rows = inReadingOrder(all);

  const [madeRows, openRows] = await Promise.all([
    db
      .select({ id: reminders.generatedByRuleId, n: count() })
      .from(reminders)
      .where(isNotNull(reminders.generatedByRuleId))
      .groupBy(reminders.generatedByRuleId),
    db
      .select({ id: reminders.generatedByRuleId, n: count() })
      .from(reminders)
      .where(
        and(
          isNotNull(reminders.generatedByRuleId),
          eq(reminders.status, 'open'),
          eq(reminders.recordStatus, 'active'),
        ),
      )
      .groupBy(reminders.generatedByRuleId),
  ]);
  const made = tally(madeRows);
  const open = tally(openRows);

  return (
    <div className="flex flex-col gap-4">
      {/*
       * These are ordinary rows, not built-in behaviour, deliberately: a rule
       * that fires uselessly is something the owner switches off himself, at
       * the moment he notices it, rather than something needing a developer.
       */}
      <Section
        title="Reminder rules"
        description={
          <p>Runs hourly; at most one open reminder per rule per record.</p>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <Notice tone="info" title="Switching a rule off does not undo what it has already done">
          <p>
            Off stops it firing from the next hourly run — it does not delete or hide the
            reminders already produced. Deal with those on the reminders screen.
          </p>
          <p className="mt-2">
            Editing a rule works the same way, forward only: a reminder&rsquo;s wording is set
            once, when it is created, so a later edit changes nothing already on your list.
          </p>
        </Notice>

        <TableWrap minWidth="76rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Watches for</th>
              <th scope="col">Due</th>
              <th scope="col">Kind</th>
              <th scope="col">What it says</th>
              <th scope="col">Has produced</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Rule" colSpan={8}>
                  No rules yet. The five shipped defaults are loaded by the hourly evaluation
                  itself, so they appear here after the first run — or add one of your own below.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const producedCount = made.get(row.id) ?? 0;
              const openCount = open.get(row.id) ?? 0;
              const watchesStage = row.trigger === 'stage_entered';
              const stageMissing = watchesStage && row.triggerStage === null;

              return (
                <tr key={row.id}>
                  <td data-label="Rule">{row.name}</td>
                  <td data-label="Watches for" className="t-small text-muted">
                    {TRIGGER_LABELS[row.trigger]}
                    {watchesStage
                      ? row.triggerStage
                        ? ` — ${PROJECT_STAGES[row.triggerStage as ProjectStage]}`
                        : ' — no stage set, so it watches nothing'
                      : ''}
                  </td>
                  <td data-label="Due" className="t-small text-muted">
                    {offsetPhrase(row.offsetDays, row.trigger)}
                  </td>
                  <td data-label="Kind" className="t-small text-muted">
                    {REMINDER_KINDS[row.reminderKind]}
                  </td>
                  <td data-label="What it says" className="t-small text-muted">
                    {row.titleTemplate}
                  </td>
                  <AmountCell data-label="Has produced">
                    {producedCount === 0
                      ? 'Nothing yet'
                      : `${producedCount} · ${openCount} open`}
                  </AmountCell>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Off</Pill> : null}
                      {!isVoid && row.isActive && stageMissing ? (
                        <Pill tone="warning">Watches nothing</Pill>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    {/* The same press-then-panel the cost code and rate lists
                        take: a disclosure here pushed every rule below this one
                        off the screen, and the list is what somebody is reading
                        while deciding which rule is the noisy one. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={TRIGGER_LABELS[row.trigger]}
                      size="lg"
                      discardPrompt="Throw away the changes to this rule? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this rule</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Changes apply from the next hourly evaluation.
                          </p>
                          <ActionForm
                            action={updateReminderRule}
                            submitLabel="Save this rule"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This rule is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="name"
                                label="Name"
                                required
                                maxLength={120}
                                defaultValue={row.name}
                                disabled={!allowed || isVoid}
                                hint="What this rule is called on this screen. It is never printed on a reminder."
                              />
                              <div className="flex min-w-0 flex-col gap-1 self-start">
                                <ReadOnlyField
                                  label="Watches for"
                                  value={TRIGGER_LABELS[row.trigger]}
                                />
                                <Reveal label="Why this can't change">
                                  A rule pointed at a different event would inherit this row&rsquo;s
                                  open reminders, which quietly suppress it until each is dealt
                                  with. Switch this one off and add the one you meant instead.
                                </Reveal>
                              </div>
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="offsetAmount"
                                label="How long"
                                required
                                numeric
                                inputMode="numeric"
                                maxLength={3}
                                defaultValue={String(Math.abs(row.offsetDays))}
                                disabled={!allowed || isVoid}
                                suffix="days"
                                hint="Zero means the reminder is due on the day of the event itself."
                              />
                              <SelectField
                                idPrefix={`edit-${row.id}`}
                                name="offsetDirection"
                                label="Before or after"
                                defaultValue={directionOf(row.offsetDays)}
                                options={DIRECTION_OPTIONS}
                                disabled={!allowed || isVoid}
                                hint={`Reads as: ${offsetPhrase(row.offsetDays, row.trigger)}.`}
                              />
                              {watchesStage ? (
                                <SelectField
                                  idPrefix={`edit-${row.id}`}
                                  name="triggerStage"
                                  label="Stage"
                                  required
                                  defaultValue={row.triggerStage ?? ''}
                                  options={STAGE_OPTIONS}
                                  blankLabel="Choose a stage"
                                  disabled={!allowed || isVoid}
                                  hint="Required — a rule with no stage set watches nothing."
                                />
                              ) : null}
                              <SelectField
                                idPrefix={`edit-${row.id}`}
                                name="reminderKind"
                                label="Kind of reminder"
                                required
                                defaultValue={row.reminderKind}
                                options={KIND_OPTIONS}
                                disabled={!allowed || isVoid}
                                hint="Labels it on the list. Does not change when it fires."
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="titleTemplate"
                                label="What the reminder says"
                                required
                                maxLength={200}
                                defaultValue={row.titleTemplate}
                                disabled={!allowed || isVoid}
                                wide
                                hint={placeholderHint(row.trigger)}
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Switch it off' : 'Switch it on'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            {row.isActive
                              ? 'Stops it firing. The row stays, and its existing reminders stay open.'
                              : 'Resumes it from today — nothing missed while it was off is backfilled.'}
                          </p>
                          <RowAction
                            action={setReminderRuleActive}
                            label={row.isActive ? 'Switch this rule off' : 'Switch it on'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Switch off ${row.name}? It stops firing.${
                                    // Said only when there is something to say
                                    // it about: "the 0 open reminders it has
                                    // already made stay where they are" reads
                                    // as a bug in the sentence rather than as
                                    // a reassurance.
                                    openCount > 0
                                      ? ` The ${openCount} open reminder${openCount === 1 ? '' : 's'} it has already made ${openCount === 1 ? 'stays' : 'stay'} where ${openCount === 1 ? 'it is' : 'they are'}.`
                                      : ''
                                  }`
                                : undefined
                            }
                          />
                        </div>

                        {isVoid ? (
                          <div>
                            <h3 className="t-small font-semibold">Voided</h3>
                            <p className="max-w-prose t-small text-subtle">
                              {row.voidReason ?? 'No reason was recorded.'}
                            </p>
                          </div>
                        ) : (
                          <div>
                            <h3 className="t-small font-semibold">Void it</h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              For a rule that never should have existed — switch off a noisy one
                              instead.
                            </p>
                            {producedCount > 0 ? (
                              <Notice tone="warning">
                                This rule has already produced {producedCount} reminder
                                {producedCount === 1 ? '' : 's'}, so voiding it will be refused. A
                                rule that has written something somebody read was not a mistake —
                                switch it off instead.
                              </Notice>
                            ) : (
                              <ActionForm
                                action={voidReminderRule}
                                submitLabel="Void this rule"
                                destructive
                                disabled={!mayVoid}
                                disabledNote={
                                  mayVoid
                                    ? undefined
                                    : 'Your role does not permit voiding a record.'
                                }
                              >
                                <input type="hidden" name="id" value={row.id} />
                                <TextField
                                  idPrefix={`void-${row.id}`}
                                  name="reason"
                                  label="Reason"
                                  required
                                  maxLength={300}
                                  disabled={!mayVoid}
                                  wide
                                  hint="Kept on the record permanently."
                                />
                              </ActionForm>
                            )}
                          </div>
                        )}
                      </div>
                    </SheetButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Section>

      <Section
        title="What each event means"
        description={<p>What each of the six events actually watches.</p>}
      >
        <dl className="grid gap-3">
          {TRIGGER_OPTIONS.map((option) => (
            <div key={option.value}>
              <dt className="t-small font-semibold">{option.label}</dt>
              <dd className="max-w-prose t-small text-muted">
                {TRIGGER_NOTES[option.value]}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        title="Add a rule"
        description={<p>Starts switched on. What it watches is fixed once chosen.</p>}
      >
        <ActionForm
          action={createReminderRule}
          submitLabel="Add rule"
          disabled={!allowed}
          disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
          resetOnSuccess
        >
          <FieldGrid>
            <TextField
              idPrefix="new-rule"
              name="name"
              label="Name"
              required
              maxLength={120}
              disabled={!allowed}
              hint="What you will call this rule when you come back to switch it off."
            />
            <SelectField
              idPrefix="new-rule"
              name="trigger"
              label="Watches for"
              required
              options={TRIGGER_OPTIONS}
              blankLabel="Choose an event"
              disabled={!allowed}
              hint="Fixed once the rule exists. See what each one means, above."
            />
            <TextField
              idPrefix="new-rule"
              name="offsetAmount"
              label="How long"
              required
              numeric
              inputMode="numeric"
              maxLength={3}
              defaultValue="3"
              disabled={!allowed}
              suffix="days"
              hint="Zero means due the same day. A year is the ceiling."
            />
            <SelectField
              idPrefix="new-rule"
              name="offsetDirection"
              label="Before or after"
              required
              defaultValue="after"
              options={DIRECTION_OPTIONS}
              disabled={!allowed}
              hint="Before a deadline; after a silence."
            />
            <SelectField
              idPrefix="new-rule"
              name="triggerStage"
              label="Stage"
              options={STAGE_OPTIONS}
              blankLabel="Not a stage rule"
              disabled={!allowed}
              hint="Only for “A job entered a stage” — required there, ignored elsewhere."
            />
            <SelectField
              idPrefix="new-rule"
              name="reminderKind"
              label="Kind of reminder"
              required
              defaultValue="follow_up"
              options={KIND_OPTIONS}
              disabled={!allowed}
            />
            <TextField
              idPrefix="new-rule"
              name="titleTemplate"
              label="What the reminder says"
              required
              maxLength={200}
              disabled={!allowed}
              wide
              hint="One sentence; which placeholders work depends on the event chosen, above."
            />
          </FieldGrid>
        </ActionForm>
      </Section>
    </div>
  );
}
