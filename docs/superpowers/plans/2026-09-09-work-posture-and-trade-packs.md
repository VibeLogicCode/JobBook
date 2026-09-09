# Work posture and trade starter packs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A company says whether it does service work, contract work or both; the project types it is offered, and the fields on every form, follow from that. A new installation picks its trade and starts with a rate book, cost codes and project types instead of five empty lists.

**Architecture:** Every behavioural flag is a column on `project_types`. Posture does exactly three things: it decides which types a company is offered, it supplies the default flag values for a newly created type, and it gates two routes. A trade pack is a one-time copy into the owner's own rows — never a link, never updated afterwards, and carrying no prices.

**Tech Stack:** Next.js 16 App Router (Turbopack), React 19, TypeScript strict, Drizzle ORM 0.45.2, PostgreSQL 16, Vitest 3 (`environment: 'node'`).

**Spec:** `docs/superpowers/specs/2026-09-09-service-and-contract-work-design.md` (revision 2)

**Runs after:** `docs/superpowers/plans/2026-09-09-companies.md`. **This is a hard dependency, not a preference.** Spec §3.1 put `work_posture` on `organization` because `companies` did not exist and was unscheduled. It exists now, and posture is per-company in the owner's own case — the repair company is service, the builder is contract. Building it on `organization` first would mean building it in the wrong place and migrating one column.

**Prerequisites already met:** backlog §10b.1 (`LOCAL_USER_EMAIL` optional, `6dbca1d`) — without it no customer reaches the wizard and therefore no customer reaches the packs. And §5.3's structural guard against zero-priced lines is **already built** (`src/lib/quote/unpriced.ts`, `280d5fd`), which is what makes shipping unpriced packs safe.

## Global Constraints

