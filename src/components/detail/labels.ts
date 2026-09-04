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
