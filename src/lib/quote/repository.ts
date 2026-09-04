import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customers, organization, projects, quoteLines, quoteTaxes, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import { addDays, tenantToday, yearOf } from '@/lib/quote/dates';
import { allocateDocumentNumber } from '@/lib/quote/numbering';
import type { TaxRateInput } from '@/lib/quote/tax';
import { expandTemplate, type ScopeInputs, type TemplateItem } from '@/lib/quote/template';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Revision is allowed only from these. See the note on reviseQuote. */
const REVISABLE = ['sent', 'declined'] as const;

async function loadTaxRates(tx: Tx): Promise<TaxRateInput[]> {
  const rows = await tx
    .select()
    .from(taxRates)
    .where(and(eq(taxRates.isActive, true), eq(taxRates.recordStatus, 'active')))
    .orderBy(asc(taxRates.sortOrder));

  return rows.map((row) => ({
    label: row.label,
    registrationNumber: row.registrationNumber,
    rateTenThou: row.rateTenThou,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    isCompound: row.isCompound,
    sortOrder: row.sortOrder,
  }));
}

async function requireOrganization(tx: Tx) {
  const [org] = await tx.select().from(organization).where(eq(organization.id, 1));
  if (!org) throw new Error('organization row is missing; run setup first');
  return org;
}

async function customerExemptFor(tx: Tx, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ isTaxExempt: customers.isTaxExempt })
    .from(projects)
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(eq(projects.id, projectId));
  if (!row) throw new Error(`project ${projectId} not found`);
  return row.isTaxExempt;
}

async function writeLinesAndTaxes(
  tx: Tx,
  quoteId: string,
  totals: ReturnType<typeof computeQuote>,
  createdBy?: string,
): Promise<void> {
  if (totals.lines.length > 0) {
    await tx.insert(quoteLines).values(
      totals.lines.map((line) => ({
        quoteId,
        sortOrder: line.sortOrder,
        lineGroup: line.lineGroup,
        code: line.code,
        description: line.description,
        calcMode: line.calcMode,
        unitLabel: line.unitLabel,
        rateItemId: line.rateItemId,
        costCodeId: line.costCodeId,
        qtyMilli: line.qtyMilli,
        unitCostTenThou: line.unitCostTenThou,
        unitPriceTenThou: line.unitPriceTenThou,
        lineCostCents: line.lineCostCents,
        lineTotalCents: line.lineTotalCents,
        isTaxable: line.isTaxable,
        isAllowance: line.isAllowance,
        isOptional: line.isOptional,
        isIncluded: line.isIncluded,
        createdBy,
      })),
    );
  }

  if (totals.taxes.length > 0) {
    await tx.insert(quoteTaxes).values(
      totals.taxes.map((tax, index) => ({
        quoteId,
        label: tax.label,
        registrationNumber: tax.registrationNumber,
        rateTenThou: tax.rateTenThou,
        taxableBaseCents: tax.taxableBaseCents,
        taxAmountCents: tax.taxAmountCents,
        sortOrder: index,
        createdBy,
      })),
    );
  }
}

/**
 * Builds a quote from a scope template and the owner's measurements.
 *
 * Everything runs in one transaction, reads included: the document number is
 * allocated inside it, so an abandoned quote does not burn a number, and the
 * rates the lines snapshot are the rates that existed at the instant the quote
 * was priced.
 */
