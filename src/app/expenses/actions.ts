'use server';

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  costCodes, expenseTaxes, expenses, files, organization, paymentMethods, projects, taxRates,
  vendors,
} from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  EXPENSE_LABELS,
  RECEIPT_MAX_BYTES,
  RECEIPT_TYPES,
  type TaxLineInput,
  constraintMessage,
  formatRatePerKm,
  mileageCostCents,
  mileageFields,
  purchaseFields,
  readBatchRows,
  readTaxLines,
  signMismatch,
  violatedConstraint,
} from '@/app/expenses/schema';
import { formatBytes } from '@/app/settings/identity/logo/logo';
import { type SaveResult, saveFile } from '@/lib/files/store';
import { formatCents } from '@/lib/money/format';
import { tenantToday } from '@/lib/quote/dates';

/**
 * The write side of job expenses, mileage and receipts.
 *
 * **The capability is `expense:write`, which exists for exactly this.** These
 * actions were originally gated on `quote:write`, because an expense is a
 * priced record and that is the capability the matrix used to mean by one. It
 * was the wrong answer for one of the three roles: a `bookkeeper` is the person
 * most likely to be typing forty receipts, and under `quote:write` they could
 * not type one. `expense:write` is now its own row of the matrix, held by all
 * three roles, and `quote:write` is left meaning what it means -- a quote, a
 * project, a customer, the records a customer sees.
 *
 * Not `worksheet:read` because a bookkeeper happens to hold it: that would put
 * a read capability on a write path, which is worse than the gap it closed.
 * Not `rates:edit`, which the vendor list uses -- a vendor is a reference row
 * carrying no money, and an expense is money. Not `organization:edit`, which is
 * the per-kilometre rate in settings: one figure that changes what every FUTURE
 * trip costs is a different blast radius from one trip already driven.
 *
 * **Voiding an expense is `expense:write` too, and not `record:void`.** That is
 * the one place this file departs from the rest of the product, so it is worth
 * saying why. `record:void` is section 10.2's "void a quote, project, or
 * customer" and it still is: nothing here widens what a role may retract on
 * those records. An expense is different in kind. It is a line in this
 * company's own ledger, entered from paper somebody is holding, and voiding it
 * is the only correction this product offers -- the row stays, with a reason
 * and an actor on it, and the tax lines go with it. Splitting entry from
 * correction would mean a bookkeeper who typed a receipt twice must leave the
 * double-count standing or interrupt an owner, and an owner interrupted forty
 * times issues an `admin` account instead, which hands over `quote:write`,
 * `quote:transition` and the real `record:void` in one move.
 *
 * Every refusal lives here rather than only in the screen. A disabled button
 * is a hint; a stale tab and a hand-made POST are not obliged to read it.
 */

const REFUSAL = 'Your role can read the expense list but not write to it.';

/** A rule carried out of a transaction as a sentence a person can act on. */
class RuleError extends Error {}

function guardFailure(error: string): ActionResult {
  return refused(error === 'Your role does not permit that.' ? REFUSAL : error);
}

