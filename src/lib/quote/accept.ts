import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { projectStageEnum } from '@/db/enums';
import { customers, projects, quoteLines, quoteTaxes, quotes } from '@/db/schema';
import { companyOf } from '@/lib/company/load';
import { loadTaxRatesFor } from '@/lib/quote/rates';
// Shared with the quote repository rather than copied. Two implementations of
// the writer that snapshots tax rows drift the first time a column is added to
// quote_lines, and the copy nobody edited keeps writing rows without it.
import { customerExemptFor, writeLinesAndTaxes } from '@/lib/quote/repository';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Stage = (typeof projectStageEnum.enumValues)[number];

/**
 * Winning a quote: the customer says yes to some or all of it, and the
 * opportunity becomes a job.
 *
 * There is no `jobs` table and no migration behind this. The `projects` row IS
 * the opportunity before it is won and the job afterwards; a second table would
 * have to be kept in step with the first, and the only fact that actually
 * changes at the moment of signing is which stage the row is in.
 */

/**
 * Accepted from a draft as well as from `sent`.
 *
 * `reviseQuote` refuses a draft, and correctly: a draft edits in place, so
 * revising one produces a second document saying the same thing. Acceptance is
 * the opposite case. Plenty of owners print a quote at the kitchen table, get a
 * signature on it and never come back to press "Mark sent", and refusing that
 * signature until they press a button asserting a send that did not happen
 * teaches them to record a fiction. So a draft is acceptable, and `sent_at`
 * stays null on it -- the timestamp is a record of a send, not a formality to
 * be filled in, and inventing one here would put a fabricated date on a
 * document somebody may later have to stand behind.
 *
 * `declined` is refused rather than allowed. A customer who comes back after
 * saying no is a fresh negotiation: `reviseQuote` already accepts a declined
 * quote and produces the new draft to accept.
 */
const ACCEPTABLE_FROM = ['draft', 'sent'] as const;

/**
 * The stages that accepting a quote advances to `won`.
 *
 * Deliberately a list of origins rather than an unconditional write. A job that
 * is already `in_progress` or `complete` and wins a second estimate on the same
 * opportunity must not be dragged backwards to `won` -- the stage would then
 * disagree with the site, and `stage_history` would record a regression that
 * never happened. `lost` is in the list because an opportunity written off and
 * later signed is exactly a win, and `on_hold` is not, because a hold is a
 * decision about the job that accepting more work does not reverse.
 */
const ADVANCES_TO_WON = [
  'lead',
  'site_visit',
  'quoting',
  'quote_sent',
  'lost',
] as const satisfies readonly Stage[];

/** The sibling states worth declining. Anything else is already resolved. */
const LIVE_SIBLING_STATUSES = ['draft', 'sent'] as const;

export interface AcceptQuoteLinesArgs {
  quoteId: string;
  /** The lines the customer agreed to, by id, from this quote and no other. */
  wonLineIds: string[];
  /**
   * Whether to decline the other estimates on the opportunity.
   *
   * A caller's decision rather than a rule of the domain, and required rather
   * than defaulted so the decision cannot be skipped: three price points for
   * one bathroom means the two that lost are dead, but a kitchen quote and a
   * basement quote on the same house may both be won. Contract value is the sum
   * of the accepted quotes on the project, so guessing this silently inflates
   * or deflates the job.
   */
  declineSiblings: boolean;
  /** Who agreed. The only record of that, so it is required rather than optional. */
  acceptedByName: string;
  /** The signed-in user, for `created_by` on everything written here. */
  createdBy?: string;
}

export interface AcceptQuoteLinesResult {
  projectId: string;
  /** The version that now stands accepted: the source, or the one written here. */
  acceptedQuoteId: string;
  version: number;
  /** True when a subset was won and a new version was written to record it. */
  revised: boolean;
  /** The version this one replaced, or null when nothing was superseded. */
  supersededQuoteId: string | null;
  declined: { id: string; quoteNumber: string }[];
}

