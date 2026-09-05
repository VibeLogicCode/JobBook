import { describe, expect, it } from 'vitest';
import { projectStageEnum } from '@/db/enums';
import {
  BAND_STAGES,
  BOARD_ORDER,
  CLOSED_STAGES,
  boardStages,
  formatWholeDollars,
  groupIntoColumns,
  nextReminderByProject,
  showsClosed,
  spellDate,
  spellDaysInStage,
  spellStarts,
  spellTiming,
  type Band,
  type BoardBand,
  type PipelineCard,
} from '@/components/pipeline/columns';
import type { ProjectStage } from '@/components/detail/labels';
import type { ReminderRow } from '@/lib/reminders/repository';

/**
 * The pipeline board's half that can be tested without a browser.
 *
 * The four things this screen can get wrong quietly:
 *
 * 1. A stage with no column. The board draws work by grouping it, so a stage
 *    that is not in the order is work that is on nobody's screen -- and it
 *    looks exactly like a stage nothing is sitting in.
 * 2. A card in the wrong BAND, or in only one when its stage lives in both.
 *    `on_hold` is a stalled bid on the left and a paused job on the right, and
 *    the whole reason the board split in two was to stop those sharing a
 *    column. A rule that put both in one band would look right on any screen
 *    where only one kind was parked.
 * 3. A column total that is not the sum of its cards, or is a float.
 * 4. The wrong reminder on a card, which is the failure that makes the owner
 *    stop trusting the reminder engine rather than the board.
 *
 * The layout itself is not tested here. `scripts/width-audit.mjs` is what
 * checks the page does not scroll sideways, because that is a question about
 * boxes in a browser and no assertion over markup answers it.
 */

const TODAY = '2026-09-04';

/** The unfiltered board, which is what most of these are about. */
const OPEN = { stage: '' as ProjectStage | '', kind: '' as Band | '', showClosed: false };

