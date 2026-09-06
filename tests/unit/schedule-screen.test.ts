import { describe, expect, it } from 'vitest';
import {
  STATUS_LABELS,
  dayFormatter,
  durationLabel,
  editTaskFields,
  moveFields,
  newTaskFields,
  statusTone,
  waitsOnLabel,
} from '@/app/projects/[id]/schedule/schema';

/**
 * What the schedule screen says, and what it refuses to accept.
 *
 * The sentences are here rather than only on screen because each of them is a
 * boundary somebody gets wrong by writing the obvious version: "0 days after
 * Framing", "1 days", "-2 days after". None of those is readable on a phone in
 * a driveway, and none of them shows up in a screenshot of the one row that
 * happened to be on screen.
 */

describe('what a task waits on, in words', () => {
  it('calls lag zero the day after, not zero days after', () => {
    expect(waitsOnLabel('Framing', 0)).toBe('The day after Framing');
  });

  it('agrees with the singular', () => {
    expect(waitsOnLabel('Framing', 1)).toBe('1 day after Framing');
    expect(waitsOnLabel('Framing', 2)).toBe('2 days after Framing');
  });

  it('reads an overlap as an overlap rather than a negative number', () => {
    // A task starting the same day its predecessor ends is lag -1, and a task
    // starting the day before that is lag -2. "-2 days after framing" is a
    // sentence nobody parses.
    expect(waitsOnLabel('Framing', -1)).toBe('Starts the day Framing ends');
    expect(waitsOnLabel('Framing', -2)).toBe('Overlaps Framing by 1 day');
    expect(waitsOnLabel('Framing', -4)).toBe('Overlaps Framing by 3 days');
  });
});

describe('how long a task takes', () => {
  it('counts both end days', () => {
    expect(durationLabel('2026-03-06', '2026-03-06')).toBe('1 day');
    expect(durationLabel('2026-03-06', '2026-03-10')).toBe('5 days');
  });
});

describe('status', () => {
  it('gives every state a word as well as a tone', () => {
    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      expect(label).not.toBe('');
      expect(statusTone(status as keyof typeof STATUS_LABELS)).toBeTruthy();
    }
  });

  it('does not paint an unstarted task as a problem', () => {
    expect(statusTone('not_started')).toBe('neutral');
    expect(statusTone('blocked')).toBe('negative');
    expect(statusTone('complete')).toBe('positive');
  });
});

describe('dates on screen', () => {
  it('renders a date-only value as the day it is, not the day before', () => {
    // The failure this guards: formatting an ISO date in a zone west of UTC
    // prints the previous day, which on a schedule is the difference between
    // Friday and the weekend somebody was told they had.
    expect(dayFormatter('en-CA')('2026-03-06')).toContain('2026');
    expect(dayFormatter('en-CA')('2026-03-06')).toContain('6');
    expect(dayFormatter('en-CA')('2026-01-01')).toContain('1');
    expect(dayFormatter('en-CA')('2026-01-01')).toContain('2026');
  });
});

/* -------------------------------------------------------------------------
   What the forms refuse
   ------------------------------------------------------------------------- */

const newTask = {
  name: 'Framing',
  tradeId: '',
  costCodeId: '',
  predecessorTaskId: '',
  notes: '',
  plannedStart: '2026-03-02',
  plannedEnd: '2026-03-06',
};

describe('adding a task', () => {
  it('refuses a finish before its own start', () => {
    const parsed = newTaskFields.safeParse({ ...newTask, plannedEnd: '2026-03-01' });
    expect(parsed.success).toBe(false);
  });

  it('collapses a milestone onto a single day rather than refusing it', () => {
    const parsed = newTaskFields.safeParse({ ...newTask, isMilestone: 'on' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.plannedEnd).toBe('2026-03-02');
  });

  it('treats a missing checkbox as unticked, which is what a browser sends', () => {
    const parsed = newTaskFields.safeParse(newTask);
    expect(parsed.success && parsed.data.isMilestone).toBe(false);
  });

  it('refuses a date that is not a real day', () => {
    expect(newTaskFields.safeParse({ ...newTask, plannedStart: '2026-02-31' }).success).toBe(false);
  });
});

const editTask = {
  id: '3f6b4a2c-2f1e-4c8a-9b2d-5c1e7a9f0d31',
  name: 'Framing',
  tradeId: '',
  costCodeId: '',
  predecessorTaskId: '',
  notes: '',
  status: 'in_progress',
  actualStart: '',
  actualEnd: '',
};

describe('editing a task', () => {
  it('carries no planned dates at all', () => {
    // The whole reason the move is a separate action: a planned date that could
    // be changed here would be a date changed without the preview.
    const parsed = editTaskFields.safeParse({ ...editTask, plannedStart: '2026-03-02' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'plannedStart' in parsed.data).toBe(false);
  });

  it('refuses a finish with no start behind it', () => {
    expect(editTaskFields.safeParse({ ...editTask, actualEnd: '2026-03-06' }).success).toBe(false);
  });

  it('refuses an actual finish before its own actual start', () => {
    const parsed = editTaskFields.safeParse({
      ...editTask,
      actualStart: '2026-03-06',
      actualEnd: '2026-03-02',
    });
    expect(parsed.success).toBe(false);
  });

  it('keeps blank as NULL rather than the empty string', () => {
    const parsed = editTaskFields.safeParse(editTask);
    expect(parsed.success && parsed.data.actualStart).toBeNull();
    expect(parsed.success && parsed.data.tradeId).toBeNull();
  });
});

describe('the move request', () => {
  it('accepts an empty fingerprint, which is the request for a preview', () => {
    const parsed = moveFields.safeParse({
      id: '3f6b4a2c-2f1e-4c8a-9b2d-5c1e7a9f0d31',
      plannedStart: '2026-03-02',
      plannedEnd: '2026-03-06',
      fingerprint: '',
      previewedStart: '',
      previewedEnd: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a finish before its own start before anything is computed', () => {
    const parsed = moveFields.safeParse({
      id: '3f6b4a2c-2f1e-4c8a-9b2d-5c1e7a9f0d31',
      plannedStart: '2026-03-06',
      plannedEnd: '2026-03-02',
      fingerprint: '',
      previewedStart: '',
      previewedEnd: '',
    });
    expect(parsed.success).toBe(false);
  });
});