function failureText(error: unknown): string {
  if (error instanceof RuleError) return error.message;
  const constraint = violatedConstraint(error);
  const explained = constraint ? constraintMessage(constraint) : null;
  if (explained) return explained;
  // Deliberately NOT `error.message`. Every write here runs inside a
  // transaction, and Drizzle wraps a driver error in a DrizzleQueryError whose
  // message is the failed SQL and its bound parameters. Putting that on the
  // screen tells the owner nothing he can act on and shows him the schema; the
  // server log still has the whole thing.
  return 'That expense could not be saved. Nothing was written.';
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* -------------------------------------------------------------------------
   The things a row points at, each checked inside the writing transaction
   ------------------------------------------------------------------------- */

/**
 * The job. Read inside the transaction rather than trusted from the form,
 * because the form was rendered before the project that has since been voided
 * was voided.
 */
async function requireProject(tx: Tx, id: string): Promise<{ name: string }> {
  const [row] = await tx
    .select({ name: projects.name, recordStatus: projects.recordStatus })
    .from(projects)
    .where(eq(projects.id, id));

  if (!row) throw new RuleError('That job is not on the list.');
  if (row.recordStatus === 'void') {
    throw new RuleError(
      'That job is void, so nothing new should be costed against it. A void job is kept as a record and is not added to.',
    );
  }
  return { name: row.name };
}

/**
 * The vendor. A RETIRED vendor is accepted and a VOID one is not, and the
 * asymmetry is the point: a supplier who closed last month still sold you the
 * lumber on the receipt in your hand, so refusing their name would mean the
 * only way to record the purchase is to invent a second row for the same
 * counterparty -- which is the failure the vendor table exists to prevent. A
 * void vendor is a row that should never have existed, and spend attributed to
 * one is spend attributed to nobody.
 */
async function requireVendor(tx: Tx, id: string | null): Promise<{ name: string } | null> {
  if (id === null) return null;
  const [row] = await tx
    .select({ name: vendors.name, isActive: vendors.isActive, recordStatus: vendors.recordStatus })
    .from(vendors)
    .where(eq(vendors.id, id));

  if (!row) throw new RuleError('That vendor is not on the list.');
  if (row.recordStatus === 'void') {
    throw new RuleError(
      `${row.name} is a voided row, so spend cannot be attributed to it. Add the counterparty you actually paid.`,
    );
  }
  return { name: row.name };
}

/**
 * The cost code. Retired is accepted for the reason it is accepted as a
 * vendor's default: a division winding down still receives the spend that was
 * committed before it wound down. Void is refused, because coding a receipt to
 * a code that should never have existed spreads a mistake rather than
 * recording one.
 */
async function requireCostCode(tx: Tx, id: string | null): Promise<{ code: string } | null> {
  if (id === null) return null;
  const [row] = await tx
    .select({ code: costCodes.code, recordStatus: costCodes.recordStatus })
    .from(costCodes)
    .where(eq(costCodes.id, id));

  if (!row) throw new RuleError('That cost code is not on the list.');
  if (row.recordStatus === 'void') {
    throw new RuleError(
      `${row.code} is void, so spend should not be coded to it. Choose a code that still stands, or leave it blank and code this one later.`,
    );
  }
  return { code: row.code };
}

/**
 * The payment method. Retired is accepted for the same reason a retired
 * vendor or cost code is: a method the owner stopped offering still describes
 * how a receipt in hand was actually paid. Void is refused, because a method
 * that should never have existed cannot truthfully describe how anything was
 * paid.
 */
async function requirePaymentMethod(tx: Tx, id: string | null): Promise<{ name: string } | null> {
  if (id === null) return null;
  const [row] = await tx
    .select({ name: paymentMethods.name, recordStatus: paymentMethods.recordStatus })
    .from(paymentMethods)
    .where(eq(paymentMethods.id, id));

  if (!row) throw new RuleError('That payment method is not on the list.');
  if (row.recordStatus === 'void') {
    throw new RuleError(
      `${row.name} is void, so an expense should not be recorded against it. Choose a method that still stands, or leave it blank.`,
    );
  }
  return { name: row.name };
}

/**
 * A date that has not happened yet is a typo, and it is the typo that hides
 * best: the row looks ordinary, sorts to the top of the list, and lands in a
 * filing period that has not opened.
 *
 * Compared against the TENANT's today, from `tenantToday`, never `new Date()`.
 * A UTC container after 7pm Toronto thinks it is tomorrow, which would refuse
 * a receipt somebody is holding in their hand.
 */
async function refuseFutureDate(tx: Tx, expenseDate: string): Promise<void> {
  const today = await tenantToday(tx);
  if (expenseDate > today) {
    throw new RuleError(
      `That date is in the future. Today is ${today}, and a receipt cannot be dated after the day it was issued.`,
    );
  }
}

/* -------------------------------------------------------------------------
   Tax
   ------------------------------------------------------------------------- */

interface ResolvedTax {
  label: string;
  registrationNumber: string | null;
  rateTenThou: bigint;
  taxAmountCents: number;
  isRecoverable: boolean;
}

/**
 * Turns the boxes somebody filled into the rows an input tax credit is claimed
 * from, resolving each against the rate that was IN FORCE ON THE EXPENSE DATE.
 *
 * The form offers the rates in force today, because that is what a form
 * rendered today can know. The receipt in the owner's hand may be from last
 * spring, and `tax_rates` is effective-dated precisely so "what was the rate
 * on this date" stays answerable -- so the id the form posted is used to find
 * out WHICH TAX was meant, by label, and the rate is then taken from that
 * tax's row as it stood on the expense date. Snapshotting the current rate
 * instead would record last spring's HST at this spring's percentage, which is
 * a filed return that cannot be reconciled.
 *
 * When no row of that label was in force on the date -- a rate configured
 * after the receipt was issued, which is the ordinary case in a deployment's
 * first weeks -- the chosen row is used and nothing is refused. The AMOUNT is
 * what the paper says either way; the label and the rate are the identity of
 * the tax, not a recomputation of it.
 */
async function resolveTaxLines(
  tx: Tx,
  lines: TaxLineInput[],
  expenseDate: string,
): Promise<ResolvedTax[]> {
  const resolved: ResolvedTax[] = [];

  for (const line of lines) {
    const [chosen] = await tx
      .select({
        label: taxRates.label,
        registrationNumber: taxRates.registrationNumber,
        rateTenThou: taxRates.rateTenThou,
        recordStatus: taxRates.recordStatus,
      })
      .from(taxRates)
      .where(eq(taxRates.id, line.taxRateId));

    if (!chosen || chosen.recordStatus === 'void') {
      throw new RuleError('One of those taxes is not on the list any more. Nothing was written.');
    }

    const [inForce] = await tx
      .select({
        label: taxRates.label,
        registrationNumber: taxRates.registrationNumber,
        rateTenThou: taxRates.rateTenThou,
      })
      .from(taxRates)
      .where(
        and(
          eq(taxRates.label, chosen.label),
          eq(taxRates.recordStatus, 'active'),
          lte(taxRates.effectiveFrom, expenseDate),
          or(isNull(taxRates.effectiveTo), sql`${taxRates.effectiveTo} >= ${expenseDate}`),
        ),
      )
      .orderBy(sql`${taxRates.effectiveFrom} desc`)
      .limit(1);

    const source = inForce ?? chosen;
    resolved.push({
      label: source.label,
      registrationNumber: source.registrationNumber,
      rateTenThou: source.rateTenThou,
      taxAmountCents: line.amountCents,
      isRecoverable: line.isRecoverable,
    });
  }

  return resolved;
}

/** The ids the tax boxes were rendered from, so a hand-made POST cannot name a fourth. */
async function inForceTaxRateIds(): Promise<string[]> {
  const rows = await db
    .select({ id: taxRates.id })
    .from(taxRates)
    .where(and(eq(taxRates.recordStatus, 'active'), eq(taxRates.isActive, true)))
    .orderBy(taxRates.sortOrder);
  return rows.map((row) => row.id);
}

/* -------------------------------------------------------------------------
   The receipt
   ------------------------------------------------------------------------- */

const RECEIPT_FIELD = { field: 'receipt', label: 'Receipt' };

/**
 * Why a file was refused, naming what arrived rather than only what was
 * wanted.
 *
 * Nothing here trusts the extension or the content-type header the browser
 * sent: `src/lib/files/**` decides what the bytes ARE from their leading
 * signature and stores the file under a name derived from that. So a
 * `receipt.png` that is really an SVG is refused here, with the reason said
 * out loud, rather than served back later from this application's own origin
 * with a type its uploader chose. A `receipt.pdf` that is really a PNG is
 * stored as the PNG it is, for the same reason read the other way round.
 */
function receiptRefusal(result: Extract<SaveResult, { ok: false }>): ActionResult {
  if (result.reason === 'empty') {
    return refused('That receipt file is empty.', [
      { ...RECEIPT_FIELD, message: 'contained no bytes at all. Photograph it again.' },
    ]);
  }
  if (result.reason === 'too-large') {
    return refused(`That receipt is over the ${formatBytes(result.maxBytes)} limit.`, [
      {
        ...RECEIPT_FIELD,
        message:
          'is too large. A phone photograph of a till receipt is well under this; if yours is not,' +
          ' the camera is set to its largest size and the picture is no more readable for it.',
      },
    ]);
  }
  if (result.looksLike === 'an SVG') {
    return refused('An SVG cannot be a receipt.', [
      {
        ...RECEIPT_FIELD,
        message:
          'is an SVG. That is refused deliberately: an SVG can carry script, and one served from' +
          ' this application’s own origin would run with the application’s rights.',
      },
    ]);
  }
  const looks = result.looksLike ? ` It looks like ${result.looksLike}.` : '';
  return refused('That receipt is not a file this can store.', [
    {
      ...RECEIPT_FIELD,
      message:
        `is not a PNG, a JPEG or a PDF.${looks} The contents are checked rather than the name,` +
        ' so renaming a file .jpg does not change what is inside it, and a PDF named .png is' +
        ' still handled as the PDF it is.',
    },
  ]);
}

/* -------------------------------------------------------------------------
   One receipt at a time
   ------------------------------------------------------------------------- */

export async function createExpense(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('expense:write');
  if (!allowed.ok) return guardFailure(allowed.error);

  const values = formValues(formData);
  const parsed = purchaseFields.safeParse(values);
  if (!parsed.success) return invalid(parsed.error, EXPENSE_LABELS);
  const input = parsed.data;

  const rateIds = await inForceTaxRateIds();
  const { lines, malformed } = readTaxLines(values, rateIds);
  if (malformed.length > 0) {
    return refused('One of the tax amounts could not be read.', [
      {
        field: `tax_${malformed[0]}`,
        label: 'Tax',
        message: 'must be an amount, with at most two decimal places.',
      },
    ]);
  }

  const taxTotalCents = lines.reduce((total, line) => total + line.amountCents, 0);
  const mismatch = signMismatch(input.subtotal, taxTotalCents);
  if (mismatch) return refused(mismatch);

  // The file crosses the wire BEFORE the transaction opens, deliberately. A
  // transaction held open for the length of an upload is a lock held for the
  // length of somebody's phone signal, and the bytes have to be weighed and
  // sniffed before anything decides they are a receipt at all. The cost is
  // that a refused insert leaves an unreferenced file row and its bytes on
  // disk -- the same trade `lib/files/store.ts` documents, and the same
  // direction: an orphan nothing points at, rather than a row pointing at
  // bytes that were never written.
  const source = formData.get('receipt');
  let receiptFileId: string | null = null;
  let receiptName: string | null = null;
  if (source instanceof File && source.size > 0 && source.name !== '') {
    const stored = await saveFile({
      entityType: 'receipt',
      entityId: null,
      source,
      uploadedBy: allowed.actor.id,
      maxBytes: RECEIPT_MAX_BYTES,
      accept: RECEIPT_TYPES,
    });
    if (!stored.ok) return receiptRefusal(stored);
    receiptFileId = stored.file.id;
    receiptName = stored.file.fileName;
  }

  let outcome: { id: string; project: string; vendor: string | null; totalCents: number };
  try {
    outcome = await db.transaction(async (tx) => {
      const project = await requireProject(tx, input.projectId);
      const vendor = await requireVendor(tx, input.vendorId);
      await requireCostCode(tx, input.costCodeId);
      await requirePaymentMethod(tx, input.paymentMethodId);
      await refuseFutureDate(tx, input.expenseDate);

      const resolved = await resolveTaxLines(tx, lines, input.expenseDate);
      const totalCents = input.subtotal + taxTotalCents;

      const [row] = await tx
        .insert(expenses)
        .values({
          kind: 'purchase',
          projectId: input.projectId,
          vendorId: input.vendorId,
          costCodeId: input.costCodeId,
          expenseDate: input.expenseDate,
          description: input.description,
          reference: input.reference,
          subtotalCents: input.subtotal,
          taxTotalCents,
          totalCents,
          paymentMethodId: input.paymentMethodId,
          receiptFileId,
          vendorTaxNumberCaptured: input.vendorTaxNumberCaptured,
          source: 'manual',
          // A person typed this, which IS the confirmation step spec 3.3
          // reserves for a human. 'captured' is for a row a machine proposed.
          status: 'posted',
          isBillable: input.isBillable,
          notes: input.notes,
          createdBy: allowed.actor.id,
        })
        .returning({ id: expenses.id });

      const expenseId = row!.id;

      if (resolved.length > 0) {
        await tx.insert(expenseTaxes).values(
          resolved.map((tax, index) => ({
            expenseId,
            label: tax.label,
            registrationNumber: tax.registrationNumber,
            rateTenThou: tax.rateTenThou,
            taxAmountCents: tax.taxAmountCents,
            isRecoverable: tax.isRecoverable,
            sortOrder: index,
            createdBy: allowed.actor.id,
          })),
        );
      }

      if (receiptFileId !== null) {
        // The file row is pointed back at the expense now that there is an
        // expense to point at. `entity_id` is what routes the file to its
        // SharePoint library and what a "receipts for this job" query reads;
        // leaving it null would make the bytes findable only through the
        // expense, which is one join away from not being findable at all.
        await tx.update(files).set({ entityId: expenseId }).where(eq(files.id, receiptFileId));
      }

      return {
        id: expenseId,
        project: project.name,
        vendor: vendor?.name ?? null,
        totalCents,
      };
    });
  } catch (error) {
    return refused(failureText(error));
  }

  revalidatePath('/expenses');
  const paidTo = outcome.vendor ? ` to ${outcome.vendor}` : '';
  const attached = receiptName ? ' Receipt attached.' : '';
  // No receipt attached: an input tax credit over $30 has to be evidenced by
  // one, so it is worth photographing before the paper fades.
  const unattached = receiptName ? '' : ' No receipt attached.';
  return saved(
    `${formatCents(outcome.totalCents)}${paidTo} recorded against ${outcome.project}.${attached}${unattached}`,
  );
}

/* -------------------------------------------------------------------------
   Mileage
   ------------------------------------------------------------------------- */

/**
 * Records a trip.
 *
 * The rate is read from `organization` ONCE, inside this transaction, and
 * written onto the row. Nothing anywhere reads it back to re-cost this trip.
 *
 * That is the single most important line in this file. The per-kilometre
 * allowance changes most years; a screen that resolved it live would look
 * correct every day until the first January after a change, at which point
 * every trip ever driven would silently restate itself -- including the ones
 * in periods already filed, and with nothing on the screen to say it happened.
 * The stored rate is also what makes the figure defensible if it is ever
 * questioned, because the question is "what was the rate on the day", and a
 * row that snapshotted it can answer.
 *
 * Exactly the rule a quote line follows in snapshotting its unit price.
 *
 * A mileage row has no vendor, no receipt, no tax and no payment method. The
 * form does not ask for any of them, and the `expenses_kind_shape` CHECK
 * refuses the row if some future caller supplies one anyway.
 */
export async function createMileage(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('expense:write');
  if (!allowed.ok) return guardFailure(allowed.error);

  const parsed = mileageFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, EXPENSE_LABELS);
  const input = parsed.data;

  let outcome: { project: string; rate: bigint; costCents: number };
  try {
    outcome = await db.transaction(async (tx) => {
      const project = await requireProject(tx, input.projectId);
      await requireCostCode(tx, input.costCodeId);
      await refuseFutureDate(tx, input.expenseDate);

      const [org] = await tx
        .select({ rate: organization.mileageRatePerKmTenThou })
        .from(organization)
        .where(eq(organization.id, 1));

      if (!org) {
        throw new RuleError(
          'There is no organization record yet, so there is no per-kilometre rate to cost this trip at. Run first-run setup first.',
        );
      }

      // Read here, written to the row below, and never consulted again for
      // this trip. Integer ten-thousandths in, integer cents out, BigInt
      // throughout: no JavaScript number touches the arithmetic.
      const ratePerKmTenThou = org.rate;
      const costCents = mileageCostCents(input.distance, ratePerKmTenThou);

      await tx.insert(expenses).values({
        kind: 'mileage',
        projectId: input.projectId,
        costCodeId: input.costCodeId,
        expenseDate: input.expenseDate,
        description: input.description,
        subtotalCents: costCents,
        taxTotalCents: 0,
        totalCents: costCents,
        distanceMilli: input.distance,
        ratePerKmTenThou,
        source: 'manual',
        status: 'posted',
        // Cost only. Never on a customer document, and the CHECK agrees.
        isBillable: false,
        notes: input.notes,
        createdBy: allowed.actor.id,
      });

      return { project: project.name, rate: ratePerKmTenThou, costCents };
    });
  } catch (error) {
    return refused(failureText(error));
  }

  revalidatePath('/expenses');
  return saved(
    `${formatCents(outcome.costCents)} of mileage recorded against ${outcome.project}, at ${formatRatePerKm(outcome.rate)}/km.`,
  );
}

