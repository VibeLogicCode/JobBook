import { inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { rateItems, scheduleTemplates, scheduleTemplateTasks, trades } from '@/db/schema';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { seedVendorLists } from '@/db/seed/vendor-lists';

/**
 * ONE worked example, so a fresh install has a real template to look at
 * instead of an empty list -- the same reason `seedLineGroups` and
 * `seedVendorLists` exist, and the same fixed-id, `onConflictDoNothing` shape
 * as both: safe to run more than once, and a row the owner has since edited,
 * reordered, retired or voided is never quietly restored to the shipped
 * wording.
 *
 * A schedule template is not generic taxonomy the way trades and line groups
 * are, though -- every business's own project shapes are its own, which is why
 * there is exactly ONE of these rather than a picklist. It exists to give the
 * template editor (a separate piece of work) something real on day one, and to
 * exercise every shape spec section 5 describes in one dependency chain:
 *
 *   Permit approved       milestone
 *   Site setup            fixed duration
 *   Framing               area-scaled duration
 *   Plumbing rough-in     count-scaled duration, AND a measurement condition
 *   Electrical rough-in   fixed duration (second child of Framing)
 *   Wet bar rough-in      a rate-item condition
 *   Drywall and cleanup   fixed duration
 *
 * `condition_rate_item_id` is the one column this file cannot fill with a
 * fixed id: rate items are a tenant's own price list (`rate_items` ships to no
 * install -- unlike trades, nothing here is generic vocabulary), so the id is
 * resolved by CODE, at seed time, against whatever price list already exists.
 * On a fresh install with no rate items yet that lookup finds nothing and the
 * Wet bar task's condition is left null -- unconditional rather than broken,
 * exactly section 6.3's "no condition means unconditional" default. The demo
 * tenant (`scripts/seed.ts`) loads `FIN-09` before calling this, so there the
 * condition wires up for real.
 */

export const BASEMENT_FINISH_SCHEDULE_TEMPLATE_ID = 'e5f0a1b0-0000-4a00-9000-000000000001';

interface DefaultScheduleTemplateTask {
  id: string;
  name: string;
  /** A trade name, matched case-insensitively against whatever is on `trades` at seed time -- see `seedScheduleTemplates`. Null for a task no single trade owns. */
  tradeName: string | null;
  sortOrder: number;
  isMilestone?: boolean;
  durationBaseDays?: number;
  durationSource: 'none' | 'area' | 'washrooms' | 'kitchens' | 'bedrooms';
  /** Thousandths -- 300000n is "a day per 300 sqft". Required, and only meaningful, when durationSource is 'area'. */
  durationAreaPerDayMilli?: bigint;
  /** Required, and only meaningful, when durationSource is a count. */
  durationDaysPerUnit?: number;
  /** The `id` of another entry in this same list, or undefined for a root. */
  predecessorId?: string;
  lagDays?: number;
  conditionMeasurement?: 'washrooms' | 'kitchens' | 'bedrooms';
  /** Resolved against `rate_items.code` at seed time -- see the file header. */
  conditionRateItemCode?: string;
}

const ID = {
  permitApproved: 'e5f0a1b0-0000-4a00-9000-000000000002',
  siteSetup: 'e5f0a1b0-0000-4a00-9000-000000000003',
  framing: 'e5f0a1b0-0000-4a00-9000-000000000004',
  plumbingRoughIn: 'e5f0a1b0-0000-4a00-9000-000000000005',
  electricalRoughIn: 'e5f0a1b0-0000-4a00-9000-000000000006',
  wetBarRoughIn: 'e5f0a1b0-0000-4a00-9000-000000000007',
  drywallAndCleanup: 'e5f0a1b0-0000-4a00-9000-000000000008',
} as const;

/**
 * Listed in dependency order -- a predecessor's own row always appears before
 * the task that names it, which matters because these are written as one
 * multi-row INSERT and the composite same-template foreign key is checked row
 * by row as each is written.
 */
export const DEFAULT_SCHEDULE_TEMPLATE_TASKS: readonly DefaultScheduleTemplateTask[] = [
  {
    id: ID.permitApproved,
    name: 'Permit approved',
    tradeName: null,
    sortOrder: 10,
    isMilestone: true,
    durationSource: 'none',
  },
  {
    id: ID.siteSetup,
    name: 'Site setup and demolition',
    tradeName: 'Excavation',
    sortOrder: 20,
    durationSource: 'none',
    durationBaseDays: 2,
    predecessorId: ID.permitApproved,
  },
  {
    id: ID.framing,
    name: 'Framing',
    tradeName: 'Framing',
    sortOrder: 30,
    durationSource: 'area',
    durationAreaPerDayMilli: 300000n,
    predecessorId: ID.siteSetup,
    lagDays: 1, // the permit's own final sign-off, not this template's Permit approved milestone
  },
  {
    id: ID.plumbingRoughIn,
    name: 'Plumbing rough-in',
    tradeName: 'Plumbing',
    sortOrder: 40,
    durationSource: 'washrooms',
    durationDaysPerUnit: 2,
    predecessorId: ID.framing,
    conditionMeasurement: 'washrooms',
  },
  {
    id: ID.electricalRoughIn,
    name: 'Electrical rough-in',
    tradeName: 'Electrical',
    sortOrder: 50,
    durationSource: 'none',
    durationBaseDays: 2,
    predecessorId: ID.framing,
  },
  {
    id: ID.wetBarRoughIn,
    name: 'Wet bar rough-in',
    tradeName: 'Framing',
    sortOrder: 60,
    durationSource: 'none',
    durationBaseDays: 1,
    predecessorId: ID.electricalRoughIn,
    conditionRateItemCode: 'FIN-09',
  },
  {
    id: ID.drywallAndCleanup,
    name: 'Drywall and final cleanup',
    tradeName: 'Drywall',
    sortOrder: 70,
    durationSource: 'none',
    durationBaseDays: 3,
    // Follows Wet bar rough-in when it is present; unticking it re-links this
    // straight to Electrical rough-in (spec 7.4's effectiveLink), which is
    // exactly the re-link behaviour this chain is shaped to exercise.
    predecessorId: ID.wetBarRoughIn,
  },
];

/**
 * Loads the template, idempotently. Trades are a dependency of this data
 * (every task above but one names one), so `seedVendorLists` runs first --
 * itself idempotent, so calling it again here costs nothing when a screen has
 * already loaded it.
 *
 * The trade lookup below reads the TABLE rather than trusting
 * `DEFAULT_TRADES`'s own fixed ids, and that is not a style choice.
 * `seedVendorLists`'s `onConflictDoNothing()` is keyed on the name, not the
 * id (see its own comment on why), so a deployment that already has a
 * "Framing" row -- one a person typed, or one migration 0016 promoted from
 * free text -- keeps that row's own id and never gets the fixed one. Trusting
 * the constant here would silently point half this template's tasks at trade
 * ids that do not exist the moment that has happened even once.
 */
export async function seedScheduleTemplates(): Promise<void> {
  await seedVendorLists();

  const tradeRows = await db.select({ id: trades.id, name: trades.name }).from(trades);
  const tradeIdByName = new Map(tradeRows.map((trade) => [trade.name.toLowerCase(), trade.id]));

  const rateItemCodes = DEFAULT_SCHEDULE_TEMPLATE_TASKS
    .map((task) => task.conditionRateItemCode)
    .filter((code): code is string => code !== undefined);
  const rateItemIdByCode = new Map<string, string>();
  if (rateItemCodes.length > 0) {
    const rows = await db
      .select({ id: rateItems.id, code: rateItems.code })
      .from(rateItems)
      .where(inArray(rateItems.code, rateItemCodes));
    for (const row of rows) rateItemIdByCode.set(row.code, row.id);
  }

  await db
    .insert(scheduleTemplates)
    .values({
      id: BASEMENT_FINISH_SCHEDULE_TEMPLATE_ID,
      name: 'Basement finish',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      description: 'Permit through drywall, one washroom -- the worked example for the template editor.',
    })
    .onConflictDoNothing();

  await db
    .insert(scheduleTemplateTasks)
    .values(
      DEFAULT_SCHEDULE_TEMPLATE_TASKS.map((task) => ({
        id: task.id,
        scheduleTemplateId: BASEMENT_FINISH_SCHEDULE_TEMPLATE_ID,
        name: task.name,
        tradeId: task.tradeName ? tradeIdByName.get(task.tradeName.toLowerCase()) ?? null : null,
        sortOrder: task.sortOrder,
        isMilestone: task.isMilestone ?? false,
        durationBaseDays: task.durationBaseDays ?? 0,
        durationSource: task.durationSource,
        durationAreaPerDayMilli: task.durationAreaPerDayMilli ?? null,
        durationDaysPerUnit: task.durationDaysPerUnit ?? null,
        predecessorTaskId: task.predecessorId ?? null,
        lagDays: task.lagDays ?? 0,
        conditionMeasurement: task.conditionMeasurement ?? null,
        conditionRateItemId: task.conditionRateItemCode
          ? rateItemIdByCode.get(task.conditionRateItemCode) ?? null
          : null,
      })),
    )
    .onConflictDoNothing();
}
