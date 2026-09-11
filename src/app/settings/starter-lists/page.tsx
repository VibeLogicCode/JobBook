import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import { addStarterLists } from '@/app/settings/starter-lists/actions';
import { ActionForm } from '@/components/settings/ActionForm';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { loadedPack } from '@/db/seed/packs/marker';
import { PACKS } from '@/db/seed/packs/registry';
import { TRADE_LABELS, TRADE_SUMMARIES, TRADES, type Trade } from '@/db/seed/packs/types';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read this but not add lists.';

/** What a pack would bring, counted for the card. Pure: no database. */
function contents(trade: Trade): { label: string; count: number }[] {
  const pack = PACKS[trade];
  return [
    { label: 'job types', count: pack.projectTypes.length },
    { label: 'cost codes', count: pack.costCodes.length },
    { label: 'rate items', count: pack.rateItems.length },
    { label: 'quote templates', count: pack.scopeTemplates.length },
    { label: 'line groups', count: pack.lineGroups.length },
    { label: 'subcontractor trades', count: pack.trades.length },
    { label: 'saved exclusions and assumptions', count: pack.clauses.length },
  ].filter((row) => row.count > 0);
}

/**
 * Adding another trade's starter lists after setup.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 *
 * The owner asked: *"can i not change trade after initialization?"* He could
 * not. The trade question was asked once, by a wizard that closes itself
 * permanently, so somebody who picked "start empty" in his first five minutes
 * -- or who has since added a second trade to the business -- had no route to
 * those lists ever again.
 *
 * It was left out on purpose, and half that reason was right: loading a pack
 * over a rate book somebody has priced from for a year must never retire his
 * job types or rewrite their paperwork rules. `addStarterPack` is the half
 * that does neither. Every row it writes is an insert that skips what is
 * already there.
 *
 * ---------------------------------------------------------------------------
 * IT SAYS WHAT IT WILL DO BEFORE IT IS PRESSED
 * ---------------------------------------------------------------------------
 *
 * The counts are on the card, and the sentence under them is the same sentence
 * the action returns. Somebody with no IT support pressing a button labelled
 * "Load" on a screen full of his own prices deserves to know exactly what
 * changes -- and the honest answer here is "rows appear, nothing you have is
 * touched", which is short enough to print next to the button.
 */
export default async function StarterListsPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const already = await loadedPack();

  // `none` is not offered. It is the wizard's way of saying "ask me nothing",
  // and a button labelled "add the plain start" to somebody who already has
  // lists is a button with no meaning.
  const offered = TRADES.filter((trade) => trade !== 'none');

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Starter lists"
        description={
          <p>
            The job types, cost codes, rate book skeleton, quote templates and standard exclusions
            for a trade. Add another one whenever the work changes.
          </p>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <Notice tone="info" title="Adding lists never changes or removes anything you have">
          <p>
            Every row arrives only if you do not already have one under the same code or name, so
            your own prices, job types and headings are untouched. Nothing is retired and no
            existing quote changes.
          </p>
          <p className="mt-2">
            The rate items arrive <span className="font-semibold">with no prices</span>, the same
            as at setup — a price this software guessed would lose you the job or lose you money.
            A quote cannot be sent while a line on it has no price, so an item you have not got to
            yet cannot reach a customer.
          </p>
        </Notice>

        {already ? (
          <p className="mt-3 t-small text-subtle">
            Most recently loaded: <span className="font-semibold">{TRADE_LABELS[already]}</span>.
            Loading it again is safe and adds nothing back that you have since retired.
          </p>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {offered.map((trade) => (
            <div key={trade} className="flex flex-col gap-2 rounded border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="t-heading">{TRADE_LABELS[trade]}</h3>
                {already === trade ? <Pill tone="neutral">Loaded</Pill> : null}
              </div>
              <p className="t-small text-subtle">{TRADE_SUMMARIES[trade]}</p>

              <ul className="grid gap-0.5 t-small">
                {contents(trade).map((row) => (
                  <li key={row.label}>
                    <span className="num font-semibold">{row.count}</span> {row.label}
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-1">
                <ActionForm
                  action={addStarterLists}
                  submitLabel={`Add the ${TRADE_LABELS[trade].toLowerCase()} lists`}
                  disabled={!allowed}
                  disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
                >
                  <input type="hidden" name="trade" value={trade} />
                </ActionForm>
              </div>
            </div>
          ))}
        </div>

        <Notice tone="warning" title="What this does not do" className="mt-4">
          <p>
            It will not retire the job types a trade does not use — at setup that happens
            automatically, but by now jobs may be filed under them. Retire the ones you do not
            want yourself under <span className="font-semibold">Lists → Job types</span>, one at a
            time, where you can see what you are doing.
          </p>
        </Notice>
      </Section>
    </div>
  );
}
