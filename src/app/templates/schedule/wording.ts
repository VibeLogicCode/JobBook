import type { DurationSource } from '@/lib/schedule/template';

/**
 * Turning a template task's raw columns into the sentence the editor prints.
 *
 * Section 5 of `docs/superpowers/specs/2026-09-05-schedule-templates-design.md`
 * is explicit that the table is for READING and the raw numbers are what the
 * edit sheet collects -- "a row storing base 2, source area, area_per_day
 * 300000 should read '2 days, then a day per 300 sqft'." Section 6.3 is
 * equally explicit that a condition, or its absence, must be printed in the
 * editor rather than discovered on the import sheet.
 *
 * Pure and DB-free, like `lib/schedule/template.ts` itself, so a row's wording
 * can be checked against a plain object without a database.
 */

function dayWord(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/** Safe on a string that already starts with a digit -- every "N days, then
 *  ..." case does -- and turns "a day per ..." into "A day per ..." when
 *  there is no base to prefix it with. */
function sentenceCase(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

const SINGULAR_NOUN: Record<'washrooms' | 'kitchens' | 'bedrooms', string> = {
  washrooms: 'washroom',
  kitchens: 'kitchen',
  bedrooms: 'bedroom',
};

export interface DurationWords {
  isMilestone: boolean;
  durationBaseDays: number;
  durationSource: DurationSource;
  /** Thousandths, matching `schedule_template_tasks.duration_area_per_day_milli`. */
  durationAreaPerDayMilli: bigint | null;
  durationDaysPerUnit: number | null;
}

/**
 * "2 days, then a day per 300 sqft" -- section 5's own worked example, kept
 * exact. `formatQty` is injected rather than imported so this file stays
 * dependency-free the way `lib/schedule/template.ts` is; the caller already
 * has `src/lib/money/format.ts`'s version at hand.
 */
export function durationPhrase(
  task: DurationWords,
  areaUnit: string,
  formatQty: (milli: bigint) => string,
): string {
  if (task.isMilestone) return 'Milestone — a single day';

  const base = task.durationBaseDays;

  switch (task.durationSource) {
    case 'area': {
      const rate =
        task.durationAreaPerDayMilli !== null
          ? `a day per ${formatQty(task.durationAreaPerDayMilli)} ${areaUnit}`
          : `a day per unit of ${areaUnit}`;
      return base > 0 ? `${dayWord(base)}, then ${rate}` : sentenceCase(rate);
    }
    case 'washrooms':
    case 'kitchens':
    case 'bedrooms': {
      const noun = SINGULAR_NOUN[task.durationSource];
      const rate =
        task.durationDaysPerUnit !== null
          ? `${dayWord(task.durationDaysPerUnit)} per ${noun}`
          : `a day per ${noun}`;
      return base > 0 ? `${dayWord(base)}, then ${rate}` : sentenceCase(rate);
    }
    case 'none':
    default:
      // The one-day floor is the engine's job (`durationDaysOf`), not this
      // sentence's -- but a row saved before that floor existed, or one
      // holding base 0 some other way, still reads as a day rather than none.
      return dayWord(Math.max(base, 1));
  }
}

/**
 * "Framing, plus 1 day" -- what a task waits on, with its lag folded into the
 * same cell rather than left as a second column nobody reads beside it.
 * `predecessorName` is null for a root.
 */
export function waitsOnPhrase(predecessorName: string | null, lagDays: number): string {
  if (predecessorName === null) return 'Nothing';
  if (lagDays === 0) return predecessorName;
  if (lagDays > 0) return `${predecessorName}, plus ${dayWord(lagDays)}`;
  return `${predecessorName}, minus ${dayWord(-lagDays)}`;
}

export interface ConditionWords {
  conditionMeasurement: 'washrooms' | 'kitchens' | 'bedrooms' | null;
  conditionRateItemId: string | null;
}

/**
 * "When: washrooms", "When: FIN-09 is quoted", or the word `Every job` --
 * section 6.3's own three examples, unchanged. `rateItemCodeById` is read
 * rather than joined here because this stays pure; the caller already has the
 * codes from the same query that lists the picker's options.
 */
export function conditionPhrase(
  task: ConditionWords,
  rateItemCodeById: ReadonlyMap<string, string>,
): string {
  if (task.conditionMeasurement !== null) return `When: ${task.conditionMeasurement}`;
  if (task.conditionRateItemId !== null) {
    const code = rateItemCodeById.get(task.conditionRateItemId) ?? 'a rate item no longer on the list';
    return `When: ${code} is quoted`;
  }
  return 'Every job';
}
