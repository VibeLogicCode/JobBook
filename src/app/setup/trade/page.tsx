import { saveTradeStep } from '@/app/setup/actions';
import { requireOpenSetup } from '@/app/setup/guard';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, SelectField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { StepPanel } from '@/components/setup/StepPanel';
import { TRADE_LABELS, TRADE_SUMMARIES, TRADES } from '@/db/seed/packs/types';
import { POSTURE_LABELS, POSTURE_SUMMARIES, POSTURES } from '@/lib/posture/types';

export const dynamic = 'force-dynamic';

/**
 * Step 3. What kind of work, and which trade.
 *
 * ---------------------------------------------------------------------------
 * TWO QUESTIONS, ONE STEP
 * ---------------------------------------------------------------------------
 *
 * They are one decision to the person answering -- "what kind of outfit is
 * this" -- and they have to be answered together because a pack's rows are
 * tagged by posture: the pack cannot be filtered until the posture exists.
 * Split across two screens they could also be answered inconsistently, with a
 * service-only company loading a pack whose contract half it will never see.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WORDS ARE "SERVICE" AND "CONTRACT" AND NOT "BUILDER"
 * ---------------------------------------------------------------------------
 *
 * The owner asked for the second and then asked the better question himself:
 * *"can this app not be used for other services like electrician plumber? i
 * dont want to call it a builder."* Naming the trade would make the product
 * narrower than it is -- an electrician, a plumber and a home builder all have
 * the same split inside their own business, and they already call it a service
 * department and a construction department.
 *
 * Both fields default to the answer that changes least: `both` offers every
 * form, and the trade is asked with no pre-selection because there is no
 * sensible guess.
 */
export default async function TradeSetupStep() {
  const gate = await requireOpenSetup('trade');

  return (
    <StepPanel slug="trade" gate={gate}>
      <ActionForm action={saveTradeStep} submitLabel="Save and load my lists">
        <div className="flex flex-col gap-4">
          <Notice tone="info" title="Both of these are changeable afterwards">
            <p>
              The kind of work decides which fields your job forms carry — holdback, progress
              draws, schedules. Pick <span className="font-semibold">Both</span> if you are
              unsure; it shows everything, and you can narrow it later once you see which half
              you never use.
            </p>
            <p className="mt-2">
              The trade only decides what your lists <em>start</em> with. Nothing behaves
              differently afterwards, and every row it loads is yours to rename, reorder or
              retire.
            </p>
          </Notice>

          <FieldGrid>
            <SelectField
              name="workPosture"
              label="What kind of work do you do?"
              idPrefix="setup-trade"
              required
              defaultValue="both"
              options={POSTURES.map((posture) => ({
                value: posture,
                label: `${POSTURE_LABELS[posture]} — ${POSTURE_SUMMARIES[posture]}`,
              }))}
              wide
              hint="Service work is dispatched and billed once. Contract work is signed, scheduled and billed in draws."
            />

            <SelectField
              name="trade"
              label="Your trade"
              idPrefix="setup-trade"
              required
              // No default: there is no sensible guess at a stranger's trade,
              // and `blankLabel` makes the empty option say so rather than
              // being a silent first row.
              defaultValue=""
              blankLabel="Choose a trade"
              options={TRADES.map((trade) => ({
                value: trade,
                label: `${TRADE_LABELS[trade]} — ${TRADE_SUMMARIES[trade]}`,
              }))}
              wide
              hint="Loads job types, cost codes and a rate-book skeleton to start from."
            />
          </FieldGrid>

          <Notice tone="warning" title="The rate book arrives with no prices in it">
            <p>
              Deliberately. A rate book of numbers this software guessed looks authoritative,
              and quoting at a guessed price loses you the job or loses you money — with
              nothing to trace it back to.
            </p>
            <p className="mt-2">
              So you get the codes, the descriptions and the units, and you put your own prices
              on them. Until you do, the app refuses to put an unpriced line on a quote, so an
              item you have not got to yet cannot reach a customer.
            </p>
          </Notice>
        </div>
      </ActionForm>
    </StepPanel>
  );
}