/* -------------------------------------------------------------------------
   Bulk entry
   ------------------------------------------------------------------------- */

/**
 * Several receipts, one job, one page load.
 *
 * This exists because of the risk the plan names and §3.3 repeats: expenses
 * are entered in bulk or not at all. An owner catching up on forty receipts at
 * a kitchen table will not survive six fields and a round trip each; the
 * shoebox wins, and the whole feature was for nothing. So the grid takes eight
 * rows at a time, tabs straight across, and posts once.
 *
 * What it deliberately does NOT take is a receipt photograph per row. A file
 * input in every row is eight file pickers on a phone and eight uploads on one
 * submit, which is the slowest possible version of the fastest possible
 * screen. Bulk is for the figures; a row that needs its paper attached is
 * entered singly, and the screen says so rather than leaving it to be
 * discovered.
 *
 * One job for the batch, and one tax rate for the batch, for the same reason:
 * a shoebox is sorted by job before it is typed, and a receipt carrying two
 * taxes is rare enough that sending it to the single form costs less than
 * sixteen more boxes on this one.
 *
 * All-or-nothing, and a refused batch keeps every cell exactly as typed. That
 * second half is not free: React resets an uncontrolled form once its action
 * completes, refusal included, so `BulkGrid.tsx` holds the cells in state to
 * defeat it. Without that, one missing description throws away eight rows of
 * typing, which is the moment somebody goes back to the shoebox for good.
 */
