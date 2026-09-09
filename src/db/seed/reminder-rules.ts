import { db } from '@/db/client';
import { reminderRules } from '@/db/schema';
import type { ReminderKind, ReminderTrigger } from '@/lib/reminders/types';

/**
 * The five rules a fresh install starts with.
 *
 * Seeded rather than hardcoded, per the Phase 2 plan: every one of them is an
 * ordinary row the owner can retitle, retime or switch off in settings. A rule
 * that fires uselessly has to be something he can turn off himself, not
 * something that needs a developer.
 *
 * FIVE, and not twenty. The real risk in this phase is not that the engine is
 * wrong -- it is that the owner scrolls past the screen. Five rules that each
 * fire usefully beat twenty that make the list noise, and if the first week
 * produces a screen he ignores, the answer is to cut rules rather than tune
 * them.
 *
 * The ids are fixed so that loading these twice is a no-op (`on conflict do
 * nothing`) and so that a rule the owner has edited, deactivated or voided is
 * never quietly restored to the shipped wording on the next boot. Nothing is
 * ever deleted here, so the row he changed is the row that is still there.
 */

export interface DefaultReminderRule {
  id: string;
  name: string;
  trigger: ReminderTrigger;
  /** Negative means before the anchor date. */
  offsetDays: number;
  reminderKind: ReminderKind;
  /**
   * Placeholders come from a closed set resolved server-side -- `TITLE_FIELDS`
   * in lib/reminders/repository.ts. This is not a template language and must
   * not become one.
   */
  titleTemplate: string;
}

export const DEFAULT_REMINDER_RULES: readonly DefaultReminderRule[] = [
  {
    id: '6a1f0d2e-0000-4a00-9000-000000000001',
    name: 'Follow up on a sent quote',
    trigger: 'quote_sent',
    offsetDays: 3,
    reminderKind: 'follow_up',
    titleTemplate: 'Follow up on quote to {customer}',
  },
  {
    id: '6a1f0d2e-0000-4a00-9000-000000000002',
    name: 'Warn before a quote expires',
    trigger: 'quote_expiring',
    offsetDays: -5,
    reminderKind: 'quote_expiring',
    titleTemplate: 'Quote {number} expires in 5 days',
  },
  {
    id: '6a1f0d2e-0000-4a00-9000-000000000003',
    name: 'Remind the day before a site visit',
    trigger: 'site_visit_scheduled',
    offsetDays: -1,
    reminderKind: 'site_visit',
    titleTemplate: 'Site visit tomorrow at {address}',
  },
  {
    /**
     * The expensive one, and the one most likely to produce noise: it is the
     * only trigger that scans rather than reacting to an event. It is also
     * retrospective -- it asserts something about the past and is false until
     * its day arrives -- so the evaluator holds it back until then rather than
     * putting a permanently wrong row against every customer in the book.
     */
    id: '6a1f0d2e-0000-4a00-9000-000000000004',
    name: 'Chase a customer nobody has spoken to',
    trigger: 'no_activity',
    offsetDays: 14,
    reminderKind: 'callback',
    titleTemplate: 'No contact with {customer} in 14 days',
  },
  {
    id: '6a1f0d2e-0000-4a00-9000-000000000005',
    name: 'Confirm the start of a won job',
    trigger: 'project_won',
    offsetDays: 1,
    reminderKind: 'follow_up',
    /**
     * LEADS WITH THE VERB, and names no project.
     *
     * It read "Won {project} — confirm start date and deposit", which is right
     * on the reminders screen and wrong on a pipeline card: the card is already
     * titled with the project, so the reminder under it repeated the heading
     * above it and buried the only new word in the middle of the line.
     *
     * The project is not lost -- every reminder resolves to the record it
     * belongs to, and both screens show that record. A title's job is to say
     * what to DO.
     */
    titleTemplate: 'Confirm the start date and deposit',
  },
];

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Loads the defaults, idempotently.
 *
 * Safe to call on every boot and on every evaluation: a row whose id is
 * already present is left exactly as the owner last edited it. It is called by
 * the hourly job rather than by `scripts/seed.ts`, because the demo seed does
 * not run on a real installation and the rules have to exist there too.
 */
export async function seedDefaultReminderRules(executor: Executor = db): Promise<number> {
  const inserted = await executor
    .insert(reminderRules)
    .values(
      DEFAULT_REMINDER_RULES.map((rule) => ({
        id: rule.id,
        name: rule.name,
        trigger: rule.trigger,
        triggerStage: null,
        offsetDays: rule.offsetDays,
        reminderKind: rule.reminderKind,
        titleTemplate: rule.titleTemplate,
        isActive: true,
      })),
    )
    .onConflictDoNothing({ target: reminderRules.id })
    .returning({ id: reminderRules.id });

  return inserted.length;
}
