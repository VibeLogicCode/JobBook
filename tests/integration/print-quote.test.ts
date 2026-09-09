import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  customers, organization, companies, projects, quoteLines, quoteTaxes, quotes, taxRates,
} from '@/db/schema';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { closeBrowser, renderPdf } from '@/lib/documents/pdf';
import { formatCents, formatQty, formatRate, parseAmountToCents } from '@/lib/money/format';
import { selectRatesInForce, type TaxRateInput } from '@/lib/quote/tax';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';

/**
 * The quote document's CONTENT.
 *
 * `pdf.test.ts` covers the pipeline against a stub page and records, in its own
 * header, that the template is uncovered because asserting on it needs a
 * running Next server. This file is that gap closed: it drives the real
 * `/print/quote/[id]` route on a running server, backed by the real database,
 * and checks what a customer would actually read.
 *
 * Three deliberate choices, each of which is the difference between coverage
 * and the appearance of coverage:
 *
 * 1. Assertions are made against the RENDERED DOM, never against PDF bytes. A
 *    PDF's content streams are compressed, so no string on the document is in
 *    the bytes; a regex over them passes for no reason. The DOM asserted here
 *    is the same DOM Chromium paginates, reached through the same render
 *    secret, so the distance between what is asserted and what is printed is
 *    the paginator alone -- which is what `pdf.test.ts` covers.
 *
 * 2. No expected value is written down. Every figure, name and label is
 *    derived by querying the database and, where it is arithmetic, by running
 *    the calculation engine (`computeQuote`) over the stored line inputs. A
 *    literal expectation here would either be a tenant's data in the
 *    repository or a number that agrees with the template because both were
 *    typed by the same hand.
 *
 * 3. No quote id is hardcoded. The suite enumerates every active quote in the
 *    database and prints all of them, so it follows the data rather than one
 *    machine's seed. It does still REQUIRE data: with an empty database it has
 *    nothing to print, and it says so rather than passing.
 *
 * WHAT IT NEEDS, and what happens when it does not have it: a running app
 * server whose database is the one this file reads, and INTERNAL_RENDER_SECRET
 * set to that server's secret. Vitest loads `.env`, so a normal development
 * checkout supplies both. If no server answers, the whole suite SKIPS with a
 * printed reason -- visibly, in the runner's output, never as a pass. Set
 * PRINT_TEST_BASE_URL to point it at a server on a non-default port.
 *
 * The database read here is the DEVELOPMENT database (DATABASE_URL), not
 * TEST_DATABASE_URL, because that is the one the running server serves from.
 * `@/db/client` deliberately switches to TEST_DATABASE_URL under Vitest, so it
 * cannot be used and a private read-only connection is opened instead. Nothing
 * in this file writes.
 */

const SECRET = process.env.INTERNAL_RENDER_SECRET;

/**
 * Where the server might be, most specific first.
 *
 * The middle three mirror how `api/quotes/[id]/pdf` builds the URL it hands
 * Chromium, so the ordinary case needs no configuration. A candidate is
 * accepted only after it serves a known quote's own number back (see
 * `findServer`), so an unrelated process on one of these ports is rejected
 * rather than tested against.
 */
const BASE_CANDIDATES = [
  process.env.PRINT_TEST_BASE_URL,
  process.env.INTERNAL_BASE_URL,
  process.env.APP_PORT ? `http://127.0.0.1:${process.env.APP_PORT}` : undefined,
  process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : undefined,
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3200',
];

/** JS \s covers the non-breaking spaces Intl and the DOM both produce. */
function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

interface PrintedRow {
  group: string;
  items: string[];
  amount: string;
}

interface TotalRow {
  label: string;
  amount: string;
  grand: boolean;
}

interface UpgradeRow {
  text: string;
  amount: string;
}

interface DocumentView {
  heading: string;
  meta: Record<string, string>;
  company: string;
  contact: string[];
  parties: Record<string, string>;
  groups: PrintedRow[];
  totals: TotalRow[];
  upgrades: UpgradeRow[] | null;
  upgradesNote: string | null;
  signatureLabels: string[];
  logoSources: string[];
  /** Everything a reader sees, normalised. */
  text: string;
  /** Only the regions that carry money, for the scaled-integer sweep. */
  moneyText: string;
}

