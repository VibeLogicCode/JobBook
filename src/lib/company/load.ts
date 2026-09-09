import { cache } from 'react';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, projects } from '@/db/schema';

export type Company = typeof companies.$inferSelect;

/**
 * Every company, in picker order.
 *
 * `cache()` for the reason `loadOrganization` gives: the root layout, a page
 * title and a page's own notice all want this within one request, and three
 * reads of a two-row table is three round trips for no reason. Per-request,
 * which is correct -- a company edited in Settings must be visible on the next
 * request, not after a deploy.
 *
 * Swallows errors to an EMPTY LIST, exactly as `loadOrganization` swallows to
 * null: a missing database is a setup problem, not a crash, and the caller
 * still has to render the screen that says so. Everything downstream of this
 * has to behave sensibly on an empty list for that reason -- see
 * `lib/posture/read.ts`, which turns it into the fuller form rather than the
 * shorter one.
 */
/**
 * The query, uncached.
 *
 * Split from the cached export below, and not only for testing: `React.cache`
 * is scoped to a request, and in a `node` test environment there is no request
 * -- every file in the suite shares one fork, so a memoised reader hands the
 * second file the first file's rows. That produced a suite where this module's
 * own tests passed alone and failed together, which is the most expensive kind
 * of failure to read.
 *
 * So the cache wraps the query rather than being part of it, and anything that
 * needs to observe the database as it actually is calls this.
 */
export async function readCompanies(): Promise<Company[]> {
  try {
    return await db
      .select()
      .from(companies)
      .where(eq(companies.recordStatus, 'active'))
      .orderBy(asc(companies.sortOrder), asc(companies.displayName));
  } catch {
    // Swallowed to an EMPTY LIST, exactly as `loadOrganization` swallows to
    // null: a missing database is a setup problem, not a crash, and the caller
    // still has to render the screen that says so. Everything downstream has
    // to behave sensibly on an empty list for that reason -- see
    // `lib/posture/read.ts`, which turns it into the fuller form rather than
    // the shorter one.
    return [];
  }
}

/**
 * Every company, in picker order, read once per request.
 *
 * `cache()` for the reason `loadOrganization` gives: the root layout, a page
 * title and a page's own notice all want this within one request, and three
 * reads of a two-row table is three round trips for no reason. Per-request,
 * which is correct -- a company edited in Settings must be visible on the next
 * request, not after a deploy.
 */
export const loadCompanies = cache(readCompanies);

/**
 * Which company to default to, given what exists.
 *
 * PURE, and separate from the read, because this is the RULE rather than the
 * query: the single active company, or null when there are none or more than
 * one.
 *
 * Null on ambiguity rather than "the first one". Guessing which of two
 * registrants issued a document is precisely the mistake this whole split
 * exists to make impossible -- the Input Tax Credit Information Regulations
 * put the supplier's own registration number on the invoice, so a wrong guess
 * makes the customer's tax credit defective on a document they have already
 * filed. A caller that cannot name a company must ask, not be handed one.
 */
export function primaryOf(rows: readonly Company[]): Company | null {
  const active = rows.filter((row) => row.isActive);
  return active.length === 1 ? active[0]! : null;
}

export const primaryCompany = cache(async (): Promise<Company | null> =>
  primaryOf(await loadCompanies()));

export async function loadCompany(id: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  return row ?? null;
}

/**
 * Either the client or a transaction, following `db/seed/reminder-rules.ts`.
 *
 * Most callers are inside the transaction that writes the document -- reading
 * the issuer outside it would let the letterhead come from before a concurrent
 * edit while the numbers come from after. But `lib/quote/load.ts` reads a quote
 * for display and has no transaction to be inside, and forcing one there would
 * open a transaction purely to satisfy a type.
 */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The company a project belongs to.
 *
 * THE function every document goes through, and the replacement for the
 * `organization.id = 1` reads scattered across 28 files.
 * `projects.company_id` is NOT NULL, and every document -- quote, invoice,
 * expense, holdback ledger row, schedule task -- reaches its project through a
 * NOT NULL foreign key of its own, so this one join answers "whose paper is
 * this" for all of them.
 *
 * THROWS rather than returning null. A document whose issuer cannot be
 * resolved must not render with somebody else's letterhead, and there is no
 * sensible fallback available: `id = 1` was the fallback, and it is the bug
 * this replaces.
 *
 * The message says "not found" and not "has no company", because a project
 * with no company is not a state this join can observe: `company_id` is NOT
 * NULL behind a foreign key, so the only way the inner join yields nothing is
 * a project id that does not exist. Saying otherwise sends the reader looking
 * for a data problem that cannot occur, and it is the message every other
 * loader in this codebase already uses for the same condition.
 *
 * Takes an executor because every caller is already inside the transaction
 * that writes the document. Reading the issuer outside it would let the
 * letterhead come from before a concurrent edit while the numbers come from
 * after.
 */
export async function companyOf(tx: Executor, projectId: string): Promise<Company> {
  const [row] = await tx
    .select({ company: companies })
    .from(projects)
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .where(eq(projects.id, projectId));
  if (!row) throw new Error(`project ${projectId} not found`);
  return row.company;
}

/**
 * The province to pre-fill on a new address, or null to leave it blank.
 *
 * ---------------------------------------------------------------------------
 * WHY IT GOES BLANK WITH TWO COMPANIES RATHER THAN PICKING ONE
 * ---------------------------------------------------------------------------
 *
 * Five screens pre-fill a province on a new customer, vendor, job or quote,
 * and all five read it from the company's own address -- "most of my work is
 * where I am" is a good default and saves a selection on every record.
 *
 * With two companies there is no single answer, and `primaryOf` returns null
 * rather than guessing. That is right here for a smaller reason than
 * elsewhere: a wrong pre-filled province is a wrong address on a customer
 * record, and a pre-filled wrong answer is harder to notice than an empty
 * field, because nobody re-reads a field they did not have to fill in.
 *
 * Customers and vendors are SHARED between companies by the owner's own
 * choice, so there is no company to ask even in principle. This is a
 * convenience, not a fact about the record.
 */
export async function defaultProvince(): Promise<string | null> {
  return primaryOf(await readCompanies())?.province ?? null;
}

/**
 * A company's fields, without its identity, for merging over a deployment row.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE READERS SHARE THIS
 * ---------------------------------------------------------------------------
 *
 * `app/settings/load.ts`, `app/setup/state.ts` and the print path all want the
 * same thing: one object a form or a document can read by field name, without
 * caring that the legal name now lives in `companies` and the timezone still
 * lives in `organization`. That is a fact about STORAGE; a form is about what
 * somebody typed.
 *
 * Written once because the exclusion is not obvious and getting it wrong is
 * quiet: `id` exists on both tables and they are not the same type -- the
 * deployment's is an integer and a company's is a uuid. Spreading a whole
 * company row replaced one with the other, and the first thing to break was a
 * settings action writing `where organization.id = 1`.
 */
export function companyFields(company: Company): Omit<Company, 'id'> {
  const { id: _id, ...fields } = company;
  return fields;
}