- **Next.js 16.** Read `node_modules/next/dist/docs/` before writing App Router code.
- **Every flag lives on `project_types`. Posture removes no module.** Verified against the code: nothing in `src/components/ui/destinations.ts` is removable (`/templates` is one destination covering both scope and schedule templates), and nothing in `src/app/settings/nav.ts` is removable (`/settings/financial` holds holdback *beside* tax registration, fiscal year and margin). The only whole routes posture gates are `/templates/schedule` and `/templates/schedule/[id]`. Two.
- **`'both'` is the default and changes nothing.** Backward compatible by construction. `src/db/schema/organization.ts:171`: *"Absence is the off state, so no defaulted column can switch a feature on for someone who never asked."*
- **Posture is not a permission.** `loadOrganization` and `loadCompanies` swallow errors, so a database blip resolves posture to `'both'` and the fuller forms appear. It fails OPEN, deliberately. Nothing here protects anything; it shortens forms.
- **Trade gates nothing at runtime.** No screen behaves differently because of it. It decides which pack is loaded, once. The same electrician does service calls and full rewires.
- **Packs carry no prices, and no zero prices either.** Spec §5.3. A zero-sell line contributes nothing to the subtotal, reads 0.00% margin (`marginBasisPoints` returns 0 on zero revenue), and does **not print at all** under `pricingDisplay`'s `group_totals` default — so the customer gets a document silently missing the price of real work. `src/lib/quote/unpriced.ts` refuses it structurally.
- **No MasterFormat, no NAHB chart.** Owner declined to license, 2026-09-09. Plain-language divisions with our own numbering.
- **A seeded row is never updated by any mechanism.** "Update your rate book from the latest pack" would overwrite a contractor's own prices — the most destructive thing this product could do. A pack improved later reaches only new installations.
- **Retire, never delete.** A pack that does not want the nine migration-0018 project types sets `isActive = false` on them. Every project already filed under one keeps reading it.
- **Rates are ten-thousandths as `bigint`.** 10% is `100000n`.
- **Tests are `environment: 'node'`.** No DOM tests. A rule that must be asserted has to be expressible as data.
- **Commit after every task.** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. No local paths or personal names in commits or code.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/lib/posture/types.ts` | `WorkPosture`, `POSTURES`, the labels. Pure. |
| `src/lib/posture/read.ts` | `postureOf(company)`, `hasContractWork()`, `hasServiceWork()`. Derived, not cached separately. |
| `src/lib/posture/defaults.ts` | The flag values a new project type gets under each posture. One table, no branching at call sites. |
| `src/lib/project-type/flags.ts` | `flagsFor(projectTypeId)`, and the `ProjectTypeFlags` shape every form consumes. |
| `src/db/seed/packs/types.ts` | The `TradePack` shape. |
| `src/db/seed/packs/{gc,electrical,plumbing,hvac,none}.ts` | Four packs plus the plain start. Content. |
| `src/db/seed/packs/load.ts` | `loadPack(tx, trade)`. Idempotent on fixed ids; retires what the pack does not want. |
| `src/app/setup/trade/page.tsx` | The wizard step: posture and trade, in that order. |
| `src/app/settings/project-types/flags.tsx` | The five flags on the existing project-types screen. |
| `tests/unit/posture.test.ts`, `tests/unit/project-type-flags.test.ts` | Resolution, defaults, fail-open. |
| `tests/integration/pack-seeding.test.ts` | Retirement, idempotency, and that `/vendors` does not re-append the GC trades. |
| `tests/integration/service-quote.test.ts` | A service job's quote carries no holdback. |

**Modified:**

| File | Change |
|---|---|
| `src/db/schema/project-lists.ts` | `project_types` gains five flags and a `posture` tag. |
| `src/db/schema/companies.ts` | `workPosture`, default `'both'`. |
| `src/lib/quote/repository.ts:192,253` | **The single most important lines in this plan.** |
| `src/app/projects/[id]/billing/actions.ts:34` | Invoice kinds follow the flags, not posture. |
| `src/db/seed/vendor-lists.ts:155` | `ensureVendorLists` becomes pack-aware. |
| `src/db/seed/line-groups.ts:75` | `ensureLineGroups` becomes pack-aware. |
| `src/app/templates/schedule/page.tsx`, `[id]/page.tsx` | Refuse when no company does contract work. |
| `src/app/setup/steps.ts` | One new step. `tests/integration/setup.test.ts` walks steps by name — real churn. |
| `src/db/seed/demo.ts` | Renumber off MasterFormat division numbers. Spec §5.6. |

---

## Task 1: The flags on `project_types`

**Files:**
- Modify: `src/db/schema/project-lists.ts`
- Modify: `src/db/schema/companies.ts`
- Create: `src/lib/posture/types.ts`
- Create: `drizzle/0022_project_type_flags.sql`
- Test: `tests/unit/posture.test.ts`, `tests/db/project-type-flags.test.ts`

**Interfaces:**
- Produces: `type WorkPosture = 'service' | 'contract' | 'both'`, `POSTURES: readonly WorkPosture[]`, `POSTURE_LABELS: Record<WorkPosture, string>`, `projectTypes.holdback|progressInvoicing|scheduleTemplate|constructionActDates|scopeInputs` (all `boolean NOT NULL`), `projectTypes.posture` (`WorkPosture`), `companies.workPosture` (`WorkPosture`, default `'both'`).

**The backfill is the whole risk.** Every one of the nine existing types must keep today's behaviour — `Water leak` and `Other` included. "Current behaviour" is the migration's job to make explicit, not the reader's to infer.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/project-type-flags.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { projectTypes } from '@/db/schema';
import { DEFAULT_PROJECT_TYPES } from '@/db/seed/project-lists';

describe('the nine existing types keep today behaviour', () => {
  it('has every flag on for all nine, Water leak and Other included', async () => {
    const ids = DEFAULT_PROJECT_TYPES.map((row) => row.id);
    const rows = await db.select().from(projectTypes).where(inArray(projectTypes.id, ids));
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      // Today every project type computes holdback, offers draws, has a
      // schedule template, carries Construction Act dates and shows scope
      // inputs -- because none of that was ever conditional. A migration that
      // turned any of it off for an existing type would change the terms of a
      // signed contract.
      expect(row.holdback).toBe(true);
      expect(row.progressInvoicing).toBe(true);
      expect(row.scheduleTemplate).toBe(true);
      expect(row.constructionActDates).toBe(true);
      expect(row.scopeInputs).toBe(true);
      expect(row.posture).toBe('both');
    }
  });
});
```

```ts
// tests/unit/posture.test.ts
import { describe, expect, it } from 'vitest';
import { POSTURES, POSTURE_LABELS } from '@/lib/posture/types';

describe('the posture vocabulary', () => {
  it('offers exactly three, with Both first', async () => {
    // Both is today's behaviour, so it is the default AND the first option --
    // a picker whose default is not its first item is a picker people get
    // wrong. A fourth posture was offered and declined: a $15,000 bathroom is
    // contract work with no schedule template, which the flags already allow.
    expect(POSTURES).toEqual(['both', 'service', 'contract']);
  });

  it('names the work and never the trade', () => {
    // "Builder" would make the product narrower than it is. An electrician, a
    // plumber and a home builder all have this same split inside their own
    // business, and electrical and plumbing companies already organise
    // themselves as a service department and a construction department.
    expect(Object.values(POSTURE_LABELS).join(' ')).not.toMatch(/builder|contractor/i);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/unit/posture.test.ts tests/db/project-type-flags.test.ts`