interface Fixture {
  id: string;
  quoteNumber: string;
  version: number;
  kind: string;
  quoteDate: string;
  validUntil: string;
  pricingDisplay: string;
  customerName: string;
  projectName: string;
  siteAddress: string | null;
  customerExempt: boolean;
  /**
   * What the job is contracted as, because it decides what this document is
   * allowed to say. A lump sum is ONE price for a scope: itemising it invites
   * the customer to argue a single line and to cherry-pick items out. Every
   * other type prints in full, and a null prints as it always did -- a
   * customer's contract is not something to guess from a missing value.
   */
  contractType: string | null;
  storedSubtotalCents: number;
  storedTaxTotalCents: number;
  storedTotalCents: number;
  storedTotalCostCents: number;
  lines: (typeof quoteLines.$inferSelect)[];
  taxes: (typeof quoteTaxes.$inferSelect)[];
  /** What the engine makes of the stored line inputs, with no tax applied. */
  display: ReturnType<typeof computeQuote>;
  /** The same lines priced with the configured rates in force on the quote date. */
  withTax: ReturnType<typeof computeQuote>;
  /**
   * True when the quote's stored tax snapshot still matches the configured
   * rates, so `withTax` is a fair comparison. A rate change after a quote was
   * written makes them differ legitimately -- a stored quote is never
   * recomputed against today's rates -- so the recomputation is skipped rather
   * than turned into a false failure.
   */
  taxSnapshotMatchesConfig: boolean;
}

function toLineInput(row: typeof quoteLines.$inferSelect): LineInput {
  return {
    code: row.code,
    description: row.description,
    lineGroup: row.lineGroup,
    sortOrder: row.sortOrder,
    calcMode: row.calcMode,
    unitLabel: row.unitLabel,
    qtyMilli: row.qtyMilli,
    unitCostTenThou: row.unitCostTenThou,
    unitPriceTenThou: row.unitPriceTenThou,
    isTaxable: row.isTaxable,
    isOptional: row.isOptional,
    isIncluded: row.isIncluded,
    isAllowance: row.isAllowance,
    rateItemId: row.rateItemId,
    costCodeId: row.costCodeId,
  };
}

async function findServer(probeId: string, expected: string): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of BASE_CANDIDATES) {
    if (!candidate) continue;
    const base = candidate.replace(/\/+$/, '');
    if (seen.has(base)) continue;
    seen.add(base);
    try {
      const response = await fetch(`${base}/print/quote/${probeId}`, {
        headers: { 'x-render-secret': SECRET as string },
        // A dev server compiles the route on first request, which is slow once.
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) continue;
      // Identity, not liveness: the page must be THIS quote from THIS database,
      // otherwise the expectations below are derived from a different server's
      // data and every comparison is meaningless.
      if ((await response.text()).includes(expected)) return base;
    } catch {
      // Nothing listening, or not an app. Try the next candidate.
    }
  }
  return null;
}

interface Loaded {
  base: string;
  /**
   * The letterhead, merged from the deployment row and its company.
   *
   * The printed document reads them as one block -- name, address, HST number,
   * logo -- and asserting against that block should not require this file to
   * know that `legalName` moved to `companies` while `locale` stayed. It is
   * also the shape the print page itself now assembles.
   */
  org: typeof organization.$inferSelect & Omit<typeof companies.$inferSelect, 'id'>;
  fixtures: Fixture[];
}

