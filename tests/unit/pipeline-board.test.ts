import { describe, expect, it } from 'vitest';
import { projectStageEnum } from '@/db/enums';
import {
  BOARD_ORDER,
  CLOSED_STAGES,
  boardStages,
  groupIntoColumns,
  nextReminderByProject,
  spellDaysInStage,
  type PipelineCard,
} from '@/components/pipeline/columns';
import type { ProjectStage } from '@/components/detail/labels';
import type { ReminderRow } from '@/lib/reminders/repository';

/**
 * The pipeline board's half that can be tested without a browser.
 *
 * The three things this screen can get wrong quietly:
 *
 * 1. A stage with no column. The board draws work by grouping it, so a stage
 *    that is not in the order is work that is on nobody's screen -- and it
 *    looks exactly like a stage nothing is sitting in.
 * 2. A column total that is not the sum of its cards, or is a float.
 * 3. The wrong reminder on a card, which is the failure that makes the owner
 *    stop trusting the reminder engine rather than the board.
 *
 * The layout itself is not tested here. `scripts/width-audit.mjs` is what
 * checks the page does not scroll sideways, because that is a question about
 * boxes in a browser and no assertion over markup answers it.
 */

function card(overrides: Partial<PipelineCard> = {}): PipelineCard {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectNumber: 'P-0001',
    name: 'Basement refit',
    customerName: 'A customer',
    stage: 'lead',
    isJob: false,
    contractValueCents: 0,
    daysInStage: 3,
    startsOn: null,
    ...overrides,
  };
}

function reminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    entityType: 'project',
    entityId: '00000000-0000-4000-8000-000000000001',
    title: 'Follow up',
    detail: null,
    kind: 'follow_up',
    status: 'open',
    dueOn: '2026-09-04',
    snoozedUntil: null,
    assignedTo: null,
    generatedByRuleId: null,
    ...overrides,
  };
}

describe('the columns the board draws', () => {
  it('gives every stage the database can store a column, exactly once', () => {
    // The guard that matters. A stage added to the enum but to neither
    // OPPORTUNITY_STAGES nor JOB_STAGES falls out of the derived order, and
    // the rows sitting at it vanish from the pipeline with no error anywhere.
    expect([...BOARD_ORDER].sort()).toEqual([...projectStageEnum.enumValues].sort());
    expect(new Set(BOARD_ORDER).size).toBe(BOARD_ORDER.length);
  });

  it('puts won between the two halves, and what is over at the end', () => {
    const at = (stage: ProjectStage) => BOARD_ORDER.indexOf(stage);
    // `won` is the hinge: everything before it is a bid, everything after it
    // is work under contract.
    expect(at('quote_sent')).toBeLessThan(at('won'));
    expect(at('won')).toBeLessThan(at('in_progress'));
    // A parked record is not further along than a running one.
    expect(at('in_progress')).toBeLessThan(at('on_hold'));
    // History last, and after the shared stages rather than among them.
    for (const closed of CLOSED_STAGES) {
      expect(at('on_hold')).toBeLessThan(at(closed));
    }
  });

  it('hides the finished stages until the screen is showing them', () => {
    const shown = boardStages({ stage: '', kind: '', showClosed: false }, []);
    expect(shown).not.toContain('lost');
    expect(shown).not.toContain('complete');
    expect(boardStages({ stage: '', kind: '', showClosed: true }, [])).toEqual(BOARD_ORDER);
  });

  it('narrows to one column when a stage is chosen', () => {
    // On a phone the columns are stacked, so choosing a stage IS how the board
    // becomes a short list. Six empty headings above the one asked for would
    // defeat the point.
    expect(boardStages({ stage: 'quoting', kind: '', showClosed: false }, [])).toEqual(['quoting']);
    // Including a finished one, which is the case that would otherwise draw
    // nothing at all.
    expect(boardStages({ stage: 'lost', kind: '', showClosed: true }, [])).toEqual(['lost']);
  });

  it('draws only the half being filtered to', () => {
    // A job cannot be at a quoting stage. An empty "Quoting" column on a board
    // filtered to jobs is not merely noise -- it says the stage is reachable.
    const jobs = boardStages({ stage: '', kind: 'job', showClosed: false }, []);
    expect(jobs).toEqual(['won', 'in_progress', 'on_hold']);

    const opportunities = boardStages({ stage: '', kind: 'opportunity', showClosed: false }, []);
    expect(opportunities).not.toContain('won');
    expect(opportunities).not.toContain('in_progress');
    expect(opportunities).toContain('quoting');
  });

  it('still shows the finished column of the half, once revealed', () => {
    expect(boardStages({ stage: '', kind: 'job', showClosed: true }, [])).toContain('complete');
    expect(boardStages({ stage: '', kind: 'job', showClosed: true }, [])).not.toContain('lost');
    expect(boardStages({ stage: '', kind: 'opportunity', showClosed: true }, [])).toContain('lost');
  });

  it('gives a column to any stage that actually holds a card', () => {
    // The override, and the reason the function takes the result set at all.
    // Kind comes from whether an accepted quote exists and the column comes
    // from the stage, so voiding the accepted quote on a `won` row leaves an
    // OPPORTUNITY at a JOB stage. Without this the card would have no column
    // and the row would silently leave the pipeline.
    const shown = boardStages({ stage: '', kind: 'opportunity', showClosed: false }, ['won']);
    expect(shown).toContain('won');
    // And a finished stage that somehow held a card would still be drawn,
    // rather than dropping it behind a control that was never pressed.
    expect(
      boardStages({ stage: '', kind: '', showClosed: false }, ['complete']),
    ).toContain('complete');
  });
});