const batchHeader = z.object({
  projectId: z.uuid('is required — pick the job these receipts belong to'),
});

export async function createExpenseBatch(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('expense:write');
  if (!allowed.ok) return guardFailure(allowed.error);

  const values = formValues(formData);
  const header = batchHeader.safeParse(values);
  if (!header.success) return invalid(header.error, EXPENSE_LABELS);

  const read = readBatchRows(values);
  if (read.errors.length > 0) {
    return refused('Some of those rows need another look. Nothing was written.', read.errors);
  }
  if (read.rows.length === 0) {
    return refused('Nothing was filled in, so nothing was written.');
  }

  const taxRateId = (values.batchTaxRateId ?? '').trim();

  let count = 0;
  let totalCents = 0;
  let projectName = '';
  try {
    await db.transaction(async (tx) => {
      const project = await requireProject(tx, header.data.projectId);
      projectName = project.name;

      for (const row of read.rows) {
        await requireVendor(tx, row.vendorId);
        await requireCostCode(tx, row.costCodeId);
        await requirePaymentMethod(tx, row.paymentMethodId);
        await refuseFutureDate(tx, row.expenseDate);

        const mismatch = signMismatch(row.subtotalCents, row.taxCents);
        if (mismatch) throw new RuleError(`Row ${row.index + 1}: ${mismatch}`);

        const resolved =
          row.taxCents !== 0 && taxRateId !== ''
            ? await resolveTaxLines(
                tx,
                [{ taxRateId, amountCents: row.taxCents, isRecoverable: true }],
                row.expenseDate,
              )
            : [];

        // A tax figure with no rate configured to hang it on would be an
        // unclaimable credit recorded as if it were claimable. Refused rather
        // than dropped: dropping it silently changes the total.
        if (row.taxCents !== 0 && resolved.length === 0) {
          throw new RuleError(
            `Row ${row.index + 1} has tax on it, but no tax rate is configured to record it against. Add one under Settings, or enter that receipt singly.`,
          );
        }

        const rowTotal = row.subtotalCents + row.taxCents;
        const [inserted] = await tx
          .insert(expenses)
          .values({
            kind: 'purchase',
            projectId: header.data.projectId,
            vendorId: row.vendorId,
            costCodeId: row.costCodeId,
            expenseDate: row.expenseDate,
            description: row.description,
            reference: row.reference,
            subtotalCents: row.subtotalCents,
            taxTotalCents: row.taxCents,
            totalCents: rowTotal,
            paymentMethodId: row.paymentMethodId,
            source: 'manual',
            status: 'posted',
            createdBy: allowed.actor.id,
          })
          .returning({ id: expenses.id });

        if (resolved.length > 0) {
          await tx.insert(expenseTaxes).values(
            resolved.map((tax, index) => ({
              expenseId: inserted!.id,
              label: tax.label,
              registrationNumber: tax.registrationNumber,
              rateTenThou: tax.rateTenThou,
              taxAmountCents: tax.taxAmountCents,
              isRecoverable: tax.isRecoverable,
              sortOrder: index,
              createdBy: allowed.actor.id,
            })),
          );
        }

        count += 1;
        totalCents += rowTotal;
      }
    });
  } catch (error) {
    return refused(failureText(error));
  }

  revalidatePath('/expenses');
  // No receipts attached in bulk entry — a row that needs its paper attached
  // is entered singly instead.
  return saved(
    `${count} ${count === 1 ? 'expense' : 'expenses'} totalling ${formatCents(totalCents)} recorded against ${projectName}. No receipts attached.`,
  );
}

