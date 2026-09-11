import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { projectTypes, projects, quotes } from '@/db/schema';
import { readCompanies } from '@/lib/company/load';
import {
  ALL_FLAGS_ON,
  type ProjectTypeFlags,
  type WorkPosture,
} from '@/lib/posture/types';

/**
 * Posture, derived. NOT a second cached reader.
 *
 * `readCompanies` already exists and the layout already calls its cached
 * wrapper, so everything here is a pure function of rows somebody has read. A
 * second cache would be a second thing to invalidate for no gain -- and the
 * companies work already found what happens when a `cache()` is treated as a
 * data source: it is request-scoped in production and process-wide under a
 * single test fork, so the second test file gets the first file's rows.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS OPEN
 * ---------------------------------------------------------------------------
 *
 * `readCompanies` swallows a database error to an empty list, so a blip
 * resolves posture to `both` and the FULLER forms appear.
 *
 * That is deliberate and it is the safe direction. Posture is not a permission
 * -- nothing here protects anything, it shortens forms. The dangerous failure
 * is the other one: a blip that hid the holdback field on a contract job, or
 * dropped the draw schedule from a screen somebody was using to bill. An extra
 * field is a nuisance; a missing one is a wrong document.
 */
export function postureOf(company: { workPosture: WorkPosture } | null): WorkPosture {
  return company?.workPosture ?? 'both';
}

/**
 * Derived predicates, so a call site reads as a question about the business.
 *
 * Written as functions rather than inline `=== 'service'` comparisons for one
 * reason that matters: a fourth posture would not touch a single call site.
 */
export function offersService(posture: WorkPosture): boolean {
  return posture === 'service' || posture === 'both';
}

export function offersContract(posture: WorkPosture): boolean {
  return posture === 'contract' || posture === 'both';
}

/**
 * Does ANY company in this deployment do contract work?
 *
 * The question the two gated routes have to ask, and the reason it is phrased
 * over the whole deployment rather than per company: `/templates/schedule` is
 * not company-scoped -- a schedule template belongs to a project TYPE, which
 * every company shares -- so it cannot be refused for one company and offered
 * to another. One contract company means the route exists.
 *
 * Fails open on an empty list, per the note above.
 */
export async function hasContractWork(): Promise<boolean> {
  const companies = await readCompanies();
  const active = companies.filter((row) => row.isActive);
  if (active.length === 0) return true;
  return active.some((row) => offersContract(row.workPosture));
}

export async function hasServiceWork(): Promise<boolean> {
  const companies = await readCompanies();
  const active = companies.filter((row) => row.isActive);
  if (active.length === 0) return true;
  return active.some((row) => offersService(row.workPosture));
}

/** Whether a type tagged `posture` should be offered to a company of `companyPosture`. */
export function typeIsOffered(typePosture: WorkPosture, companyPosture: WorkPosture): boolean {
  if (typePosture === 'both') return true;
  if (companyPosture === 'both') return true;
  return typePosture === companyPosture;
}

export type ProjectTypeRow = typeof projectTypes.$inferSelect;

/**
 * The project types a company may file NEW work under.
 *
 * Active and non-void, then filtered by the posture tag. Retired types are
 * excluded here and resolved everywhere else, which is the rule every
 * maintained list in this product follows -- a job already filed as a
 * `Water leak` goes on reading that on its own record forever.
 */
export async function offeredTypes(companyPosture: WorkPosture): Promise<ProjectTypeRow[]> {
  const rows = await db
    .select()
    .from(projectTypes)
    .where(and(eq(projectTypes.isActive, true), eq(projectTypes.recordStatus, 'active')))
    .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name));

  return rows.filter((row) => typeIsOffered(row.posture, companyPosture));
}

/**
 * What kinds of work this DEPLOYMENT takes on, as two booleans.
 *
 * ---------------------------------------------------------------------------
 * WHY A DEPLOYMENT-WIDE ANSWER AND NOT ONE COMPANY'S
 * ---------------------------------------------------------------------------
 *
 * `offeredTypes` takes one company's posture, which is the right question to
 * ask about a company and the wrong one to ask on a form: `/quotes/new`
 * chooses its COMPANY in the same submit as its type of work, so at the moment
 * the picker renders there is no company to filter by. With two companies
 * there may be two different answers.
 *
 * So a type is offered if ANY active company would offer it -- the same shape,
 * and the same reasoning, as `hasContractWork` behind the two gated schedule
 * routes. The action then re-checks, because a picker is not a mechanism.
 *
 * Fails OPEN in both directions: no readable company means both true and every
 * type is offered. Posture shortens forms; it protects nothing.
 */