describe('grouping work into its columns', () => {
  it('keeps a column with nothing in it', () => {
    // An empty column is the shape of the board and says the stage exists.
    // Dropping it here would make the board silently rearrange itself every
    // time a job moved.
    const columns = groupIntoColumns(['lead', 'quoting'], [card({ stage: 'lead' })]);
    expect(columns.map((column) => column.stage)).toEqual(['lead', 'quoting']);
    expect(columns[1].cards).toEqual([]);
    expect(columns[1].wonCents).toBe(0);
  });

  it('adds up what has been won in each column, in whole cents', () => {
    const columns = groupIntoColumns(
      ['in_progress'],
      [
        card({ id: 'a', stage: 'in_progress', contractValueCents: 1_234_567 }),
        card({ id: 'b', stage: 'in_progress', contractValueCents: 89 }),
        card({ id: 'c', stage: 'in_progress', contractValueCents: 0 }),
      ],
    );
    expect(columns[0].wonCents).toBe(1_234_656);
    expect(Number.isInteger(columns[0].wonCents)).toBe(true);
  });

  it('leaves out a card whose stage is not being drawn', () => {
    // Which is what the closed-record rule relies on: `lost` rows are excluded
    // by the query, and if one arrived anyway it must not silently land in
    // somebody else's column.
    const columns = groupIntoColumns(['lead'], [card({ stage: 'complete' })]);
    expect(columns[0].cards).toEqual([]);
  });
});

describe('how long it has been here', () => {
  it('says under a day rather than zero days', () => {
    // "0 days in stage" reads as a missing value. This is also the wording the
    // stage timeline on the detail screen uses, deliberately.
    expect(spellDaysInStage(0)).toBe('Under a day in stage');
  });

  it('counts one day singular and the rest plural', () => {
    expect(spellDaysInStage(1)).toBe('1 day in stage');
    expect(spellDaysInStage(12)).toBe('12 days in stage');
  });

  it('says so rather than guessing when there is no history', () => {
    expect(spellDaysInStage(null)).toBe('No stage history');
  });
});

describe('the next reminder on a card', () => {
  const projectA = '00000000-0000-4000-8000-00000000000a';
  const projectB = '00000000-0000-4000-8000-00000000000b';
  const quoteOfA = '00000000-0000-4000-8000-0000000000c1';
  const owners = new Map([[quoteOfA, projectA]]);

  it('counts a reminder written against the project', () => {
    const found = nextReminderByProject([reminder({ entityType: 'project', entityId: projectA })], owners);
    expect(found.get(projectA)?.entityId).toBe(projectA);
  });

  it('counts a reminder written against one of the project quotes', () => {
    // The rule that fires most on this screen -- "follow up on quote to
    // {customer}" -- is written against the QUOTE. A board that only read
    // project reminders would show nothing at `quote_sent`, which is the
    // column the owner opens this screen to read.
    const found = nextReminderByProject(
      [reminder({ id: 'r1', entityType: 'quote', entityId: quoteOfA, title: 'Follow up on quote' })],
      owners,
    );
    expect(found.get(projectA)?.title).toBe('Follow up on quote');
  });

  it('leaves a customer reminder off the card', () => {
    // A customer with three jobs would otherwise put the same line on three
    // cards, and a reminder repeated three times is one the owner stops
    // reading.
    const found = nextReminderByProject(
      [reminder({ entityType: 'customer', entityId: projectA })],
      owners,
    );
    expect(found.size).toBe(0);
  });

  it('takes the first, because the list arrives earliest-due first', () => {
    const found = nextReminderByProject(
      [
        reminder({ id: 'r1', entityId: projectA, dueOn: '2026-08-01', title: 'The late one' }),
        reminder({ id: 'r2', entityId: projectA, dueOn: '2026-09-30', title: 'The later one' }),
      ],
      owners,
    );
    expect(found.get(projectA)?.title).toBe('The late one');
  });

  it('ignores a quote it cannot place, rather than dropping it on a card', () => {
    const found = nextReminderByProject(
      [reminder({ entityType: 'quote', entityId: 'a-quote-not-on-this-screen' })],
      owners,
    );
    expect(found.size).toBe(0);
  });

  it('gives each project its own', () => {
    const found = nextReminderByProject(
      [
        reminder({ id: 'r1', entityId: projectA, title: 'For A' }),
        reminder({ id: 'r2', entityId: projectB, title: 'For B' }),
      ],
      owners,
    );
    expect(found.get(projectA)?.title).toBe('For A');
    expect(found.get(projectB)?.title).toBe('For B');
  });
});
