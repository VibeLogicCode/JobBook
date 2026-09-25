import { loadOrganization } from '@/lib/organization/load';
import { ALL_MODULES_ON, type ModuleKey, type ModuleState } from '@/lib/modules/types';

/**
 * Which parts of the product this deployment uses.
 *
 * ---------------------------------------------------------------------------
 * DERIVED, NOT A SECOND CACHED READER
 * ---------------------------------------------------------------------------
 *
 * `loadOrganization` is already `cache()`-wrapped and the root layout already
 * calls it on every page, so this is a pure function of a row somebody has
 * read. The posture work settled the same question the same way, and for the
 * reason it learned the hard way: a `cache()` is request-scoped in production
 * and process-wide under a single test fork, so treating one as a data source
 * hands the second test file the first file's rows.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS OPEN
 * ---------------------------------------------------------------------------
 *
 * No organization row, or a database that did not answer, resolves to
 * EVERYTHING ON. That is the safe direction and it is not the obvious one.
 *
 * A switch that hides a destination is not a permission — nothing here
 * protects anything, and the routes keep working when their entry point is
 * gone. So the cost of failing open is an owner seeing a screen he had turned
 * off; the cost of failing closed is an owner opening the app after a blip and
 * finding half his product missing, with no way to tell whether something
 * broke or somebody changed a setting. The first is a nuisance. The second is
 * a support call that starts with "everything is gone".
 */
export type OrganizationModules = {
  modulePipeline: boolean;
  moduleCalendar: boolean;
  moduleExpenses: boolean;
  moduleVendors: boolean;
  moduleTemplates: boolean;
  moduleReminders: boolean;
};

/** The pure half, over a row somebody has already read. */
export function modulesOf(org: Partial<OrganizationModules> | null | undefined): ModuleState {
  if (!org) return ALL_MODULES_ON;
  return {
    pipeline: org.modulePipeline ?? true,
    calendar: org.moduleCalendar ?? true,
    expenses: org.moduleExpenses ?? true,
    vendors: org.moduleVendors ?? true,
    templates: org.moduleTemplates ?? true,
    reminders: org.moduleReminders ?? true,
  };
}

/** The same, read through the layout's cached organization. */
export async function deploymentModules(): Promise<ModuleState> {
  return modulesOf(await loadOrganization());
}

/** Whether one part is on. Reads as a question at the call site. */
export function moduleIsOn(modules: ModuleState, key: ModuleKey): boolean {
  return modules[key];
}