export interface OfferedWork {
  contract: boolean;
  service: boolean;
}

/**
 * The pure half, over rows somebody has already read.
 *
 * Split exactly the way `readCompanies` / `primaryOf` is split, and for the
 * reason that work discovered the hard way: a `cache()` is request-scoped in
 * production and process-wide under one test fork, so a cached reader used as
 * a data source hands the second test file the first file's rows. A page that
 * has the companies in hand -- `/quotes/new` reads them for its company
 * picker -- passes them here and pays for no second query.
 */
export function offeredWorkFrom(
  rows: readonly { workPosture: WorkPosture; isActive: boolean }[],
): OfferedWork {
  const active = rows.filter((row) => row.isActive);
  // Fail open. See the header.
  if (active.length === 0) return { contract: true, service: true };
  return {
    contract: active.some((row) => offersContract(row.workPosture)),
    service: active.some((row) => offersService(row.workPosture)),
  };
}

export async function offeredWork(): Promise<OfferedWork> {
  return offeredWorkFrom(await readCompanies());
}

/**
 * Whether a type tagged `posture` may take NEW work here.
 *
 * Pure, so every branch is assertable without a database -- and separate from
 * the read above so a page filtering forty rows pays for one query, not forty.
 */
export function postureIsOffered(posture: WorkPosture, offered: OfferedWork): boolean {
  if (posture === 'both') return true;
  return posture === 'contract' ? offered.contract : offered.service;
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What paperwork this kind of work needs.
 *
 * Reads the JOB's own type, never the company's posture, and that distinction
 * is the whole design: a contract signed under a type that withholds holdback
 * goes on withholding it even after the company is switched to service-only.
 * Posture decides what is OFFERED on new work and nothing else.
 *
 * Fails OPEN -- `ALL_FLAGS_ON` -- when the type cannot be read. Same reasoning
 * as `postureOf`: an unreachable row must not silently drop the holdback from
 * a job that agreed to one.
 */
export async function flagsFor(
  executor: Executor,
  projectTypeId: string,
): Promise<ProjectTypeFlags> {
  const [row] = await executor
    .select({
      holdback: projectTypes.holdback,
      progressInvoicing: projectTypes.progressInvoicing,
      scheduleTemplate: projectTypes.scheduleTemplate,
      constructionActDates: projectTypes.constructionActDates,
      scopeInputs: projectTypes.scopeInputs,
    })
    .from(projectTypes)
    .where(eq(projectTypes.id, projectTypeId));

  return row ?? ALL_FLAGS_ON;
}

/**
 * The flags for the type a PROJECT is filed under.
 *
 * One join rather than two reads, and the form every writer actually wants:
 * a quote, an invoice and a schedule all know their project and none of them
 * carries a project type of its own.
 *
 * Fails OPEN for the same reason `flagsFor` does -- see its note. A project
 * that cannot be read must not silently drop the holdback from a job that
 * agreed to one.
 */
export async function flagsForProject(
  executor: Executor,
  projectId: string,
): Promise<ProjectTypeFlags> {
  const [row] = await executor
    .select({
      holdback: projectTypes.holdback,
      progressInvoicing: projectTypes.progressInvoicing,
      scheduleTemplate: projectTypes.scheduleTemplate,
      constructionActDates: projectTypes.constructionActDates,
      scopeInputs: projectTypes.scopeInputs,
    })
    .from(projects)
    .innerJoin(projectTypes, eq(projectTypes.id, projects.projectTypeId))
    .where(eq(projects.id, projectId));

  return row ?? ALL_FLAGS_ON;
}

/**
 * The flags for the type the quote's JOB is filed under.
 *
 * A third shape of the same question, and it earns its place: the worksheet
 * page reads four things in one `Promise.all`, and `flagsForProject` would
 * have had to wait for the quote to come back first to learn its project id.
 * One join instead of a serial round trip in front of the first paint.
 *
 * Fails OPEN like the other two -- see `flagsFor`.
 */
export async function flagsForQuote(
  executor: Executor,
  quoteId: string,
): Promise<ProjectTypeFlags> {
  const [row] = await executor
    .select({
      holdback: projectTypes.holdback,
      progressInvoicing: projectTypes.progressInvoicing,
      scheduleTemplate: projectTypes.scheduleTemplate,
      constructionActDates: projectTypes.constructionActDates,
      scopeInputs: projectTypes.scopeInputs,
    })
    .from(quotes)
    .innerJoin(projects, eq(projects.id, quotes.projectId))
    .innerJoin(projectTypes, eq(projectTypes.id, projects.projectTypeId))
    .where(eq(quotes.id, quoteId));

  return row ?? ALL_FLAGS_ON;
}