function card(overrides: Partial<PipelineCard> = {}): PipelineCard {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectNumber: 'P-0001',
    name: 'Basement refit',
    customerName: 'A customer',
    siteCity: null,
    stage: 'lead',
    isJob: false,
    contractValueCents: 0,
    daysInStage: 3,
    scheduledStart: null,
    actualStart: null,
    scheduledEnd: null,
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

/** The band with this name, or a failure that says which bands there were. */
function bandNamed(bands: BoardBand[], band: Band): BoardBand {
  const found = bands.find((entry) => entry.band === band);
  expect(bands.map((entry) => entry.band)).toContain(band);
  return found as BoardBand;
}

function stagesOf(bands: BoardBand[], band: Band): ProjectStage[] {
  return bandNamed(bands, band).columns.map((column) => column.stage);
}

function cardsAt(bands: BoardBand[], band: Band, stage: ProjectStage): PipelineCard[] {
  const column = bandNamed(bands, band).columns.find((entry) => entry.stage === stage);
  expect(stagesOf(bands, band)).toContain(stage);
  return column?.cards ?? [];
}

describe('the two bands the board is made of', () => {
  it('gives every stage the database can store a column, exactly once, in the order', () => {
    // The guard that matters. A stage added to the enum but to neither
    // OPPORTUNITY_STAGES nor JOB_STAGES falls out of the derived order, and
    // the rows sitting at it vanish from the pipeline with no error anywhere.
    expect([...BOARD_ORDER].sort()).toEqual([...projectStageEnum.enumValues].sort());
    expect(new Set(BOARD_ORDER).size).toBe(BOARD_ORDER.length);
  });

  it('covers every stage across the two bands, and repeats none inside one', () => {
    const across = new Set([...BAND_STAGES.opportunity, ...BAND_STAGES.job]);
    expect([...across].sort()).toEqual([...projectStageEnum.enumValues].sort());

    for (const band of ['opportunity', 'job'] as const) {
      expect(new Set(BAND_STAGES[band]).size).toBe(BAND_STAGES[band].length);
    }
  });

  it('puts on hold in BOTH bands, which is the point of having two', () => {
    // A stalled bid and a paused job are different things the enum spells the
    // same. Each band's "On hold" holds that band's parked work, beside the
    // columns it paused from -- which is the `on_hold` ambiguity this codebase
    // keeps explaining in prose, answered by layout instead.
    expect(BAND_STAGES.opportunity).toContain('on_hold');
    expect(BAND_STAGES.job).toContain('on_hold');
  });

  it('closes each band with its own finished stage, and won opens Jobs', () => {
    // Abandoning work under contract is not losing a bid.
    expect(BAND_STAGES.opportunity).toContain('lost');
    expect(BAND_STAGES.opportunity).not.toContain('complete');
    expect(BAND_STAGES.job).toContain('complete');
    expect(BAND_STAGES.job).not.toContain('lost');

    // `won` is the moment a job begins, so it belongs to delivery and to
    // nothing before it.
    expect(BAND_STAGES.job[0]).toBe('won');
    expect(BAND_STAGES.opportunity).not.toContain('won');
  });

  it('orders within a band the way a project lives it', () => {
    const at = (stage: ProjectStage) => BOARD_ORDER.indexOf(stage);
    expect(at('lead')).toBeLessThan(at('quote_sent'));
    expect(at('quote_sent')).toBeLessThan(at('won'));
    expect(at('won')).toBeLessThan(at('in_progress'));
    // A parked record is not further along than a running one.
    expect(at('in_progress')).toBeLessThan(at('on_hold'));
    // History last, and after the shared stages rather than among them.
    for (const closed of CLOSED_STAGES) {
      expect(at('on_hold')).toBeLessThan(at(closed));
    }
  });
});

describe('which columns a band draws', () => {
  it('draws only its own half', () => {
    expect(boardStages('opportunity', OPEN, [])).toEqual([
      'lead', 'site_visit', 'quoting', 'quote_sent', 'on_hold',
    ]);
    expect(boardStages('job', OPEN, [])).toEqual(['won', 'in_progress', 'on_hold']);
  });

  it('hides the finished stages until the screen is showing them', () => {
    expect(boardStages('opportunity', OPEN, [])).not.toContain('lost');
    expect(boardStages('job', OPEN, [])).not.toContain('complete');

    const revealed = { ...OPEN, showClosed: true };
    expect(boardStages('opportunity', revealed, [])).toContain('lost');
    expect(boardStages('job', revealed, [])).toContain('complete');
    // And still not the other band's, which the reveal has no bearing on.
    expect(boardStages('job', revealed, [])).not.toContain('lost');
  });

  it('empties the other band when a kind is chosen', () => {
    // A job cannot be at a quoting stage. An empty "Quoting" column on a board
    // filtered to jobs is not merely noise -- it says the stage is reachable.
    const jobs = { ...OPEN, kind: 'job' as const };
    expect(boardStages('job', jobs, [])).toEqual(['won', 'in_progress', 'on_hold']);
    expect(boardStages('opportunity', jobs, [])).toEqual([]);

    const opportunities = { ...OPEN, kind: 'opportunity' as const };
    expect(boardStages('job', opportunities, [])).toEqual([]);
    expect(boardStages('opportunity', opportunities, [])).toContain('quoting');
  });

  it('narrows to one column when a stage is chosen', () => {
    // On a phone the columns are stacked, so choosing a stage IS how the board
    // becomes a short list. Six empty headings above the one asked for would
    // defeat the point.
    expect(boardStages('opportunity', { ...OPEN, stage: 'quoting' }, [])).toEqual(['quoting']);
    expect(boardStages('job', { ...OPEN, stage: 'quoting' }, [])).toEqual([]);
    // Including a finished one, which is the case that would otherwise draw
    // nothing at all.
    expect(
      boardStages('opportunity', { ...OPEN, stage: 'lost', showClosed: true }, []),
    ).toEqual(['lost']);
  });

  it('leaves on hold in both bands when that is the stage chosen', () => {
    // The one stage a stage filter cannot reduce to a single column, because
    // the two columns are about different work.
    const parked = { ...OPEN, stage: 'on_hold' as ProjectStage };
    expect(boardStages('opportunity', parked, [])).toEqual(['on_hold']);
    expect(boardStages('job', parked, [])).toEqual(['on_hold']);
  });

  it('gives a column to any stage holding one of THAT BAND’s cards', () => {
    // The override, and the reason the function takes the occupied stages at
    // all. Band comes from whether an accepted quote exists and the column
    // comes from the stage, so voiding the accepted quote on a `won` row
    // leaves an OPPORTUNITY at a JOB stage. Without this the card would have
    // no column in either band and the row would silently leave the pipeline.
    expect(boardStages('opportunity', { ...OPEN, kind: 'opportunity' }, ['won'])).toContain('won');
    // And it is per band: the Jobs band does not sprout a column because an
    // OPPORTUNITY is sitting somewhere.
    expect(boardStages('job', OPEN, [])).not.toContain('quoting');
    // A finished stage that somehow held a card is still drawn, rather than
    // dropping it behind a control nobody pressed.
    expect(boardStages('job', OPEN, ['complete'])).toContain('complete');
  });
});

describe('splitting the board into bands', () => {
  it('bands a card by its accepted quote, never by its stage', () => {
    // `on_hold` in both bands, from one query, which is the case the single
    // grid could not draw at all: a stalled bid and a paused job shared one
    // column and the board said they were the same thing.
    const bands = groupIntoColumns(OPEN, [
      card({ id: 'stalled-bid', stage: 'on_hold', isJob: false }),
      card({ id: 'paused-job', stage: 'on_hold', isJob: true, contractValueCents: 500_00 }),
    ]);

    expect(cardsAt(bands, 'opportunity', 'on_hold').map((entry) => entry.id)).toEqual([
      'stalled-bid',
    ]);
    expect(cardsAt(bands, 'job', 'on_hold').map((entry) => entry.id)).toEqual(['paused-job']);
  });

  it('keeps an opportunity at a job stage in the Opportunities band', () => {
    // The override again, this time end to end: void the accepted quote on a
    // won row and it is an opportunity sitting at `won`. It draws a `Won`
    // column inside Opportunities rather than being quietly relabelled a job
    // or vanishing.
    const bands = groupIntoColumns(OPEN, [card({ id: 'unwon', stage: 'won', isJob: false })]);

    expect(cardsAt(bands, 'opportunity', 'won').map((entry) => entry.id)).toEqual(['unwon']);
    expect(cardsAt(bands, 'job', 'won')).toEqual([]);
    // In its place in the order, not appended to the end of the band.
    expect(stagesOf(bands, 'opportunity')).toEqual([
      'lead', 'site_visit', 'quoting', 'quote_sent', 'won', 'on_hold',
    ]);
  });

  it('drops a band with no columns rather than heading an empty half', () => {
    const bands = groupIntoColumns({ ...OPEN, kind: 'job' }, [
      card({ id: 'running', stage: 'in_progress', isJob: true }),
    ]);
    expect(bands.map((entry) => entry.band)).toEqual(['job']);
  });

  it('keeps a column with nothing in it', () => {
    // An empty column is the shape of the band and says the stage exists.
    // Dropping it here would make the board silently rearrange itself every
    // time a job moved.
    const bands = groupIntoColumns(OPEN, [card({ stage: 'lead' })]);
    expect(stagesOf(bands, 'opportunity')).toContain('quoting');
    expect(cardsAt(bands, 'opportunity', 'quoting')).toEqual([]);
  });

  it('adds up what has been won, per column and per band, in whole cents', () => {
    const bands = groupIntoColumns(OPEN, [
      card({ id: 'a', stage: 'in_progress', isJob: true, contractValueCents: 1_234_567 }),
      card({ id: 'b', stage: 'in_progress', isJob: true, contractValueCents: 89 }),
      card({ id: 'c', stage: 'won', isJob: true, contractValueCents: 0 }),
      // An opportunity carries none, and must not land in the jobs total.
      card({ id: 'd', stage: 'quoting', isJob: false, contractValueCents: 0 }),
    ]);

    const jobs = bandNamed(bands, 'job');
    expect(jobs.columns.find((column) => column.stage === 'in_progress')?.wonCents).toBe(1_234_656);
    expect(jobs.wonCents).toBe(1_234_656);
    expect(Number.isInteger(jobs.wonCents)).toBe(true);
    expect(jobs.count).toBe(3);

    // Opportunities are worth nothing by definition, not by a rule: value is
    // derived from an accepted quote, and an opportunity has none.
    expect(bandNamed(bands, 'opportunity').wonCents).toBe(0);
    expect(bandNamed(bands, 'opportunity').count).toBe(1);
  });

  it('counts every card it was given, so nothing is grouped into nowhere', () => {
    const cards = [
      card({ id: 'a', stage: 'lead' }),
      card({ id: 'b', stage: 'on_hold', isJob: true }),
      card({ id: 'c', stage: 'won', isJob: false }),
      card({ id: 'd', stage: 'in_progress', isJob: true }),
    ];
    const bands = groupIntoColumns(OPEN, cards);
    const placed = bands.flatMap((band) => band.columns.flatMap((column) => column.cards));

    expect(placed).toHaveLength(cards.length);
    expect(bands.reduce((total, band) => total + band.count, 0)).toBe(cards.length);
  });
});

describe('whether the screen is showing work that is over', () => {
  it('shows it when the reveal is on', () => {
    expect(showsClosed({ stage: '', closed: '1' })).toBe(true);
    expect(showsClosed({ stage: '', closed: '' })).toBe(false);
  });

  it('shows it when a finished stage is what was asked for', () => {
    // Otherwise choosing "Lost" returns an empty screen, which reads as a
    // filter that broke rather than one that was overruled.
    expect(showsClosed({ stage: 'lost', closed: '' })).toBe(true);
    expect(showsClosed({ stage: 'complete', closed: '' })).toBe(true);
    expect(showsClosed({ stage: 'lead', closed: '' })).toBe(false);
  });
});

describe('a column total, in whole dollars', () => {
  it('rounds to the dollar and never shows cents', () => {
    // Cards keep their cents; a heading does not need four more characters to
    // say the same thing.
    expect(formatWholeDollars(488_508_51)).toBe('$488,509');
    expect(formatWholeDollars(0)).toBe('$0');
    expect(formatWholeDollars(99)).toBe('$1');
  });

  it('takes its symbol from the currency, never a literal', () => {
    // The product is white-label; a deployment that bills in another currency
    // must not get a dollar sign glued to a euro figure.
    expect(formatWholeDollars(100_00, { locale: 'de-DE', currencyCode: 'EUR' })).toContain('€');
  });
});

describe('a date as somebody reads it in a truck', () => {
  it('says the month in words and drops the ISO padding', () => {
    expect(spellDate('2026-10-05', TODAY)).toBe('Oct 5');
    expect(spellDate('2026-09-01', TODAY)).toBe('Sep 1');
  });

  it('adds the year only when it is not this one', () => {
    // "Apr 12" beside a job starting this month is the one ambiguity dropping
    // the year introduces, and it is the one that costs a site visit.
    expect(spellDate('2027-11-14', TODAY)).toBe('Nov 14, 2027');
  });

  it('never moves the day, whatever the container thinks the timezone is', () => {
    // A bare `date` column read through a local-time Date is tomorrow from
    // early evening onwards in a UTC container, and yesterday west of it.
    expect(spellDate('2026-01-01', TODAY)).toBe('Jan 1');
    expect(spellDate('2026-12-31', TODAY)).toBe('Dec 31');
    expect(spellDate('2025-12-31', TODAY)).toBe('Dec 31, 2025');
  });

  it('says nothing rather than guessing at a missing or malformed date', () => {
    expect(spellDate(null, TODAY)).toBeNull();
    expect(spellDate('', TODAY)).toBeNull();
    expect(spellDate('2026-10-05T09:00:00Z', TODAY)).toBeNull();
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

describe('the one timing line on a card', () => {
  it('reports the stage age everywhere something is WAITING', () => {
    for (const stage of ['lead', 'site_visit', 'quoting', 'quote_sent', 'won', 'on_hold'] as const) {
      expect(spellTiming(card({ stage, daysInStage: 9 }), TODAY)).toBe('9 days in stage');
    }
  });

  it('reports the real dates on a job that is running', () => {
    // Nothing is waiting at `in_progress`. A crew has been on site eleven days
    // because the job takes eleven days, so "11 days in stage" reads as a
    // warning about work going exactly to plan.
    const running = card({
      stage: 'in_progress',
      isJob: true,
      daysInStage: 11,
      actualStart: '2026-09-01',
      scheduledEnd: '2026-11-14',
    });
    expect(spellTiming(running, TODAY)).toBe('Started Sep 1 · finish Nov 14');
  });

  it('says whichever of the two dates it has', () => {
    const base = { stage: 'in_progress' as const, isJob: true, daysInStage: 4 };
    expect(spellTiming(card({ ...base, actualStart: '2026-09-01' }), TODAY)).toBe('Started Sep 1');
    expect(spellTiming(card({ ...base, scheduledEnd: '2026-11-14' }), TODAY)).toBe('Finish Nov 14');
  });

  it('falls back to the stage age when a running job has no dates at all', () => {
    // Both dates are typed by hand on the detail screen and nothing forces
    // them. The stage age is then the only signal there is, and a blank line
    // would be worse than an imperfect one.
    expect(spellTiming(card({ stage: 'in_progress', isJob: true, daysInStage: 4 }), TODAY)).toBe(
      '4 days in stage',
    );
  });
});

describe('when the work begins', () => {
  it('prefers the actual start, then the scheduled one', () => {
    expect(spellStarts(card({ scheduledStart: '2026-10-05' }), TODAY)).toBe('Starts Oct 5');
    expect(
      spellStarts(card({ scheduledStart: '2026-10-05', actualStart: '2026-09-28' }), TODAY),
    ).toBe('Starts Sep 28');
  });

  it('says nothing on a running job, which has already said it', () => {
    // The timing line above carries the start date there, and the same date
    // twice on a card three lines tall is the repetition this screen was
    // trimmed to remove.
    const running = card({ stage: 'in_progress', isJob: true, actualStart: '2026-09-01' });
    expect(spellStarts(running, TODAY)).toBeNull();
  });

  it('says nothing when no date has been set', () => {
    expect(spellStarts(card(), TODAY)).toBeNull();
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
