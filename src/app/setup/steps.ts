/**
 * The ordered first-run path (design section 8.6).
 *
 * An ORDER, not a menu. Settings already exposes every one of these fields as
 * a set of independent sections a person opens in any sequence they like; this
 * screen exists because a company that has just been stood up has none of them
 * yet, and "which of these forty fields must I fill in before the product
 * works" is a question a menu cannot answer. The sequence is the answer.
 *
 * The slugs are route segments, so a half-finished setup is a URL the
 * installer can bookmark, and the step a browser crash interrupted is the step
 * the next request resumes at.
 */

export const SETUP_STEPS = [
  {
    slug: 'company',
    title: 'Company',
    summary: 'The names on every document, and who signs them.',
    /** Shown on the step itself, above the fields. */
    why: 'Nothing about the company is built into the product.',
  },
  {
    slug: 'contact',
    title: 'Contact',
    summary: 'The address and contact block a customer reads.',
    why: 'These print on the letterhead of every quote.',
  },
  {
    slug: 'locale',
    title: 'Locale',
    summary: 'Currency, language, timezone and area unit.',
    why: 'The timezone decides what date a quote carries.',
  },
  {
    slug: 'financial',
    title: 'Financial',
    summary: 'Tax registration, fiscal year, holdback, payment terms, margin.',
    why: 'Retrofitting a fiscal year end means re-asking the owner.',
  },
  {
    slug: 'tax-rate',
    title: 'Tax rate',
    summary: 'The first rate, and the date it took effect.',
    why: 'Rates are versioned by effective date rather than edited.',
  },
  {
    slug: 'first-user',
    title: 'First user',
    summary: 'The owner account.',
    why: 'Authorization is a lookup against this table on every request, in every mode.',
  },
  {
    slug: 'access',
    title: 'Access',
    summary: 'Where this deployment sits on the network, and who may reach it.',
    /**
     * After the first user, because the office-network posture names an
     * address that has to match a real account, and before the environment
     * report, because that report reads what this step wrote.
     */
    why: 'The software cannot tell whether this machine is reachable from the internet, and the wrong answer here hands the company away.',
  },
  {
    slug: 'environment',
    title: 'Environment',
    summary: 'What the deployment already has, and what it is missing.',
    // A credential in a form is a credential in every backup.
    why: 'Read-only. This step collects nothing.',
  },
  {
    slug: 'done',
    title: 'Done',
    summary: 'What was created, and the way in.',
    why: 'Finishing closes this wizard permanently. Every field stays editable under Settings.',
  },
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupStepSlug = SetupStep['slug'];

/**
 * The steps that write something. `environment` writes nothing and `done`
 * writes only the completion marker, but both still carry a progress marker of
 * their own -- otherwise "resume where you left off" would land on the
 * environment report forever, since no data it could look for exists.
 */
export const SETUP_STEP_SLUGS: readonly SetupStepSlug[] = SETUP_STEPS.map((step) => step.slug);

export const FIRST_STEP: SetupStepSlug = SETUP_STEPS[0].slug;
export const LAST_STEP: SetupStepSlug = SETUP_STEPS[SETUP_STEPS.length - 1]!.slug;

export function stepAt(slug: SetupStepSlug): SetupStep {
  const step = SETUP_STEPS.find((candidate) => candidate.slug === slug);
  // Unreachable from a typed call site; thrown rather than defaulted so a
  // mistyped slug in a route file fails loudly instead of rendering step one
  // under another step's heading.
  if (!step) throw new Error(`unknown setup step: ${slug}`);
  return step;
}

export function stepIndex(slug: SetupStepSlug): number {
  return SETUP_STEP_SLUGS.indexOf(slug);
}

/** The step after this one, or null at the end of the path. */
export function nextSlug(slug: SetupStepSlug): SetupStepSlug | null {
  return SETUP_STEP_SLUGS[stepIndex(slug) + 1] ?? null;
}

/** The step before this one, or null at the start. */
export function previousSlug(slug: SetupStepSlug): SetupStepSlug | null {
  const index = stepIndex(slug);
  return index <= 0 ? null : SETUP_STEP_SLUGS[index - 1]!;
}

export function setupHref(slug: SetupStepSlug): string {
  return `/setup/${slug}`;
}