Expected: FAIL — `@/lib/posture/types` does not exist.

- [ ] **Step 3: Write the vocabulary**

```ts
// src/lib/posture/types.ts
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
```

- [ ] **Step 4: Add the columns**

On `projectTypes` in `src/db/schema/project-lists.ts`:

```ts
  /**
   * Which posture offers this type on new work.
   *
   * `both` means every company sees it. A pack's `Service call` is tagged
   * `service` and its `Rewire` is tagged `contract`; `Panel upgrade` is
   * `both`. One list per trade with rows tagged, NOT a trade x posture matrix
   * -- adding a posture later must not multiply the content.
   */
  posture: workPostureEnum('posture').notNull().default('both'),

  /**
   * ---------------------------------------------------------------------------
   * THE FIVE FLAGS, AND WHY THEY ARE HERE RATHER THAN ON THE COMPANY
   * ---------------------------------------------------------------------------
   *
   * Because the fact they describe is a fact about the JOB.
   *
   * Since the 2018 amendments the Construction Act's "improvement" includes
   * capital repair and excludes maintenance. A leaking tap is maintenance; a
   * panel swap is an improvement. So the line is not contract size and not the
   * company's posture -- it is a per-job fact about the work, and this is
   * where a per-job fact belongs.
   *
   * Revision 1 of the spec put them on the company and produced a fatal
   * contradiction: a contract-flagged job was said to turn holdback back on,
   * while contract types were not offered at all under a service-only company.
   * The override could never fire. Every flag lives here now, and posture only
   * chooses what is offered.
   *
   * Each defaults to TRUE, which is today's behaviour for every one of the
   * nine types migration 0018 created.
   */
  holdback: boolean('holdback').notNull().default(true),
  progressInvoicing: boolean('progress_invoicing').notNull().default(true),
  scheduleTemplate: boolean('schedule_template').notNull().default(true),
  constructionActDates: boolean('construction_act_dates').notNull().default(true),
  scopeInputs: boolean('scope_inputs').notNull().default(true),
```

with `workPostureEnum = pgEnum('work_posture', ['both', 'service', 'contract'])` added to `src/db/enums.ts` beside the others, and `workPosture: workPostureEnum('work_posture').notNull().default('both')` added to `companies`.

- [ ] **Step 5: Write the migration**

```sql
-- drizzle/0022_project_type_flags.sql
CREATE TYPE "work_posture" AS ENUM ('both', 'service', 'contract');

ALTER TABLE "companies" ADD COLUMN "work_posture" "work_posture" DEFAULT 'both' NOT NULL;

-- DEFAULT true on all five, so every existing row keeps today's behaviour
-- without an UPDATE. Stated rather than inferred: `Water leak` and `Other`
-- are included deliberately. A migration that guessed "a water leak is
-- maintenance, so holdback off" would change the terms of jobs already signed
-- under those types.
ALTER TABLE "project_types" ADD COLUMN "posture" "work_posture" DEFAULT 'both' NOT NULL;
ALTER TABLE "project_types" ADD COLUMN "holdback" boolean DEFAULT true NOT NULL;
ALTER TABLE "project_types" ADD COLUMN "progress_invoicing" boolean DEFAULT true NOT NULL;
ALTER TABLE "project_types" ADD COLUMN "schedule_template" boolean DEFAULT true NOT NULL;
ALTER TABLE "project_types" ADD COLUMN "construction_act_dates" boolean DEFAULT true NOT NULL;
ALTER TABLE "project_types" ADD COLUMN "scope_inputs" boolean DEFAULT true NOT NULL;
```

