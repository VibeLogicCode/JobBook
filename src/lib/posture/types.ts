/**
 * What kind of work a company does.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT "BUILDER"
 * ---------------------------------------------------------------------------
 *
 * The owner asked for it and then asked the better question: *"can this app
 * not be used for other services like electrician plumber? i dont want to call
 * it a builder."* Naming the trade would make the product narrower than it is.
 * An electrician, a plumber, an HVAC contractor and a home builder all have
 * the same split INSIDE their own business. The axis is the WORK, not the
 * trade.
 *
 * And it is not invented vocabulary: electrical, plumbing and HVAC companies
 * already organise themselves exactly this way -- a service department and a
 * construction department, different paperwork, often different crews. It is
 * the language the customer already uses about himself, which is the only test
 * that matters for a word on a first-run screen.
 *
 * ---------------------------------------------------------------------------
 * `both` FIRST, AND WHY
 * ---------------------------------------------------------------------------
 *
 * `both` is today's behaviour, so it is the default and this whole change is
 * backward-compatible by construction. It is also first in the list, because a
 * picker whose default is not its first item is a picker people get wrong.
 *
 * A THIRD posture between service and contract was offered and declined. A
 * $15,000 bathroom is contract work with no schedule template, which the
 * per-type flags already allow -- so a middle tier would be a second way to
 * say something the flags already say, and the two would disagree the day one
 * of them changed.
 */
export type WorkPosture = 'both' | 'service' | 'contract';

export const POSTURES: readonly WorkPosture[] = ['both', 'service', 'contract'];

export const POSTURE_LABELS: Record<WorkPosture, string> = {
  both: 'Both',
  service: 'Service work',
  contract: 'Contract work',
};

export const POSTURE_SUMMARIES: Record<WorkPosture, string> = {
  both: 'Everything. Change it later if half of it turns out to be noise.',
  service: 'Dispatched jobs. One visit or a few days, one invoice, no holdback.',
  contract: 'A signed scope. Progress draws, holdback, subcontractors, a schedule.',
};

/**
 * The five behavioural flags a project type carries.
 *
 * ---------------------------------------------------------------------------
 * WHY THEY LIVE ON THE TYPE AND NOT ON THE COMPANY
 * ---------------------------------------------------------------------------
 *
 * Because the fact each describes is a fact about the JOB.
 *
 * Since the 2018 amendments the Construction Act's "improvement" includes
 * capital repair and excludes maintenance. A leaking tap is maintenance; a
 * panel swap is an improvement. So the line is not contract size and not the
 * company's posture -- it is a per-job fact about the work, and this is where
 * a per-job fact belongs.
 *
 * An earlier draft put them on the company and produced a fatal
 * contradiction: a contract-flagged job was said to turn holdback back on,
 * while contract types were not offered at all under a service-only company.
 * The override could never fire, so holdback was exactly the hard removal that
 * draft said must never exist.
 */
export interface ProjectTypeFlags {
  /** No holdback percentage on the quote, no ledger, no release. */
  holdback: boolean;
  /** One invoice at the end; no draws. */
  progressInvoicing: boolean;
  /** No schedule template and no forward pass. */
  scheduleTemplate: boolean;
  /** No substantial performance, publication or last supply dates. */
  constructionActDates: boolean;
  /** No area, washroom, kitchen or bedroom counts. */
  scopeInputs: boolean;
}

export const FLAG_KEYS: readonly (keyof ProjectTypeFlags)[] = [
  'holdback',
  'progressInvoicing',
  'scheduleTemplate',
  'constructionActDates',
  'scopeInputs',
];

/**
 * Everything on, which is what every project type does today.
 *
 * Named rather than written inline at three call sites, because "today's
 * behaviour" is the thing the migration's backfill, the `both` posture and a
 * new type's defaults all have to agree about -- and three copies of it is
 * three chances for one of them to drift into changing what an existing job
 * does.
 */
export const ALL_FLAGS_ON: ProjectTypeFlags = {
  holdback: true,
  progressInvoicing: true,
  scheduleTemplate: true,
  constructionActDates: true,
  scopeInputs: true,
};

/**
 * What a NEWLY CREATED project type is pre-set to, per posture.
 *
 * One table rather than branching at the call site, so "what does service
 * mean" has exactly one answer and adding a flag is one row of edits.
 *
 * These are DEFAULTS ON A FORM, not rules. The owner can turn any of them back
 * on for a type he creates -- which is the whole point of the flags living on
 * the type: a service electrician who takes one full rewire a year makes a
 * `Rewire` type with holdback on, without changing what his company is.
 *
 * `contract` and `both` are identical, and that is not redundancy to collapse:
 * they mean different things about which types are OFFERED, and a contract-only
 * company's new types should carry the full paperwork exactly as a mixed
 * company's do.
 */
export const POSTURE_DEFAULTS: Record<WorkPosture, ProjectTypeFlags> = {
  both: ALL_FLAGS_ON,
  contract: ALL_FLAGS_ON,
  service: {
    holdback: false,
    progressInvoicing: false,
    scheduleTemplate: false,
    constructionActDates: false,
    scopeInputs: false,
  },
};