/**
 * Accepts a quote's won lines and converts the opportunity to a job.
 *
 * One transaction, reads included. The line set decides whether a new version
 * is written at all, and that decision has to be taken against the same
 * snapshot that the insert and the status flips run against -- a line voided by
 * somebody else between the read and the write would otherwise produce a
 * "complete" acceptance of a document that had changed underneath it.
 *
 * Two shapes come out of it:
 *
 *   Everything won -- accept the version that exists, in place. No version 2.
 *   Nothing about the document changed, and a spurious revision would leave the
 *   customer's signed page and the system's record differing by a version
 *   number for no reason anybody could explain a year later.
 *
 *   A subset won -- write the next version holding only those lines, accept
 *   THAT, and supersede the one that was sent. Recording "accepted, but only
 *   these lines" against the document that was actually sent leaves a signed
 *   page saying something different from the agreed work, and the difference
 *   lives in a status column nobody prints. A revision means there is always a
 *   document equal to the contract, line for line.
 */
export async function acceptQuoteLines(
  args: AcceptQuoteLinesArgs,
): Promise<AcceptQuoteLinesResult> {
  const acceptedByName = args.acceptedByName.trim();
  if (acceptedByName.length === 0) {
    throw new Error('record who accepted it: a contract nobody agreed to is not a contract');
  }

  // De-duplicated before it is counted, so a form that posted the same checkbox
  // twice cannot make a subset look like a whole.
  const wonIds = [...new Set(args.wonLineIds)];
  if (wonIds.length === 0) {
    throw new Error(
      'nothing was selected: accepting no lines is declining the quote, which is a different decision',
    );
  }

  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId));
    if (!source) throw new Error(`quote ${args.quoteId} not found`);
    if (source.recordStatus !== 'active') {
      throw new Error('a void quote cannot be accepted');
    }
    if (source.kind !== 'estimate') {
      // A change order is accepted whole or not at all: it is already the
      // description of one agreed change, it has no optional lines by
      // construction, and its acceptance neither wins the job nor puts any
      // other document out of the running. Sending it down this path would
      // also set the project stage to `won` on a job that was won months ago.
      throw new Error(
        'a change order is accepted as a whole, not line by line: use the accept control on the change order itself',
      );
    }
    if (!ACCEPTABLE_FROM.includes(source.status as (typeof ACCEPTABLE_FROM)[number])) {
      // Worded "this quote is X" rather than "a X quote", following
      // `createChangeOrder`: the statuses interpolate to "a accepted" and "a
      // superseded", and a refusal that reads as broken English undermines the
      // rest of the sentence explaining what to do instead.
      throw new Error(
        `this quote is ${source.status}: an accepted one takes a change order, and a declined or superseded one is revised before it is signed`,
      );
    }

    // Not filtered by record_status, because the unique index on
    // (project, kind, sequence, version) is not either: a voided version 2
    // still occupies its number, and reusing it collides.
    const versions = await tx
      .select({
        id: quotes.id,
        version: quotes.version,
        status: quotes.status,
        recordStatus: quotes.recordStatus,
      })
      .from(quotes)
      .where(
        and(
          eq(quotes.projectId, source.projectId),
          eq(quotes.kind, source.kind),
          eq(quotes.sequence, source.sequence),
        ),
      );

    // `quotes_one_accepted_per_sequence` is partial on
    // (status = 'accepted' and record_status = 'active'), so a second
    // acceptance at this sequence is a constraint violation waiting to happen.
    // Refused here with a sentence, because the alternative a person sees is a
    // raw 23505 on a screen that was about to convert their job.
    const standing = versions.find(
      (row) => row.status === 'accepted' && row.recordStatus === 'active',
    );
    if (standing) {
      throw new Error(
        `version ${standing.version} of this quote already stands accepted; void it or raise a change order`,
      );
    }

    const active = await tx
      .select()
      .from(quoteLines)
      .where(and(eq(quoteLines.quoteId, source.id), eq(quoteLines.recordStatus, 'active')))
      .orderBy(asc(quoteLines.sortOrder));

    const byId = new Map(active.map((line) => [line.id, line]));
    const strangers = wonIds.filter((id) => !byId.has(id));
    if (strangers.length > 0) {
      // Either a bug or a hand-edited form, and both deserve a refusal rather
      // than a quiet filter: accepting fewer lines than the caller believed it
      // accepted is how a job gets under-billed with nobody at fault.
      throw new Error(
        `${strangers.length === 1 ? 'a line does' : 'some lines do'} not belong to this quote: ${strangers.join(', ')}`,
      );
    }

    /**
     * A percent line is arithmetic, not scope.
     *
     * Overhead at 10% prices itself off whatever work is included, so it is not
     * something a customer accepts or turns down, and it needs no tick.
     * Included ones carry forward regardless of the selection and re-resolve
     * against the reduced base; dropping one because nobody ticked it would
     * delete the overhead recovery from a job that still has to be run.
     */
    const carriedPercent = active.filter((line) => line.calcMode === 'percent' && line.isIncluded);
    const claimedPercent = carriedPercent.filter((line) => wonIds.includes(line.id));
    if (claimedPercent.length > 0) {
      throw new Error(
        'a percent line carries forward automatically and cannot be won or dropped on its own',
      );
    }

    const won = new Set(wonIds);
    const automatic = new Set(carriedPercent.map((line) => line.id));
    // Source order is kept rather than renumbered: the sequence of lines is how
    // the customer read the document, and gaps left by dropped lines cost
    // nothing because ordering is by sort_order, not by its arithmetic.
    const carried = active.filter((line) => won.has(line.id) || automatic.has(line.id));

    /**
     * Whether the accepted set IS the document.
     *
     * Compared against the currently INCLUDED lines rather than against every
     * line, because an excluded optional upgrade is not part of what was
     * quoted. Two things therefore force a new version: work that was quoted
     * and not won, and an upgrade that was won. The second is the one worth
     * naming -- an optional line the customer took has to end up inside the
     * subtotal, and the header of a sent quote is immutable, so the only place
     * that figure can legally land is a new version.
     */
    const includedIds = new Set(active.filter((line) => line.isIncluded).map((line) => line.id));
    const unchanged =
      carried.length === includedIds.size && carried.every((line) => includedIds.has(line.id));

    const now = new Date();

    if (unchanged) {
      await tx
        .update(quotes)
        .set({ status: 'accepted', acceptedAt: now, acceptedByName })
        .where(eq(quotes.id, source.id));

      await winTheJob(tx, source.projectId);
      const declined = args.declineSiblings ? await declineOtherEstimates(tx, source, now) : [];

      return {
        projectId: source.projectId,
        acceptedQuoteId: source.id,
        version: source.version,
        revised: false,
        supersededQuoteId: null,
        declined,
      };
    }

    /**
     * The accepted subset, as line inputs.
     *
     * Prices are copied, never recomputed: `unit_price_ten_thou` on each row is
     * a snapshot taken when the line was created, and re-resolving it against
     * the current rate list would rewrite the value of the work at the moment
     * the customer agreed to it.
     *
     * `isOptional` and `isIncluded` are the two flags that DO change, and they
     * both become the same thing. An upgrade the customer took is contracted
     * work: leaving `isOptional` true would print agreed work on the contract
     * as an available extra, and leaving `isIncluded` false would keep it out
     * of the subtotal, out of the percent base and out of the taxable base --
     * an accepted upgrade that silently does not count is an under-billed job.
     * An upgrade not taken is simply absent, because carrying it would offer
     * the customer an extra against a document they have already signed.
     */
    const inputs: LineInput[] = carried.map((line) => ({
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
      isOptional: false,
      isIncluded: true,
      isAllowance: line.isAllowance,
      rateItemId: line.rateItemId,
      costCodeId: line.costCodeId,
    }));

    /**
     * Priced on the SOURCE's date, not today.
     *
     * This is the one place this operation diverges from `reviseQuote`, which
     * re-dates its copy and recomputes tax at the current rate because a
     * revision is a new offer. This version is not an offer at all -- it is the
     * document that was signed, restricted to the lines that were signed for --
     * so its date, its validity and the tax rates it computes under are the
     * source's. Re-dating it would charge a rate change that landed between the
     * quote and the signature, and the customer would be holding a page with a
     * different total on it.
     */
    const customerExempt = await customerExemptFor(tx, source.projectId);
    // The issuer of the quote being accepted, which is the same company by
    // definition -- a job never moves. Its rates, because the acceptance
    // re-computes under the SOURCE quote's date and must not pick up the other
    // registrant's tax.
    const company = await companyOf(tx, source.projectId);
    const totals = computeQuote(inputs, await loadTaxRatesFor(tx, company.id), {
      onDate: source.quoteDate,
      customerExempt,
    });

    const nextVersion = versions.reduce((max, row) => Math.max(max, row.version), 0) + 1;

    // Superseded before the accepted row exists, exactly as in `reviseQuote`:
    // the partial unique index on the accepted slot must never see two live
    // rows, and the new version is flipped to accepted at the end of this
    // block, after this update has already vacated the slot.
    await tx.update(quotes).set({ status: 'superseded' }).where(eq(quotes.id, source.id));

    const [copy] = await tx
      .insert(quotes)
      .values({
        projectId: source.projectId,
        // The number carries forward: both versions are the same document, and
        // the contract is version 2 of the quote the customer was given.
        quoteNumber: source.quoteNumber,
        kind: source.kind,
        parentQuoteId: source.parentQuoteId,
        sequence: source.sequence,
        reason: source.reason,
        scheduleImpactDays: source.scheduleImpactDays,
        version: nextVersion,
        // Born a draft. The line-mutability trigger refuses an INSERT into any
        // quote that is not a draft, so the lines have to land before the
        // status does; the flip to `accepted` is the last write below.
        status: 'draft',
        quoteDate: source.quoteDate,
        validUntil: source.validUntil,
        scopeTemplateId: source.scopeTemplateId,
        areaSqftMilli: source.areaSqftMilli,
        washroomCount: source.washroomCount,
        kitchenCount: source.kitchenCount,
        bedroomCount: source.bedroomCount,
        // Header totals ARE recomputed, through the same engine every other
        // document uses. The subset's total must equal the sum of the subset's
        // own lines, or the contract does not add up on its own page.
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
        // Why this version exists, in words, on the record itself. The audit
        // log holds the diff but nothing in it says "the customer took four of
        // the six lines", which is the question somebody asks in a year.
        internalNotes: provenanceNote(source.internalNotes, source.version, carried.length),
        paymentTermsText: source.paymentTermsText,
        createdBy: args.createdBy,
      })
      .returning();

    await writeLinesAndTaxes(tx, copy!.id, totals, args.createdBy);

    await tx
      .update(quotes)
      .set({ status: 'accepted', acceptedAt: now, acceptedByName })
      .where(eq(quotes.id, copy!.id));

    await winTheJob(tx, source.projectId);
    const declined = args.declineSiblings ? await declineOtherEstimates(tx, source, now) : [];

    return {
      projectId: source.projectId,
      acceptedQuoteId: copy!.id,
      version: nextVersion,
      revised: true,
      supersededQuoteId: source.id,
      declined,
    };
  });
}