/* -------------------------------------------------------------------------
   Voiding
   ------------------------------------------------------------------------- */

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks an expense as one that should never have existed.
 *
 * This is the only correction there is. Nothing is deleted -- the application
 * role holds no DELETE privilege at all -- and voiding is a complete
 * substitute by construction, because every figure this product reports is a
 * sum over live rows: a voided expense leaves the job's cost, the cost code's
 * total and the accountant export together, in one write, with a reason
 * attached and an audit row behind it.
 *
 * The tax lines are voided with it. A receipt whose subtotal has left the
 * books while its input tax credit stays behind is a claim with nothing under
 * it, and it is exactly the kind of remainder nobody finds until a review.
 */
export async function voidExpense(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('expense:write');
  if (!allowed.ok) return guardFailure(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, EXPENSE_LABELS, 'That void needs a reason.');

  let outcome: { totalCents: number; kind: string } | undefined;
  try {
    outcome = await db.transaction(async (tx) => {
      const voidColumns = {
        recordStatus: 'void' as const,
        voidedAt: new Date(),
        voidedBy: allowed.actor.id,
        voidReason: parsed.data.reason,
      };

      const rows = await tx
        .update(expenses)
        // `updated_at` is deliberately absent: a trigger maintains it, and a
        // value written here would be the one the sync cursor trusts.
        .set(voidColumns)
        .where(and(eq(expenses.id, parsed.data.id), eq(expenses.recordStatus, 'active')))
        .returning({ totalCents: expenses.totalCents, kind: expenses.kind });

      const row = rows[0];
      if (!row) return undefined;

      await tx
        .update(expenseTaxes)
        .set({ ...voidColumns, voidReason: `The expense was voided: ${parsed.data.reason}` })
        .where(
          and(eq(expenseTaxes.expenseId, parsed.data.id), eq(expenseTaxes.recordStatus, 'active')),
        );

      return row;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!outcome) return refused('That expense is already void, or is not on the list.');

  revalidatePath('/expenses');
  return saved(`${formatCents(outcome.totalCents)} voided.`);
}