- [ ] **Step 6: Run the tests** — `npm run db:migrate && npx vitest run && npx tsc --noEmit`
- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: a project type says what paperwork its jobs need"
```

---

## Task 2: The posture reader, and which types a company is offered

**Files:**
- Create: `src/lib/posture/read.ts`, `src/lib/posture/defaults.ts`
- Create: `src/lib/project-type/flags.ts`
- Modify: `src/app/projects/new/page.tsx`, `src/app/quotes/new/page.tsx`
- Test: `tests/unit/posture.test.ts` (extend), `tests/integration/offered-types.test.ts`

**Interfaces:**
- Produces: `offeredTypes(companyId): Promise<ProjectType[]>`, `hasContractWork(): Promise<boolean>`, `hasServiceWork(): Promise<boolean>`, `flagsFor(tx, projectTypeId): Promise<ProjectTypeFlags>`, `defaultFlagsFor(posture): ProjectTypeFlags`.
- Consumes: `loadCompanies` from the companies plan. **Do not add a second cached reader** — `loadCompanies` is already `cache()`-wrapped and the root layout already calls it. `React.cache` is per-request, which is correct: posture is not authentication and `proxy.ts` never sees it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/offered-types.test.ts
it('offers a service company only service and both types', async () => {
  const offered = await offeredTypes(serviceCompanyId);
  const names = offered.map((row) => row.name);
  expect(names).toContain('Service call');
  expect(names).not.toContain('Custom home');
});

it('offers everything under both', async () => {
  expect((await offeredTypes(bothCompanyId)).length).toBeGreaterThan(
    (await offeredTypes(serviceCompanyId)).length,
  );
});

it('fails open when the company cannot be read', async () => {
  // `loadCompanies` swallows errors to an empty list, and posture is not a
  // permission -- nothing here protects anything, it shortens forms. So a
  // database blip must show the FULLER form, never a shorter one that
  // silently drops the holdback a signed contract depends on.
  expect(await postureOf(null)).toBe('both');
});
```

- [ ] **Step 2: Run it to make sure it fails.**

- [ ] **Step 3: Write the reader**

```ts
// src/lib/posture/read.ts
/**
 * Posture, derived. NOT a second cached reader.
 *
 * `loadCompanies` is already `cache()`-wrapped and the root layout already
 * calls it, so this is a pure function of a row somebody has already read. A
 * second cache would be a second thing to invalidate for no gain.
 *
 * IT FAILS OPEN. `loadCompanies` swallows errors to an empty list, so a
 * database blip resolves posture to `both` and the fuller forms appear. That
 * is deliberate and is the safe direction: posture is not a permission and
 * nothing here protects anything. The dangerous failure is the other one --
 * a blip that hid the holdback field on a contract job.
 *
 * The predicates are derived rather than compared inline so a call site reads
 * as a question about the business, and so a fourth posture would not touch
 * any of them.
 */
export function postureOf(company: { workPosture: WorkPosture } | null): WorkPosture {
  return company?.workPosture ?? 'both';
}

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
 * over the whole deployment: `/templates/schedule` is not company-scoped, so
 * it cannot be refused per company. One contract company means the route
 * exists for everyone who can reach it.
 */
export async function hasContractWork(): Promise<boolean> {
  const companies = await loadCompanies();
  if (companies.length === 0) return true; // fails open
  return companies.some((row) => offersContract(row.workPosture));
}
```

- [ ] **Step 4: Write the defaults table**

```ts
// src/lib/posture/defaults.ts
/**
 * What a NEWLY CREATED project type is pre-set to, per posture.
 *
 * One table rather than branching at the call site, so "what does service
 * mean" has exactly one answer and adding a flag is one row of edits.
 *
 * These are DEFAULTS ON A FORM, not rules. The owner can turn any of them
 * back on for a type he creates -- which is the whole point of the flags
 * living on the type: a service electrician who takes one full rewire a year
 * makes a `Rewire` type with holdback on, without changing his company.
 */
export const POSTURE_DEFAULTS: Record<WorkPosture, ProjectTypeFlags> = {
  both:     { holdback: true,  progressInvoicing: true,  scheduleTemplate: true,  constructionActDates: true,  scopeInputs: true  },
  contract: { holdback: true,  progressInvoicing: true,  scheduleTemplate: true,  constructionActDates: true,  scopeInputs: true  },
  service:  { holdback: false, progressInvoicing: false, scheduleTemplate: false, constructionActDates: false, scopeInputs: false },
};
```