export async function createQuoteFromTemplate(args: {
  projectId: string;
  scopeTemplateId: string;
  scope: ScopeInputs;
  quoteDate?: string;
  createdBy?: string;
}): Promise<{ quoteId: string; quoteNumber: string }> {
  return db.transaction(async (tx) => {
    const org = await requireOrganization(tx);
    const customerExempt = await customerExemptFor(tx, args.projectId);

    const [template] = await tx
      .select()
      .from(scopeTemplates)
      .where(eq(scopeTemplates.id, args.scopeTemplateId));
    if (!template) throw new Error(`scope template ${args.scopeTemplateId} not found`);

    const templateRows = await tx
      .select({ template: scopeTemplateItems, item: rateItems })
      .from(scopeTemplateItems)
      .innerJoin(rateItems, eq(scopeTemplateItems.rateItemId, rateItems.id))
      .where(
        and(
          eq(scopeTemplateItems.scopeTemplateId, args.scopeTemplateId),
          eq(scopeTemplateItems.recordStatus, 'active'),
          eq(rateItems.recordStatus, 'active'),
        ),
      )
      .orderBy(asc(scopeTemplateItems.sortOrder));

    const templateItems: TemplateItem[] = templateRows.map(({ template: line, item }) => ({
      code: item.code,
      description: item.description,
      lineGroup: line.lineGroup,
      sortOrder: line.sortOrder,
      calcMode: item.calcMode,
      unitLabel: item.unitLabel,
      qtySource: line.qtySource,
      qtyMultiplierTenThou: line.qtyMultiplierTenThou,
      fixedQtyMilli: line.fixedQtyMilli,
      // The snapshot happens here: the rate is read once and never referenced
      // again, so raising it later cannot rewrite a quote already sent.
      costRateTenThou: item.costRateTenThou,
      sellRateTenThou: item.sellRateTenThou,
      isTaxable: item.isTaxable,
      isOptional: line.isOptional,
      // The template's flag wins, so one item can be a fixed price in one
      // template and an allowance in another.
      isAllowance: line.isAllowance || item.isAllowance,
      rateItemId: item.id,
      costCodeId: item.costCodeId,
    }));

    const quoteDate = args.quoteDate ?? (await tenantToday(tx));
    const lines = expandTemplate(templateItems, args.scope);
    const totals = computeQuote(lines, await loadTaxRates(tx), { onDate: quoteDate, customerExempt });

    const quoteNumber = await allocateDocumentNumber(tx, 'quote', yearOf(quoteDate));

    // A project can carry more than one estimate -- the basement and the deck
    // are separate decisions the customer makes separately -- so each gets its
    // own sequence, and versions count within a sequence. Reusing version 1
    // collides on (project, kind, sequence, version).
    const siblings = await tx
      .select({ sequence: quotes.sequence })
      .from(quotes)
      .where(and(eq(quotes.projectId, args.projectId), eq(quotes.kind, 'estimate')));
    const sequence = siblings.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;

    const [quote] = await tx
      .insert(quotes)
      .values({
        projectId: args.projectId,
        quoteNumber,
        kind: 'estimate',
        sequence,
        version: 1,
        quoteDate,
        validUntil: addDays(quoteDate, org.quoteValidityDays),
        scopeTemplateId: args.scopeTemplateId,
        areaSqftMilli: args.scope.areaSqftMilli,
        washroomCount: args.scope.washroomCount,
        kitchenCount: args.scope.kitchenCount,
        bedroomCount: args.scope.bedroomCount,
        subtotalCents: totals.subtotalCents,
        taxTotalCents: totals.taxTotalCents,
        totalCents: totals.totalCents,
        totalCostCents: totals.totalCostCents,
        marginBp: totals.marginBp,
        holdbackPctTenThou: org.defaultHoldbackPctTenThou,
        terms: org.quoteTermsText,
        paymentTermsText: org.paymentTermsText,
        createdBy: args.createdBy,
      })
      .returning();

    await writeLinesAndTaxes(tx, quote!.id, totals, args.createdBy);
    return { quoteId: quote!.id, quoteNumber };
  });
}

/**
 * Creates the next version of a quote.
 *
 * Allowed only from `sent` or `declined`. A draft edits in place, and an
 * accepted quote is never revised, because the customer signed it -- that
 * change belongs on a change order.
 *
 * Lines are copied rather than shared: the customer negotiated against version
 * 1, and version 1 must continue to say what it said. Only active lines carry
 * forward, and tax is recomputed for the new date, because a revision issued
 * after a rate change must charge the new rate.
 */