/**
 * The opportunity becomes the job.
 *
 * Nothing is written to `stage_history`: `record_stage_change` on `projects`
 * inserts that row itself, on insert and on any update where the stage
 * actually moves (see drizzle/0001). Writing one here as well would double
 * every transition, and time-in-stage is derived from those rows.
 */
async function winTheJob(tx: Tx, projectId: string): Promise<void> {
  const [project] = await tx
    .select({ stage: projects.stage })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new Error(`project ${projectId} not found`);
  if (!ADVANCES_TO_WON.includes(project.stage as (typeof ADVANCES_TO_WON)[number])) return;

  await tx.update(projects).set({ stage: 'won' }).where(eq(projects.id, projectId));
}

/**
 * Declines the estimates that lost.
 *
 * Other SEQUENCES only. Other versions of this sequence are the same document
 * and were already resolved -- the one that was sent is superseded above, and
 * anything older was superseded when it was revised.
 *
 * Change orders are never touched. A change order belongs to a contract rather
 * than competing with this estimate, and declining a pending one because a
 * different estimate was won would cancel agreed extras nobody named.
 *
 * An already-accepted sibling is never touched either, which is the point of
 * filtering on draft and sent rather than on "not this one": contract value is
 * the sum of the accepted quotes, so declining one would quietly reduce the
 * value of a job that is already under way.
 */
async function declineOtherEstimates(
  tx: Tx,
  source: { projectId: string; sequence: number },
  now: Date,
): Promise<{ id: string; quoteNumber: string }[]> {
  return tx
    .update(quotes)
    .set({ status: 'declined', declinedAt: now })
    .where(
      and(
        eq(quotes.projectId, source.projectId),
        eq(quotes.kind, 'estimate'),
        eq(quotes.recordStatus, 'active'),
        ne(quotes.sequence, source.sequence),
        inArray(quotes.status, [...LIVE_SIBLING_STATUSES]),
      ),
    )
    .returning({ id: quotes.id, quoteNumber: quotes.quoteNumber });
}

/** Appended rather than overwritten: the existing note is somebody's writing. */
function provenanceNote(existing: string | null, sourceVersion: number, lines: number): string {
  const note = `Accepted as a subset of version ${sourceVersion}: ${lines} ${lines === 1 ? 'line' : 'lines'} carried.`;
  return existing ? `${existing}\n${note}` : note;
}