- [ ] **Step 5: Filter the type pickers** on the two creation forms by `offeredTypes(companyId)`.
- [ ] **Step 6: Run the tests, typecheck.**
- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: a company is offered the kinds of work it actually does"
```

---

## Task 3: A service job's quote carries no holdback

**Files:**
- Modify: `src/lib/quote/repository.ts:192,253`
- Test: `tests/integration/service-quote.test.ts`

**Interfaces:** consumes `flagsFor`.

**Spec §4.1 item 2: the single most important line in the implementation.** `repository.ts` copies `company.defaultHoldbackPctTenThou` onto every new quote. If the project-type flag does not intercept here, a service job's accepted quote carries 10% and its final invoice withholds it — a wrong number about money on a document the customer signs, with the arithmetic entirely innocent. Revision 1 of the spec never named this call site.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/service-quote.test.ts
it('writes no holdback percentage on a service-type job', async () => {
  const project = await createProject({ projectTypeId: serviceTypeId, companyId });
  const quote = await createQuote({ projectId: project.id });
  const [row] = await db.select().from(quotes).where(eq(quotes.id, quote.id));
  // NULL, not 0. `contractOf` in lib/invoice/repository.ts:149 deliberately
  // refuses an org-default fallback -- "absent means the contract withholds
  // nothing" -- so absence is the representation the invoice engine already
  // understands.
  expect(row!.holdbackPctTenThou).toBeNull();
});

it('still writes it on a contract-type job', async () => {
  const project = await createProject({ projectTypeId: contractTypeId, companyId });
  const quote = await createQuote({ projectId: project.id });
  const [row] = await db.select().from(quotes).where(eq(quotes.id, quote.id));
  expect(row!.holdbackPctTenThou).toBe(100000n);
});

it('does not invent a statutory default', async () => {
  // Revision 1 promised "sane statutory defaults" when the settings screen is
  // hidden. Withdrawn: a 10% fallback would be a jurisdiction assumption
  // wearing a number that both invoices.ts and holdback.ts refuse. The only
  // value needed is the percentage, and the override sets it explicitly or
  // there is no holdback.
  const company = await companyWithNoHoldbackDefault();
  const quote = await createQuote({ projectId: (await createProject({ projectTypeId: contractTypeId, companyId: company.id })).id });
  expect((await loadQuoteRow(quote.id)).holdbackPctTenThou).toBeNull();
});
```

- [ ] **Step 2: Run it to make sure it fails** — today it writes `100000n` for both.

- [ ] **Step 3: Intercept**

```ts
// src/lib/quote/repository.ts, both line 192 and line 253
        /**
         * The org default, but ONLY if this kind of job withholds anything.
         *
         * THE line the spec calls the most important one in this change. It
         * copies the company's default onto every new quote, and without the
         * flag check a service job's accepted quote carries 10% and its final
         * invoice withholds it -- silently, on a document the customer signs.
         *
         * NULL rather than 0n when the flag is off, because
         * `lib/invoice/repository.ts:149` already reads absence as "the
         * contract withholds nothing" and refuses to fall back to a company
         * default. Writing 0n would be a second representation of the same
         * fact, and `lib/quote/holdback-notice.ts` would then have two shapes
         * to refuse instead of one.
         */
        holdbackPctTenThou: flags.holdback ? company.defaultHoldbackPctTenThou : null,
```

with `const flags = await flagsFor(tx, project.projectTypeId);` read alongside the company in the same transaction.

- [ ] **Step 4: Run the tests, typecheck.**
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: a service job's quote does not withhold a holdback nobody agreed to"
```

---

## Task 4: Turning holdback back on for one job

**Files:**
- Modify: `src/components/worksheet/` (the quote header fields), `src/app/quotes/[id]/actions.ts`
- Test: `tests/integration/holdback-override.test.ts`

**Spec §4.2 — the work revision 1 did not list.** Verified: **no screen exposes `quotes.holdbackPctTenThou`.** It is written by `repository.ts` from the company default, read by the invoice engine, and printed — and never editable. So "a job can turn holdback back on" has no interface to turn it on with, and the flag on the project type is only half a mechanism without it.

- [ ] **Step 1: Write the failing test** — setting the override on a service-type job puts a percentage on that quote and leaves the type alone; clearing it returns to null; a non-numeric or out-of-range value is refused.
- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Add the field and the action.** It must SET the column — `lib/invoice/repository.ts:149` refuses to fall back to a company default, with an explicit comment, so an override that only cleared the flag would change nothing.
- [ ] **Step 4: Run the tests, typecheck.**
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: a job can withhold a holdback its project type does not"
```

---

## Task 5: Invoice kinds follow the flags

**Files:**
- Modify: `src/app/projects/[id]/billing/actions.ts:34`
- Test: `tests/integration/billing-kinds.test.ts`

**Spec §10.2 — the stranded receivable, and the reason this is not at the posture level.** Revision 1 removed the `progress` and `holdback_release` kinds per company. Holdback accrues only on draws and is paid out only by a release, so a contract job under a service-only company would have withheld 10% and had **no invoice kind able to bill it back**: money owed, in the ledger, un-invoiceable.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses a progress draw on a job whose type does not do them', async () => {
  const result = await issueCustomerInvoice(serviceProjectId, { kind: 'progress' });
  expect(result.kind).toBe('refused');
});