export async function reviseQuote(args: {
  quoteId: string;
  createdBy?: string;
}): Promise<{ quoteId: string; version: number }> {
  return db.transaction(async (tx) => {
    const org = await requireOrganization(tx);

    const [source] = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId));
    if (!source) throw new Error(`quote ${args.quoteId} not found`);
    if (source.recordStatus !== 'active') {
      throw new Error('a void quote cannot be revised');
    }
    if (!REVISABLE.includes(source.status as (typeof REVISABLE)[number])) {
      throw new Error(
        `a ${source.status} quote cannot be revised: a draft edits in place, and an accepted quote takes a change order`,
      );
    }

    const siblings = await tx
      .select({ version: quotes.version })
      .from(quotes)
      .where(
        and(
          eq(quotes.projectId, source.projectId),
          eq(quotes.kind, source.kind),
          eq(quotes.sequence, source.sequence),
        ),
      );
    const nextVersion = Math.max(...siblings.map((s) => s.version)) + 1;

    const sourceLines = await tx
      .select()
      .from(quoteLines)
      .where(and(eq(quoteLines.quoteId, source.id), eq(quoteLines.recordStatus, 'active')))
      .orderBy(asc(quoteLines.sortOrder));

    const carried: LineInput[] = sourceLines.map((line) => ({
      code: line.code,
      description: line.description,
      lineGroup: line.lineGroup,
      sortOrder: line.sortOrder,
      calcMode: line.calcMode,
      unitLabel: line.unitLabel,
      qtyMilli: line.qtyMilli,
      unitCostTenThou: line.unitCostTenThou,
      unitPriceTenThou: line.unitPriceTenThou,
      isTaxable: line.isTaxable,
      isOptional: line.isOptional,
      isIncluded: line.isIncluded,
      isAllowance: line.isAllowance,
      rateItemId: line.rateItemId,
      costCodeId: line.costCodeId,
    }));

    const quoteDate = await tenantToday(tx);
    const customerExempt = await customerExemptFor(tx, source.projectId);
    const totals = computeQuote(carried, await loadTaxRates(tx), { onDate: quoteDate, customerExempt });

    // Superseded before the copy is inserted, so the partial unique index on
    // the accepted slot never sees two live rows at once.
    await tx.update(quotes).set({ status: 'superseded' }).where(eq(quotes.id, source.id));

    const [copy] = await tx
      .insert(quotes)
      .values({
        projectId: source.projectId,
        // The number is carried forward: both versions are the same document.
        quoteNumber: source.quoteNumber,
        kind: source.kind,
        parentQuoteId: source.parentQuoteId,
        sequence: source.sequence,
        reason: source.reason,
        scheduleImpactDays: source.scheduleImpactDays,
        version: nextVersion,
        status: 'draft',
        quoteDate,
        validUntil: addDays(quoteDate, org.quoteValidityDays),
        scopeTemplateId: source.scopeTemplateId,
        areaSqftMilli: source.areaSqftMilli,
        washroomCount: source.washroomCount,
        kitchenCount: source.kitchenCount,
        bedroomCount: source.bedroomCount,
        subtotalCents: totals.subtotalCents,
        taxTotalCents: totals.taxTotalCents,
        totalCents: totals.totalCents,
        totalCostCents: totals.totalCostCents,
        marginBp: totals.marginBp,
        holdbackPctTenThou: source.holdbackPctTenThou,
        pricingDisplay: source.pricingDisplay,
        exclusionsText: source.exclusionsText,
        assumptionsText: source.assumptionsText,
        terms: source.terms,
        notes: source.notes,
        internalNotes: source.internalNotes,
        paymentTermsText: source.paymentTermsText,
        createdBy: args.createdBy,
      })
      .returning();

    await writeLinesAndTaxes(tx, copy!.id, totals, args.createdBy);
    return { quoteId: copy!.id, version: nextVersion };
  });
}

/**
 * Voids a quote. Nothing is ever deleted, and a reason is mandatory.
 *
 * Voiding does not cascade. A quote with active change orders against it is
 * refused: cascading would silently void records the user never named, and
 * leaving the change orders pointing at a voided parent is worse still.
 */
export async function voidQuote(args: {
  quoteId: string;
  reason: string;
  voidedBy?: string;
}): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length === 0) throw new Error('a void reason is required');

  await db.transaction(async (tx) => {
    const [quote] = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId));
    if (!quote) throw new Error(`quote ${args.quoteId} not found`);

    const children = await tx
      .select({ id: quotes.id, number: quotes.quoteNumber })
      .from(quotes)
      .where(and(eq(quotes.parentQuoteId, args.quoteId), eq(quotes.recordStatus, 'active')));
    if (children.length > 0) {
      throw new Error(
        `void the change orders first: ${children.map((c) => c.number).join(', ')}`,
      );
    }

    await tx
      .update(quotes)
      .set({
        recordStatus: 'void',
        voidedAt: new Date(),
        voidedBy: args.voidedBy,
        voidReason: reason,
      })
      .where(eq(quotes.id, args.quoteId));
  });
}

/**
 * Contract value, derived rather than stored.
 *
 * An earlier draft had both a projects.contract_value_cents column and a
 * statement that the value was derived. Two sources of truth from day one is a
 * reconciliation bug waiting for a witness.
 */
export async function contractValueCents(projectId: string): Promise<number> {
  const rows = await db
    .select({ total: quotes.totalCents })
    .from(quotes)
    .where(
      and(
        eq(quotes.projectId, projectId),
        eq(quotes.status, 'accepted'),
        eq(quotes.recordStatus, 'active'),
      ),
    );
  return rows.reduce((sum, row) => sum + row.total, 0);
}