async function load(): Promise<Loaded> {
  if (!SECRET) throw new Error('INTERNAL_RENDER_SECRET is not set');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 2 });
  try {
    const db = drizzle(sql);

    const [deployment] = await db.select().from(organization).where(eq(organization.id, 1));
    const [issuer] = await db.select().from(companies)
      .where(eq(companies.id, FIRST_COMPANY_ID));
    if (!deployment || !issuer) {
      throw new Error('this database has no organization or company row');
    }
    // Merged, because the printed letterhead is one block: the deployment
    // supplies the locale and the company supplies everything a customer
    // reads. This file opens its own connection, so it cannot use the shared
    // `readDeployment` helper.
    const { id: _issuerId, ...issuerFields } = issuer;
    const org = { ...deployment, ...issuerFields };
    if (!org) throw new Error('no organization row; run the seed');

    const rateRows = await db
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.isActive, true), eq(taxRates.recordStatus, 'active')))
      .orderBy(asc(taxRates.sortOrder));
    const configured: TaxRateInput[] = rateRows.map((row) => ({
      label: row.label,
      registrationNumber: row.registrationNumber,
      rateTenThou: row.rateTenThou,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isCompound: row.isCompound,
      sortOrder: row.sortOrder,
    }));

    const quoteRows = await db
      .select({
        quote: quotes,
        projectName: projects.name,
        siteAddressLine1: projects.siteAddressLine1,
        siteCity: projects.siteCity,
        customerName: customers.name,
        customerExempt: customers.isTaxExempt,
        contractType: projects.contractType,
      })
      .from(quotes)
      .innerJoin(projects, eq(quotes.projectId, projects.id))
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(eq(quotes.recordStatus, 'active'))
      .orderBy(asc(quotes.quoteNumber), asc(quotes.version));

    const fixtures: Fixture[] = [];
    for (const row of quoteRows) {
      const lines = await db
        .select()
        .from(quoteLines)
        .where(and(eq(quoteLines.quoteId, row.quote.id), eq(quoteLines.recordStatus, 'active')))
        .orderBy(asc(quoteLines.sortOrder));
      const taxes = await db
        .select()
        .from(quoteTaxes)
        .where(and(eq(quoteTaxes.quoteId, row.quote.id), eq(quoteTaxes.recordStatus, 'active')))
        .orderBy(asc(quoteTaxes.sortOrder));

      const inputs = lines.map(toLineInput);
      const inForce = selectRatesInForce(configured, row.quote.quoteDate);
      const expectedSnapshot = row.customerExempt ? [] : inForce;

      fixtures.push({
        id: row.quote.id,
        quoteNumber: row.quote.quoteNumber,
        version: row.quote.version,
        kind: row.quote.kind,
        quoteDate: row.quote.quoteDate,
        validUntil: row.quote.validUntil,
        pricingDisplay: row.quote.pricingDisplay,
        customerName: row.customerName,
        projectName: row.projectName,
        siteAddress:
          [row.siteAddressLine1, row.siteCity].filter(Boolean).join(', ') || null,
        customerExempt: row.customerExempt,
        contractType: row.contractType,
        storedSubtotalCents: row.quote.subtotalCents,
        storedTaxTotalCents: row.quote.taxTotalCents,
        storedTotalCents: row.quote.totalCents,
        storedTotalCostCents: row.quote.totalCostCents,
        lines,
        taxes,
        // Exactly what `loadQuote` runs to obtain displayPriceCents: the line
        // arithmetic alone, with tax deliberately out of the way.
        display: computeQuote(inputs, [], {
          onDate: row.quote.quoteDate,
          customerExempt: true,
        }),
        withTax: computeQuote(inputs, configured, {
          onDate: row.quote.quoteDate,
          customerExempt: row.customerExempt,
        }),
        taxSnapshotMatchesConfig:
          expectedSnapshot.length === taxes.length &&
          expectedSnapshot.every(
            (rate, index) =>
              rate.label === taxes[index]?.label &&
              rate.rateTenThou === taxes[index]?.rateTenThou,
          ),
      });
    }

    if (fixtures.length === 0) throw new Error('no active quotes in the database; run the seed');

    const base = await findServer(fixtures[0]!.id, fixtures[0]!.quoteNumber);
    if (!base) {
      throw new Error(
        `no app server served ${fixtures[0]!.quoteNumber} from this database on any of ` +
          `${BASE_CANDIDATES.filter(Boolean).join(', ')} -- start one, or set PRINT_TEST_BASE_URL`,
      );
    }

    return { base, org, fixtures };
  } finally {
    await sql.end();
  }
}

let loaded: Loaded | null = null;
let skipReason = '';
try {
  loaded = await load();
} catch (error) {
  skipReason = error instanceof Error ? error.message : String(error);
  console.warn(`[print-quote] SKIPPED: ${skipReason}`);
}

const fixtures = loaded?.fixtures ?? [];
const org = loaded?.org;
const base = loaded?.base ?? '';