it('permits a release wherever holdback was actually withheld', async () => {
  // Follows the FLAG, and via the flag the quote's own percentage -- never the
  // company's posture. A job that withheld money must always be able to bill
  // it back, whatever its company now says it does.
  const result = await issueCustomerInvoice(overriddenServiceProjectId, { kind: 'holdback_release' });
  expect(result.kind).not.toBe('refused');
});
```

- [ ] **Step 2: Run it to make sure it fails** — `z.enum(['progress', 'final'])` refuses `holdback_release` for everyone today, which is the separate backlog defect; this task must not silently claim to fix it.
- [ ] **Step 3: Derive the accepted kinds from the flags** at the action, refusing with a sentence that names the project type.
- [ ] **Step 4: Run the tests, typecheck.**
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: which invoices a job can raise follows what it withheld"
```

**Scope note:** this task makes `holdback_release` *reachable where the flag allows it*, but the release FORM — which collects the figures — is AP/AR work recorded in backlog §12 and is not built here. Say so in the commit rather than leaving a reader to assume the backlog entry is closed.

---

## Task 6: The two gated routes

**Files:**
- Modify: `src/app/templates/schedule/page.tsx`, `src/app/templates/schedule/[id]/page.tsx`
- Test: `tests/integration/route-refusal.test.ts`

- [ ] **Step 1: Write the failing test** — `/templates/schedule` refused when no company does contract work, **called directly rather than through a link.** A hidden nav entry is not a mechanism; this codebase has already written that about the estimator role.
- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Guard both routes on `hasContractWork()`.** Nothing in `destinations.ts` or `settings/nav.ts` changes — `/templates` is one destination covering both template kinds, so removing the link would remove scope templates too.
- [ ] **Step 4: Run the tests, typecheck, and `npx vitest run tests/unit/navigation.test.ts`** — the one-list invariant must still hold.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: no schedule templates where nobody does contract work"
```

---

## Task 7: The flags reach the forms

**Files:**
- Modify: `src/components/worksheet/` (scope inputs — on `quotes`, at `src/db/schema/quotes.ts:42-45`)
- Modify: `src/app/projects/[id]/page.tsx` (Construction Act dates — on `projects`, at `src/db/schema/customers.ts:66`)
- Modify: `src/app/projects/[id]/schedule/page.tsx` (schedule template)
- Modify: `src/app/settings/project-types/` (the five flags, editable)
- Test: `tests/integration/flagged-forms.test.ts`

- [ ] **Step 1: Write the failing test** — a service-type job's quote loader returns no scope-input fields and its project loader no Construction Act dates. **Assert on the loader's returned shape, not on rendering.** `docs/superpowers/specs/2026-09-05-estimator-role-design.md` §1 established why: a conditional render leaves the figure in the RSC payload, so "the loader must return a shape that does not contain it" is the only assertable rule in a `node` test environment.
- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Apply the flags at the loaders**, and add the five checkboxes to the project-types settings screen with `defaultFlagsFor(posture)` pre-filling a new row.
- [ ] **Step 4: Run the full suite, typecheck, build.**
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: a job's forms carry only the fields its kind of work needs"
```

---

## Task 8: The pack mechanism

**Files:**
- Create: `src/db/seed/packs/types.ts`, `src/db/seed/packs/load.ts`
- Modify: `src/db/seed/vendor-lists.ts:155`, `src/db/seed/line-groups.ts:75`
- Test: `tests/integration/pack-seeding.test.ts`

**Interfaces:**
- Produces: `type TradePack = { trade: Trade; projectTypes: PackProjectType[]; costCodes: PackCostCode[]; rateItems: PackRateItem[]; lineGroups: PackLineGroup[]; trades: PackTrade[] }`, `loadPack(tx, trade): Promise<void>`.

**Spec §5.8 — the mechanism does not exist, and the existing seeds fight it.** `src/db/seed/project-lists.ts` is a set of constants mirroring migration 0018's SQL; it seeds nothing at runtime. Three consequences, each of which breaks the feature:

