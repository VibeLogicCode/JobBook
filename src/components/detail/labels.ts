import type {
  contractTypeEnum, customerTypeEnum, leadSourceEnum, projectStageEnum, projectTypeEnum,
} from '@/db/enums';
import type { Tone } from '@/components/ui/Pill';

/**
 * Enum values to the words a person reads.
 *
 * The database stores `commercial_ti` because SharePoint mirrors these as text
 * and a renamed member would break every sync; a screen still has to say
 * "Commercial tenant improvement". Mapped here, once, rather than
 * `replace('_', ' ')` at each call site -- that only ever fixes the first
 * underscore, which is why `time_and_material` read as "time and_material".
 */

type CustomerType = (typeof customerTypeEnum.enumValues)[number];
type LeadSource = (typeof leadSourceEnum.enumValues)[number];
type ProjectType = (typeof projectTypeEnum.enumValues)[number];
type ContractType = (typeof contractTypeEnum.enumValues)[number];
export type ProjectStage = (typeof projectStageEnum.enumValues)[number];

export const CUSTOMER_TYPES: Record<CustomerType, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
};

export const LEAD_SOURCES: Record<LeadSource, string> = {
  call: 'Phone call',
  email: 'Email',
  referral: 'Referral',
  website: 'Website',
  repeat: 'Repeat customer',
  other: 'Other',
};

export const PROJECT_TYPES: Record<ProjectType, string> = {
  custom_home: 'Custom home',
  basement: 'Basement',
  renovation: 'Renovation',
  kitchen: 'Kitchen',
  bathroom: 'Bathroom',
  addition: 'Addition',
  commercial_ti: 'Commercial tenant improvement',
  water_leak: 'Water damage',
  other: 'Other',
};

export const CONTRACT_TYPES: Record<ContractType, string> = {
  lump_sum: 'Lump sum',
  unit_price: 'Unit price',
  cost_plus: 'Cost plus',
  time_and_material: 'Time and material',
};

export const PROJECT_STAGES: Record<ProjectStage, string> = {
  lead: 'Lead',
  site_visit: 'Site visit',
  quoting: 'Quoting',
  quote_sent: 'Quote sent',
  won: 'Won',
  lost: 'Lost',
  in_progress: 'In progress',
  complete: 'Complete',
  on_hold: 'On hold',
};

/**
 * A stage a job can leave, versus one it has finished in.
 *
 * A customer record cannot be voided while any of its jobs is still live, but a
 * job that is complete or lost is history: if those blocked the void too, a
 * customer who bought one basement in 2019 could never be closed out.
 */
/**
 * Which stages a record may be in, decided by whether it has been won.
 *
 * A job cannot be at `quoting`, and an opportunity cannot be `in_progress`:
 * they are stages of two different halves of one life, and offering all nine
 * in one dropdown invites a won job back to "quote sent", which would leave a
 * job with an accepted quote sitting in a pre-sale stage and its stage history
 * saying it un-won itself.
 *
 * `won` is deliberately absent from BOTH lists. It is not a stage anybody
 * types -- it is what accepting a quote does. A job does not exist until a
 * quote on it is won, so a dropdown that can set `won` can manufacture a job
 * with no accepted quote and therefore no contract value, no lines and nothing
 * to invoice against. It stays visible as the current stage when the record is
 * already there; it is just never a destination.
 *
 * `lost` belongs only to an opportunity. Abandoning work already under
 * contract is not the same event as losing a bid, and folding them together
 * makes the win rate a number nobody can trust.
 */
export const OPPORTUNITY_STAGES: ProjectStage[] = [
  'lead', 'site_visit', 'quoting', 'quote_sent', 'lost', 'on_hold',
];

export const JOB_STAGES: ProjectStage[] = ['in_progress', 'complete', 'on_hold'];

/**
 * The stages this record may MOVE to, plus wherever it already is.
 *
 * The current stage is always included even when it is not a legal
 * destination -- otherwise a record sitting at `won` renders a dropdown whose
 * displayed value is not among its options, and the browser silently shows
 * the first one instead, so the control lies about the current state before
 * anybody touches it.
 */
export function stagesOpenTo(
  hasAcceptedQuote: boolean,
  current: ProjectStage,
): ProjectStage[] {
  const allowed = hasAcceptedQuote ? JOB_STAGES : OPPORTUNITY_STAGES;
  return allowed.includes(current) ? allowed : [current, ...allowed];
}

/**
 * Opportunity or job -- the same row, named for where it is in its life.
 *
 * Derived from whether an accepted quote exists, NOT from the stage. Stage
 * cannot answer it: `on_hold` is a stalled opportunity before anything is won
 * and a paused job afterwards, and `lost` is an opportunity that never became
 * one. Acceptance is also the exact event the owner means by "convert" -- a
 * quote is won, and from that moment there is a job to buy materials against.
 */
export function workNoun(hasAcceptedQuote: boolean): 'Job' | 'Opportunity' {
  return hasAcceptedQuote ? 'Job' : 'Opportunity';
}

export const FINISHED_STAGES: ProjectStage[] = ['complete', 'lost'];

export function isLiveStage(stage: ProjectStage): boolean {
  return !FINISHED_STAGES.includes(stage);
}

/** Stage to chip tone. Every chip carries its word as well, never colour alone. */
export function stageTone(stage: ProjectStage): Tone {
  switch (stage) {
    case 'complete':
    case 'won':
      return 'positive';
    case 'lost':
      return 'negative';
    case 'on_hold':
      return 'warning';
    case 'in_progress':
      return 'accent';
    default:
      return 'neutral';
  }
}