async function readDocument(browser: Browser, id: string): Promise<DocumentView> {
  const context = await browser.newContext({
    // The same header `renderPdf` sends, from the same variable. The route
    // authenticates on nothing else, and weakening it to suit a test would
    // remove the only thing standing in front of every customer's contract.
    extraHTTPHeaders: { 'x-render-secret': SECRET as string },
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${base}/print/quote/${id}`, { waitUntil: 'load' });
    if (!response?.ok()) throw new Error(`print page returned ${response?.status() ?? 'nothing'}`);
    await page.waitForSelector('.doc');

    const raw = await page.evaluate(() => {
      const read = (element: Element | null | undefined) => element?.textContent ?? '';
      const doc = document.querySelector('.doc');

      // The document carries its stylesheet inline, and textContent would
      // otherwise fold every CSS declaration into what the reader "sees" --
      // which quietly satisfies any assertion looking for a word like margin.
      const prose = doc?.cloneNode(true) as Element | undefined;
      for (const style of Array.from(prose?.querySelectorAll('style') ?? [])) style.remove();

      const meta: Record<string, string> = {};
      for (const tr of Array.from(doc?.querySelectorAll('.docmeta tr') ?? [])) {
        meta[read(tr.querySelector('th'))] = read(tr.querySelector('td'));
      }

      const parties: Record<string, string> = {};
      for (const block of Array.from(doc?.querySelectorAll('.parties > div') ?? [])) {
        parties[read(block.querySelector('h3'))] = read(block.querySelector('p'));
      }

      const scopeTable = doc?.querySelector(':scope > table.lines') ?? null;
      const groups = Array.from(scopeTable?.querySelectorAll('tbody > tr') ?? []).map((tr) => ({
        group: read(tr.querySelector('td strong')),
        items: Array.from(tr.querySelectorAll('td li')).map((li) => read(li)),
        amount: read(tr.querySelector('td.right')),
      }));

      const totals = Array.from(doc?.querySelectorAll('table.totals tbody > tr') ?? []).map(
        (tr) => ({
          label: read(tr.querySelector('th')),
          amount: read(tr.querySelector('td')),
          grand: tr.classList.contains('grand'),
        }),
      );

      const upgradeSection = doc?.querySelector('section.upgrades') ?? null;
      const upgrades = upgradeSection
        ? Array.from(upgradeSection.querySelectorAll('tbody > tr')).map((tr) => ({
            text: read(tr.querySelector('td')),
            amount: read(tr.querySelector('td.right')),
          }))
        : null;

      return {
        heading: read(doc?.querySelector('.docmeta h2')),
        meta,
        company: read(doc?.querySelector('h1.company')),
        contact: Array.from(doc?.querySelectorAll('header .contact') ?? []).map((p) => read(p)),
        parties,
        groups,
        totals,
        upgrades,
        upgradesNote: upgradeSection ? read(upgradeSection.querySelector('p.note')) : null,
        signatureLabels: Array.from(doc?.querySelectorAll('.signature p') ?? []).map((p) =>
          read(p),
        ),
        logoSources: Array.from(doc?.querySelectorAll('img') ?? []).map(
          (img) => img.getAttribute('src') ?? '',
        ),
        text: read(prose),
        moneyText: [
          read(scopeTable),
          read(doc?.querySelector('table.totals')),
          read(upgradeSection),
        ].join('   '),
      };
    });

    const mapValues = (record: Record<string, string>) =>
      Object.fromEntries(Object.entries(record).map(([key, value]) => [norm(key), norm(value)]));

    return {
      heading: norm(raw.heading),
      meta: mapValues(raw.meta),
      company: norm(raw.company),
      contact: raw.contact.map(norm),
      parties: mapValues(raw.parties),
      groups: raw.groups.map((row) => ({
        group: norm(row.group),
        items: row.items.map(norm),
        amount: norm(row.amount),
      })),
      totals: raw.totals.map((row) => ({
        label: norm(row.label),
        amount: norm(row.amount),
        grand: row.grand,
      })),
      upgrades: raw.upgrades?.map((row) => ({ text: norm(row.text), amount: norm(row.amount) })) ?? null,
      upgradesNote: raw.upgradesNote === null ? null : norm(raw.upgradesNote),
      signatureLabels: raw.signatureLabels.map(norm),
      logoSources: raw.logoSources,
      text: norm(raw.text),
      moneyText: norm(raw.moneyText),
    };
  } finally {
    await context.close();
  }
}

/**
 * Asserts a printed amount both ways round.
 *
 * `toBe(formatCents(...))` pins the exact string a customer reads, and parsing
 * it back pins the value that string denotes. Together they are the whole of
 * "money is unscaled and formatted": a raw `7506514` fails the first because it
 * is not the formatted form, and the second because parsing it yields a figure
 * a hundred times too large.
 */
function expectAmount(printed: string, expectedCents: number, what: string): void {
  expect(printed, `${what}: formatted amount`).toBe(norm(formatCents(expectedCents)));
  expect(parseAmountToCents(printed), `${what}: parsed back to cents`).toBe(expectedCents);
  expect(printed, `${what}: ends in two decimal places`).toMatch(/\d\.\d{2}$/);
}

describe.skipIf(loaded === null)('the printed quote document', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    // `renderPdf` keeps its own browser for the life of the process, so without
    // this the suite holds a live Chromium and never exits.
    await closeBrowser();
  });

  it('has quotes to print, so the per-quote assertions below are not vacuous', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  /**
   * A tripwire, not coverage. The template always groups included lines, and
   * never reads `quote.pricingDisplay` -- so a quote stored as `detailed` or
   * `lump_sum` silently prints group totals instead. Nothing in the current
   * data is in either mode, which is exactly why the defect is invisible; this
   * fails the moment one exists, and names the branch that does not.
   */
  it('prints no quote whose pricing display mode the template does not implement', () => {
    const unsupported = fixtures
      .filter((fixture) => fixture.pricingDisplay !== 'group_totals')
      .map((fixture) => `${fixture.quoteNumber} v${fixture.version} is ${fixture.pricingDisplay}`);
    expect(unsupported).toEqual([]);
  });

  it('refuses the print route outright when the render secret is absent or wrong', async () => {
    const target = `${base}/print/quote/${fixtures[0]!.id}`;

    const bare = await fetch(target);
    expect(bare.status).toBe(401);

    const wrong = await fetch(target, { headers: { 'x-render-secret': `${SECRET}-not` } });
    expect(wrong.status).toBe(401);

    // And the refusal is a refusal, not a document with an error message in it.
    expect(await bare.text()).not.toContain('Quotation');
  }, 60_000);

  it('renders a real quote through the real pipeline, end to end', async () => {
    // `pdf.test.ts` proves the pipeline against a stub page; this proves the
    // pipeline and the real route together -- that the template compiles, its
    // data loads, its fonts settle, and Chromium gets far enough to paginate.
    // The STRINGS are asserted on the DOM above and below, never on these
    // bytes: a PDF's content streams are compressed and contain none of them.
    const pdf = await renderPdf({ url: `${base}/print/quote/${fixtures[0]!.id}` });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?![sR])/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('renders nothing for a quote id that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(renderPdf({ url: `${base}/print/quote/${missing}` })).rejects.toThrow(/404/);
  }, 60_000);

  describe.each(fixtures)('$quoteNumber v$version', (fixture) => {
    let doc: DocumentView;

    beforeAll(async () => {
      doc = await readDocument(browser, fixture.id);
    }, 120_000);

    it('identifies the right document, customer and project', () => {
      expect(doc.heading).toBe(fixture.kind === 'change_order' ? 'Change Order' : 'Quotation');
      expect(doc.meta.Number).toBe(fixture.quoteNumber);
      expect(doc.meta.Version).toBe(String(fixture.version));
      expect(doc.meta.Date).toBe(fixture.quoteDate);
      expect(doc.meta['Valid until']).toBe(fixture.validUntil);
      expect(doc.parties['Prepared for']).toBe(norm(fixture.customerName));
      expect(doc.parties.Project).toBe(norm(fixture.projectName));
      expect(doc.parties.Site).toBe(norm(fixture.siteAddress ?? fixture.projectName));
    });

    it('carries the letterhead from the organization record and nowhere else', () => {
      // Compared against what the database holds rather than against a literal:
      // a company name written into this file would be a tenant's data in the
      // repository, and would ship to the next company that buys the product.
      expect(doc.company).toBe(norm(org!.displayName));
      const contact = doc.contact.join(' | ');
      for (const part of [org!.addressLine1, org!.city, org!.phone, org!.email]) {
        if (part) expect(contact).toContain(norm(part));
      }
      if (org!.taxRegistrationNumber) {
        expect(contact).toContain(norm(org!.taxRegistrationNumber));
        expect(contact).toContain(norm(org!.taxRegistrationLabel ?? 'Tax number'));
      }
    });

    it('inlines the letterhead logo rather than linking to an authenticated route', () => {
      // Chromium fetches this page with only the render secret, so a src that
      // points at the file route would 401 and the customer would receive a
      // contract with a broken image where the letterhead should be.
      for (const src of doc.logoSources) expect(src.startsWith('data:')).toBe(true);
      if (org!.logoFileId) expect(doc.logoSources.length).toBeGreaterThan(0);
    });

    it('prints every included line, whatever the contract says about prices', () => {
      // The SCOPE is the same document either way. What changes is whether a
      // figure sits beside each part of it, and a lump sum that quietly
      // dropped a line would be a different promise, not a tidier one.
      const included = fixture.lines.filter((line) => line.isIncluded);
      for (const line of included) {
        expect(doc.text, `${line.description} is in the scope`).toContain(norm(line.description));
      }
    });

    /**
     * The unchanged path, and it is unchanged on purpose.
     *
     * A quote whose job has no contract type recorded prints exactly as this
     * product always printed it: grouped by trade, one figure per group. A
     * missing value is not an instruction, and guessing a customer's contract
     * from a null is the one reading that could put the wrong document in
     * front of somebody.
     */
    it.skipIf(fixture.contractType !== null)(
      'groups the scope and prices each group at the sum of its lines',
      () => {
        const included = fixture.lines.filter((line) => line.isIncluded);
        const expectedGroups: string[] = [];
        for (const line of included) {
          if (!expectedGroups.includes(line.lineGroup)) expectedGroups.push(line.lineGroup);
        }

        for (const [index, group] of expectedGroups.entries()) {
          const sum = included
            .filter((line) => line.lineGroup === group)
            .reduce((total, line) => total + line.lineTotalCents, 0);
          expectAmount(doc.groups[index]!.amount, sum, `group ${group}`);
        }
      },
    );

    /**
     * The contract types that DO itemise: time and material, cost plus, unit
     * price. The customer is paying for what is used or per unit, so seeing
     * each line and its amount is the arrangement rather than a courtesy.
     */
    it.skipIf(fixture.contractType === null || fixture.contractType === 'lump_sum')(
      'prints an amount against every line it charges for',
      () => {
        const included = fixture.lines.filter((line) => line.isIncluded);
        for (const line of included) {
          expect(
            doc.moneyText,
            `${line.description} carries its own amount`,
          ).toContain(norm(formatCents(line.lineTotalCents)));
        }
      },
    );

    /**
     * THE ONE THAT GUARDS THE OWNER'S ACTUAL INSTRUCTION.
     *
     * "In lump sum i don't want to show which line is how much money i am
     * charging them -- it's a lump sum or fixed price."
     *
     * So the scope table carries no money at all, and the only figures on the
     * page are the totals block and the priced upgrades a customer chooses
     * from. An allowance keeps its figure deliberately: it is a stated budget
     * the final bill trues up against, and this document's own terms say fees
     * are billed at cost "unless listed as an allowance", which would refer to
     * a number the customer had never been shown.
     */
    it.skipIf(fixture.contractType !== 'lump_sum')(
      'shows no price against any line of a lump-sum scope',
      () => {
        for (const row of doc.groups) {
          expect(row.amount, `group ${row.group} carries no amount`).toBe('');
        }

        const totals = new Set(doc.totals.map((row) => row.amount));
        const upgrades = new Set((doc.upgrades ?? []).map((row) => row.amount));
        const allowances = fixture.lines
          .filter((line) => line.isIncluded && line.isAllowance)
          .map((line) => norm(formatCents(line.lineTotalCents)));

        // Every figure anywhere in the scope region must be one the rule
        // permits. Scanning the rendered text rather than the scraped rows,
        // because a price re-introduced in some new corner of the markup would
        // slip past an assertion that only looked where prices used to be.
        const figures = doc.moneyText.match(/\$[\d,]+\.\d{2}/g) ?? [];
        for (const figure of figures) {
          const permitted =
            totals.has(figure) || upgrades.has(figure) || allowances.includes(figure);
          expect(permitted, `${figure} is a total, an upgrade or an allowance`).toBe(true);
        }
      },
    );

    it('agrees with the calculation engine on the subtotal it prints', () => {
      // Two claims, and both matter. First that the stored subtotal is still
      // what the engine makes of the stored line inputs -- a quote whose lines
      // were edited without a recalculation would fail here. Second that the
      // document prints that figure and not some other one.
      expect(fixture.display.subtotalCents).toBe(fixture.storedSubtotalCents);

      const subtotal = doc.totals.find((row) => row.label === 'Subtotal');
      expect(subtotal).toBeDefined();
      expectAmount(subtotal!.amount, fixture.display.subtotalCents, 'subtotal');
    });

    it('prints each tax at its snapshot rate, label and registration number', () => {
      const taxRows = doc.totals.filter((row) => !row.grand && row.label !== 'Subtotal');
      expect(taxRows).toHaveLength(fixture.taxes.length);

      for (const [index, tax] of fixture.taxes.entries()) {
        const printed = taxRows[index]!;
        const percent = (Number(tax.rateTenThou) / 100).toFixed(2);
        expect(printed.label).toContain(norm(tax.label));
        expect(printed.label).toContain(`${percent}%`);
        if (tax.registrationNumber) {
          expect(printed.label).toContain(norm(tax.registrationNumber));
        }
        expectAmount(printed.amount, tax.taxAmountCents, `tax ${tax.label}`);
      }
    });

    it('agrees with the calculation engine on the total it prints', () => {
      const grand = doc.totals.find((row) => row.grand);
      expect(grand).toBeDefined();
      expect(grand!.label).toBe('Total');
      expectAmount(grand!.amount, fixture.storedTotalCents, 'total');

      // The printed total must be the subtotal plus the printed taxes, or the
      // document does not add up in the hand of whoever checks it.
      const taxSum = fixture.taxes.reduce((sum, tax) => sum + tax.taxAmountCents, 0);
      expect(fixture.storedTotalCents).toBe(fixture.storedSubtotalCents + taxSum);
      expect(fixture.storedTaxTotalCents).toBe(taxSum);

      if (fixture.taxSnapshotMatchesConfig) {
        // The rates in force on the quote date still match its snapshot, so
        // the engine can be run over the whole quote and compared outright.
        expect(fixture.withTax.totalCents).toBe(fixture.storedTotalCents);
        expect(fixture.withTax.taxes.map((tax) => tax.taxAmountCents)).toEqual(
          fixture.taxes.map((tax) => tax.taxAmountCents),
        );
        expect(fixture.withTax.taxes.map((tax) => tax.taxableBaseCents)).toEqual(
          fixture.taxes.map((tax) => tax.taxableBaseCents),
        );
      }
    });

    it('presents excluded optional lines as upgrades, or omits the section entirely', () => {
      const excluded = fixture.lines.filter((line) => !line.isIncluded);

      if (excluded.length === 0) {
        expect(doc.upgrades).toBeNull();
        return;
      }

      expect(doc.upgrades).not.toBeNull();
      expect(doc.upgrades).toHaveLength(excluded.length);
      // The section must say it is additional, or a customer reads the upgrade
      // prices as part of the total directly above them.
      expect(doc.upgradesNote).toContain('not included');

      for (const [index, line] of excluded.entries()) {
        const printed = doc.upgrades![index]!;
        expect(printed.text).toContain(norm(line.description));
        if (line.calcMode === 'qty') {
          expect(printed.text).toContain(
            norm(`${formatQty(line.qtyMilli)} ${line.unitLabel} × ${formatRate(line.unitPriceTenThou)}`),
          );
        }
      }
    });

    it('prices an excluded upgrade at what accepting it would actually add', () => {
      const excluded = fixture.lines.filter((line) => !line.isIncluded);
      if (excluded.length === 0) return;

      let grossedUp = 0;
      for (const [index, line] of excluded.entries()) {
        // displayPriceCents comes from the engine, over the same inputs the
        // page's own loader uses -- the raw line total grossed up by the
        // percent lines the upgrade would then attract.
        const computed = fixture.display.lines.find(
          (candidate) =>
            candidate.sortOrder === line.sortOrder && candidate.description === line.description,
        );
        expect(computed).toBeDefined();

        expectAmount(
          doc.upgrades![index]!.amount,
          computed!.displayPriceCents,
          `upgrade ${line.description}`,
        );

        if (computed!.displayPriceCents !== line.lineTotalCents) {
          grossedUp += 1;
          // The precise failure this guards: printing the raw line total, then
          // invoicing the grossed-up one.
          expect(doc.upgrades![index]!.amount).not.toBe(norm(formatCents(line.lineTotalCents)));
        }
      }

      // If the quote carries included percent lines, at least one upgrade must
      // have been grossed up -- otherwise the assertion above never fired and
      // this test proved nothing about the gross-up at all.
      const hasPercent = fixture.lines.some(
        (line) => line.calcMode === 'percent' && line.isIncluded && line.unitPriceTenThou !== 0n,
      );
      if (hasPercent) expect(grossedUp).toBeGreaterThan(0);
    });

    it('sums the printed upgrade prices to the optional total the engine computes', () => {
      const excluded = fixture.lines.filter((line) => !line.isIncluded);
      if (excluded.length === 0) {
        expect(fixture.display.optionalTotalCents).toBe(0);
        return;
      }
      const printedSum = doc
        .upgrades!.map((row) => parseAmountToCents(row.amount))
        .reduce((total, cents) => (total === null || cents === null ? null : total + cents), 0);
      expect(printedSum).toBe(fixture.display.optionalTotalCents);
    });

    it('lets no scaled integer reach the page', () => {
      // Scale is internal. Every stored figure is an integer in cents,
      // thousandths or ten-thousandths, and any one of them printed raw is a
      // wrong number on a contract. The lookarounds are what make this precise
      // rather than loose: $80,037.40 contains no bare run "8003740", so only a
      // genuinely unformatted value can match.
      const registration = org!.taxRegistrationNumber ?? '';
      // The one legitimate bare digit run in the money region.
      const haystack = registration ? doc.moneyText.split(registration).join(' ') : doc.moneyText;

      const forbidden = new Set<string>();
      const add = (value: number | bigint) => {
        const digits =
          typeof value === 'bigint'
            ? (value < 0n ? -value : value).toString()
            : String(Math.abs(value));
        if (digits.length >= 5) forbidden.add(digits);
      };
      add(fixture.storedSubtotalCents);
      add(fixture.storedTaxTotalCents);
      add(fixture.storedTotalCents);
      for (const line of fixture.lines) {
        add(line.lineTotalCents);
        add(line.lineCostCents);
        add(line.qtyMilli);
        add(line.unitCostTenThou);
        add(line.unitPriceTenThou);
      }
      for (const computed of fixture.display.lines) add(computed.displayPriceCents);
      for (const tax of fixture.taxes) {
        add(tax.taxAmountCents);
        add(tax.taxableBaseCents);
      }

      const leaked = [...forbidden].filter((digits) =>
        new RegExp(`(?<![\\d.,])${digits}(?![\\d.,])`).test(haystack),
      );
      expect(leaked).toEqual([]);
    });

    it('shows the customer nothing about cost or margin', () => {
      // The document is priced, not costed. A contractor's own cost reaching
      // the page is not a formatting bug, it is a disclosure.
      const printedAmounts = new Set<string>([
        ...doc.groups.map((row) => row.amount),
        ...doc.totals.map((row) => row.amount),
        ...(doc.upgrades ?? []).map((row) => row.amount),
      ]);
      const cost = norm(formatCents(fixture.storedTotalCostCents));
      // Skipped only in the degenerate case where cost equals a price the
      // document legitimately prints, which no assertion could tell apart.
      if (!printedAmounts.has(cost)) expect(doc.text).not.toContain(cost);

      expect(doc.text.toLowerCase()).not.toContain('margin');
    });

    it('carries the terms and the signature block a signed contract needs', () => {
      for (const clause of [
        org!.paymentTermsText,
        org!.holdbackTermsText,
        org!.quoteTermsText,
        org!.insuranceStatement,
        org!.documentFooterText,
      ]) {
        if (clause) expect(doc.text).toContain(norm(clause));
      }
      expect(doc.signatureLabels).toEqual(['Accepted by', 'Date']);
    });
  });
});