1. **The nine builder project types are in every database before the wizard runs.** An electrician's first screen would read "Custom home, Basement, Renovation…" *plus* his pack. **So a pack must RETIRE the types it does not want.**
2. **`ensureVendorLists` and `ensureLineGroups` seed lazily on first visit** to `/vendors`, `/settings/trades`, `/settings/vendor-types` and `/settings/line-groups` — five call sites, verified — appending the full GC set. An electrician's short trade list would acquire twelve general-contracting trades the first time he opened Vendors, and his line groups "Framing, Drywall, Concrete…". **Not optional: it silently undoes the pack.**
3. **Fixed ids per pack row.** Not for wizard re-runs (`readSetupGate` refuses those on a live tenant) but for re-submitting a step within one setup, and for a later "load a pack" entry point in Settings.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/pack-seeding.test.ts
it('retires the builder types the pack does not want', async () => {
  await db.transaction((tx) => loadPack(tx, 'electrical'));
  const [customHome] = await db.select().from(projectTypes)
    .where(eq(projectTypes.id, PROJECT_TYPE_IDS.customHome));
  // Retired, not deleted. A job already filed as a Custom home must go on
  // reading that on its own record.
  expect(customHome!.isActive).toBe(false);
});

it('does not re-append the GC trades when Vendors is opened', async () => {
  await db.transaction((tx) => loadPack(tx, 'electrical'));
  const before = await db.select().from(trades);
  await ensureVendorLists();           // what /vendors calls on every visit
  const after = await db.select().from(trades);
  // The §5.8 item 2 test, and the one that matters most: a lazy seed that
  // appends twelve general-contracting trades silently undoes the pack the
  // owner just chose.
  expect(after).toHaveLength(before.length);
});

it('is idempotent', async () => {
  await db.transaction((tx) => loadPack(tx, 'electrical'));
  await db.transaction((tx) => loadPack(tx, 'electrical'));
  const codes = await db.select().from(costCodes);
  expect(new Set(codes.map((row) => row.id)).size).toBe(codes.length);
});

it('ships no prices at all', async () => {
  await db.transaction((tx) => loadPack(tx, 'plumbing'));
  const items = await db.select().from(rateItems);
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    // Not "no invented prices" -- no prices. Zero is not the safe option: a
    // zero-sell line adds nothing to the subtotal, reads 0.00% margin, and
    // does not print at all under `pricingDisplay`'s group_totals default, so
    // the customer gets a document silently missing the price of real work.
    // `src/lib/quote/unpriced.ts` refuses such a line structurally, which is
    // what makes shipping them safe.
    expect(item.sellRateTenThou).toBe(0n);
  }
});
```

- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Write `loadPack`** — `onConflictDoNothing` on fixed ids, and one `UPDATE ... SET is_active = false` over the migration-0018 ids the pack does not name.
- [ ] **Step 4: Make the lazy seeds pack-aware.** A `settings` row recording which pack was loaded is the cheapest correct answer: `ensureVendorLists` becomes a no-op once a pack has been loaded, because the pack has already supplied that list. Record the choice in the file's header — the existing header explains why it seeds lazily and must now explain why it sometimes does not.
- [ ] **Step 5: Run the full suite, typecheck.**
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: a trade pack loads, retires what it does not want, and stays loaded"
```

---

## Task 9: The four packs, as content

**Files:**
- Create: `src/db/seed/packs/{gc,electrical,plumbing,hvac,none}.ts`
- Modify: `src/db/seed/demo.ts`
- Test: `tests/unit/packs.test.ts`

**The GC pack is not free.** Revision 1 called it "today's list, unchanged and therefore free" and was wrong: no cost codes or rate items ship to a real install today — `src/db/seed/schedule-templates.ts` says so in as many words. The only GC list is the demo tenant's, and it carries **prices and MasterFormat division numbers** (`01-00`, `03-30`, `22-00`, `26-00`), violating both hard rules. The GC pack must be authored like the other three.

**And the demo tenant gets renumbered.** Spec §5.6: eight division numbers is plausibly de minimis, but the spec should not leave its own rule contradicted by its own demo, and renumbering costs nothing.

