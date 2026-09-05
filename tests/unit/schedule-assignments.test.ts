import { describe, expect, it } from 'vitest';
import {
  RESPONSE_LABELS,
  assigneeValue,
  centsToInput,
  clashPillLabel,
  clashSentence,
  editAssignmentFields,
  momentFormatter,
  newAssignmentFields,
  overlapDays,
  parseAssignee,
  removeAssignmentFields,
  responseOf,
  responseTone,
  spansOverlap,
  type Clash,
} from '@/app/projects/[id]/schedule/schema';

/**
 * What an assignment accepts, and what the screen says about one.
 *
 * The boundaries here are the ones that are invisible on a screenshot of a
 * schedule that happens to look right: a blank amount that becomes zero, a
 * one-day task reported as clashing with nothing, a confirmation rendered a day
 * late because a UTC container turned Toronto's evening into tomorrow.
 */

const VENDOR = '11111111-2222-4333-8444-555555555555';
const PERSON = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
const TASK = '99999999-8888-4777-a666-555555555555';

/* -------------------------------------------------------------------------
   Who
   ------------------------------------------------------------------------- */

describe('the assignee a form submits', () => {
  it('round-trips a vendor and a person through the one control', () => {
    expect(parseAssignee(assigneeValue('vendor', VENDOR))).toEqual({
      kind: 'vendor',
      id: VENDOR,
    });
    expect(parseAssignee(assigneeValue('user', PERSON))).toEqual({ kind: 'user', id: PERSON });
  });

  it('refuses anything that is not one of the two tables', () => {
    // The prefix names a TABLE, and a value naming no table is not a person
    // this product can look up -- which is the whole reason "me" is a user id
    // rather than a word.
    expect(parseAssignee(`customer:${VENDOR}`)).toBeNull();
    expect(parseAssignee('me')).toBeNull();
    expect(parseAssignee('')).toBeNull();
    expect(parseAssignee(VENDOR)).toBeNull();
    expect(parseAssignee('vendor:not-a-uuid')).toBeNull();
  });

  it('is refused by the form parser with a sentence rather than a crash', () => {
    const parsed = newAssignmentFields.safeParse({
      scheduleTaskId: TASK,
      assignee: 'me',
      agreedAmount: '',
      notes: '',
    });
    expect(parsed.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Money
   ------------------------------------------------------------------------- */

describe('the agreed amount', () => {
  const parse = (agreedAmount: string) =>
    newAssignmentFields.safeParse({
      scheduleTaskId: TASK,
      assignee: assigneeValue('vendor', VENDOR),
      agreedAmount,
      notes: '',
    });

  it('keeps blank as nothing agreed, which is not zero', () => {
    // The whole reason the column is nullable. Zero would report a sub lined up
    // for nothing, and a job costing view would believe it.
    const parsed = parse('');
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.agreedAmount).toBeNull();
  });

  it('still lets somebody agree zero, which is a different fact', () => {
    const parsed = parse('0');
    expect(parsed.success && parsed.data.agreedAmount).toBe(0);
  });

  it('lands on exact cents rather than a float', () => {
    expect(parse('4962.00').success && parse('4962.00').data!.agreedAmount).toBe(496200);
    expect(parse('$1,234.50').success && parse('$1,234.50').data!.agreedAmount).toBe(123450);
    expect(parse('12').success && parse('12').data!.agreedAmount).toBe(1200);
  });

  it('refuses three decimal places rather than rounding them away', () => {
    // Nothing agreed with a sub has three decimals, so it is a typo or a
    // quantity typed into a money box. Turning 12.345 into 12.35 quietly is how
    // a figure stops matching what was said on the phone.
    expect(parse('12.345').success).toBe(false);
  });

  it('refuses a negative, because a credit is an expense and not a price', () => {
    expect(parse('-500.00').success).toBe(false);
    expect(parse('(500.00)').success).toBe(false);
  });

  it('refuses a figure that is a misplaced decimal point', () => {
    expect(parse('99999999.99').success).toBe(false);
  });
});

describe('cents back into the box', () => {
  it('is string surgery, so the round trip never touches a float', () => {
    expect(centsToInput(0)).toBe('0.00');
    expect(centsToInput(5)).toBe('0.05');
    expect(centsToInput(496200)).toBe('4962.00');
    expect(centsToInput(123450)).toBe('1234.50');
  });

  it('produces exactly what the parser reads back', () => {
    for (const cents of [0, 1, 99, 100, 123450, 999999999]) {
      const parsed = newAssignmentFields.safeParse({
        scheduleTaskId: TASK,
        assignee: assigneeValue('vendor', VENDOR),
        agreedAmount: centsToInput(cents),
        notes: '',
      });
      expect(parsed.success && parsed.data.agreedAmount).toBe(cents);
    }
  });

  it('never groups thousands, because the parser is not promised a locale', () => {
    // fr-CA groups with a narrow no-break space, which parseAmountToCents does
    // not strip. Opening the sheet and pressing Save must not refuse a figure
    // nobody touched.
    expect(centsToInput(123456789)).toBe('1234567.89');
  });
});

/* -------------------------------------------------------------------------
   Two dates, not one status
   ------------------------------------------------------------------------- */

describe('what was heard back', () => {
  it('tells silence apart from a no', () => {
    expect(responseOf({ confirmedAt: null, declinedAt: null })).toBe('waiting');
    expect(responseOf({ confirmedAt: null, declinedAt: new Date() })).toBe('declined');
    expect(responseOf({ confirmedAt: new Date(), declinedAt: null })).toBe('confirmed');
  });

  it('does not paint an unanswered ask as a problem', () => {
    expect(responseTone('waiting')).toBe('neutral');
    expect(responseTone('confirmed')).toBe('positive');
    expect(responseTone('declined')).toBe('negative');
  });

  it('gives every state a word as well as a colour', () => {
    for (const label of Object.values(RESPONSE_LABELS)) expect(label).not.toBe('');
  });

  it('accepts only the three the dates can express', () => {
    const base = { id: TASK, agreedAmount: '', notes: '' };
    expect(editAssignmentFields.safeParse({ ...base, response: 'waiting' }).success).toBe(true);
    expect(editAssignmentFields.safeParse({ ...base, response: 'maybe' }).success).toBe(false);
  });
});

describe('taking somebody off', () => {
  it('needs a reason, because the row is the only record they were ever on', () => {
    expect(removeAssignmentFields.safeParse({ id: TASK, reason: '' }).success).toBe(false);
    expect(removeAssignmentFields.safeParse({ id: TASK, reason: '   ' }).success).toBe(false);
    expect(
      removeAssignmentFields.safeParse({ id: TASK, reason: 'Pulled onto the other job' }).success,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   Double-booking
   ------------------------------------------------------------------------- */

describe('whether two tasks share a day', () => {
  it('counts both ends, so a one-day task is a real day', () => {
    // planned_start and planned_end are inclusive. A half-open comparison would
    // report every milestone as clashing with nothing at all.
    const milestone = { start: '2026-03-10', end: '2026-03-10' };
    expect(spansOverlap(milestone, { start: '2026-03-06', end: '2026-03-10' })).toBe(true);
    expect(overlapDays(milestone, { start: '2026-03-06', end: '2026-03-10' })).toBe(1);
    expect(spansOverlap(milestone, milestone)).toBe(true);
  });

  it('does not report a clash between tasks that merely touch end to end', () => {
    expect(
      spansOverlap({ start: '2026-03-02', end: '2026-03-06' }, { start: '2026-03-07', end: '2026-03-10' }),
    ).toBe(false);
    expect(
      overlapDays({ start: '2026-03-02', end: '2026-03-06' }, { start: '2026-03-07', end: '2026-03-10' }),
    ).toBe(0);
  });

  it('counts the shared stretch, whichever way round they are', () => {
    const a = { start: '2026-03-02', end: '2026-03-10' };
    const b = { start: '2026-03-09', end: '2026-03-20' };
    expect(overlapDays(a, b)).toBe(2);
    expect(overlapDays(b, a)).toBe(2);
  });

  it('handles one task wholly inside another', () => {
    expect(
      overlapDays({ start: '2026-03-01', end: '2026-03-31' }, { start: '2026-03-10', end: '2026-03-12' }),
    ).toBe(3);
  });
});

describe('what a double-booking says', () => {
  const HERE = 'p-here';
  const clash = (over: Partial<Clash> = {}): Clash => ({
    taskName: 'Framing',
    projectId: 'p-other',
    projectNumber: 'P-2026-004',
    projectName: 'Second job',
    span: { start: '2026-03-09', end: '2026-03-20' },
    days: 2,
    ...over,
  });

  it('says nothing when there is nothing to say', () => {
    expect(clashSentence('Somebody', [], HERE)).toBe('');
  });

  it('names the other job, because that task is on another screen', () => {
    const said = clashSentence('Somebody', [clash()], HERE);
    expect(said).toContain('P-2026-004');
    expect(said).toContain('Framing');
    expect(said).toContain('2 days');
    expect(said).toContain("another job's screen");
  });

  it('does not claim another screen when the clash is on this job', () => {
    // The reader can see both rows here. Telling them otherwise is how a
    // warning stops being believed on the day it matters.
    const said = clashSentence('Somebody', [clash({ projectId: HERE })], HERE);
    expect(said).not.toContain("another job's screen");
    expect(said).toContain('on this job');
  });

  it('says it is allowed, because it is a warning and never a refusal', () => {
    // The decision this whole helper carries. These dates have no hours in
    // them, so the data cannot tell a split day from a genuine clash, and
    // refusing on that evidence would refuse correct schedules.
    expect(clashSentence('Somebody', [clash()], HERE)).toContain('allowed');
  });

  it('agrees with the singular on a one-day overlap', () => {
    expect(clashSentence('Somebody', [clash({ days: 1 })], HERE)).toContain('1 day');
  });

  it('summarises rather than listing when there are several', () => {
    const said = clashSentence('Somebody', [clash(), clash({ taskName: 'Drywall' })], HERE);
    expect(said).toContain('2 other tasks');
  });

  it('keeps the pill short enough to sit on a row', () => {
    expect(clashPillLabel([clash()], HERE)).toBe('Also on P-2026-004');
    expect(clashPillLabel([clash(), clash()], HERE)).toBe('Also on 2 other tasks');
  });

  it('names the task rather than this job, when the clash is on this job', () => {
    expect(clashPillLabel([clash({ projectId: HERE })], HERE)).toBe('Also on Framing');
  });
});

/* -------------------------------------------------------------------------
   The tenant's day
   ------------------------------------------------------------------------- */

describe('when somebody confirmed', () => {
  it('reads in the tenant zone rather than the server one', () => {
    // Seven in the evening in Toronto is already the next day in UTC. Rendering
    // the server's day would tell the owner a sub confirmed tomorrow.
    const at = new Date('2026-03-11T00:30:00Z');
    expect(momentFormatter('en-CA', 'America/Toronto')(at)).toContain('10');
    expect(momentFormatter('en-CA', 'UTC')(at)).toContain('11');
  });

  it('falls back rather than taking the schedule down on a bad zone', () => {
    // The zone comes off the organization row, and an unreadable one must not
    // be the reason nobody can see who is on site.
    const at = new Date('2026-03-11T00:30:00Z');
    expect(momentFormatter('en-CA', 'Not/AZone')(at)).toContain('11');
  });
});