- [ ] **Step 1: Write the failing test** — every pack has at least one service-tagged and one contract-tagged project type; no rate item has a non-zero rate; no cost code matches `/^\d{2}-\d{2}$/` (the MasterFormat shape); the `none` pack supplies project types and line groups only, and no vendors or customers appear in any pack.
- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Author the four packs.** Shallow cost codes — a deep hierarchy nobody asked for is the first thing a new user deletes. Six to ten per trade. Plain-language divisions, our own numbering.
- [ ] **Step 4: Renumber the demo tenant** off MasterFormat.
- [ ] **Step 5: Run the full suite, typecheck, build.**
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: starter data for four trades, and a demo that follows its own rule"
```

**Each pack wants somebody who does that trade to read it.** Landscaping, roofing, painting and drywall are the obvious next four and are deliberately excluded.

---

## Task 10: The wizard asks

**Files:**
- Create: `src/app/setup/trade/page.tsx`
- Modify: `src/app/setup/steps.ts`, `src/app/setup/state.ts`, `src/app/setup/done/page.tsx`
- Test: `tests/integration/setup.test.ts`

**Real churn, which revision 1 did not list.** `tests/integration/setup.test.ts` asserts `resumeAt` by slug (`'tax-rate'`, `'done'`) and walks the steps by name, so adding one is not free.

**Posture must be known before the pack**, since the pack's rows are filtered by it — so trade and posture share one step, or posture comes first. One step, both questions: *"What kind of work do you do?"* then *"What trade?"*, because they are one decision to the person answering and two screens would let them be answered inconsistently.

Placed **after `company`**, which is where the company row is created, and before `financial`, whose holdback fields are the first thing posture makes irrelevant.

- [ ] **Step 1: Write the failing test** — the new step appears in order; `resumeAt` lands on it when posture is unset; submitting it loads the pack and sets `companies.work_posture`; the `done` summary names both the posture and the trade.
- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Add the step**, with `SETUP_STEPS` gaining:

```ts
  {
    slug: 'trade',
    title: 'Your work',
    summary: 'Service work, contract work, or both — and your trade.',
    // One step and not two: they are one decision to the person answering,
    // and posture has to be known before the pack loads because the pack's
    // rows are filtered by it.
    why: 'This decides which forms you get and what your rate book starts with.',
  },
```

- [ ] **Step 4: Run the full suite, typecheck, build.**
- [ ] **Step 5: Rebuild the image and walk the wizard end to end** on the demo stack, as an electrician: pick Service work + Electrical, then confirm the project-type picker offers no Custom home, the quote form no holdback field, `/templates/schedule` refuses, and `/vendors` does not append twelve GC trades.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: setup asks what kind of work you do, and starts your lists off"
```

---

## Self-review

**Spec coverage.** §1 one level plus a default → Task 1. §2 vocabulary → Task 1. §3 the question → Task 10. §3.1 where the answer lives → **changed: `companies`, not `organization`**, recorded at the head of this plan. §3.2 the switch back is not free → Task 1's backfill plus Task 3 (existing jobs keep their type's flags; only new work changes). §4 the five flags → Tasks 1, 7. §4.1 item 1 print notice → already fixed (`6891752`); Task 3's test guards against reintroduction. §4.1 item 2 `repository.ts:192,253` → Task 3. §4.2 the override UI → Task 4. §4.3 legality → the reasoning is in Task 1's schema comment. §4.4 no invented default → Task 3's third test. §5.1 trade gates nothing → Global Constraints, asserted in Task 9. §5.2 copy not link → Task 8. §5.3 no prices → Task 9, guard already built. §5.4 no MasterFormat → Task 9. §5.5 one pack, rows tagged → Tasks 1, 9. §5.6 four packs, GC authored, demo renumbered → Task 9. §5.7 what a pack contains → Task 9's test. §5.8 all three consequences → Task 8. §6.1 one derived reader → Task 2. §6.2 two routes → Task 6. §6.3 absence is off → Task 1. §7 every listed test → mapped above. §8 sequence → this plan runs second.

**Gap 1 — §4.3's payable-side holdback.** `holdback_direction = 'payable'` exists in the enum and nothing writes it. A service electrician who subs out drywall *is* a payer and must retain from the drywaller. The spec records it as a requirement on unwritten code and excludes it (§9), and this plan follows. It is the owner's real exposure and it stays recorded, not built.

**Gap 2 — the holdback release form.** Task 5 makes the kind reachable where the flag allows; the form that collects the figures is AP/AR. Flagged in Task 5's scope note so nobody reads the backlog entry as closed.

**Placeholders:** Tasks 4, 6, 7, 8, 9 and 10 state their tests in prose rather than full code. That is a deliberate and stated limit of this plan: Tasks 1, 2, 3 and 8 carry the load-bearing code because they are where a mistake is silent and expensive, and the remaining tasks are conventional against patterns already in the repo. An executor who wants the code written out first should say so rather than guess.

**Type consistency:** `WorkPosture` is `'both' | 'service' | 'contract'` everywhere, `'both'` first and default. `ProjectTypeFlags` has the same five keys in `defaults.ts`, `flags.ts` and the schema. `flagsFor(tx, projectTypeId)` takes a transaction in Tasks 3, 5 and 7. `loadPack(tx, trade)` consistent in Tasks 8 and 10.
