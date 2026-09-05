import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { carriedFields, filterHref } from '@/components/ui/FilterBar';
import { groupIntoBands, type PipelineCard } from '@/components/pipeline/columns';
import {
  DEFAULT_VIEW, PIPELINE_VIEWS, pipelineHref, readView, viewParam,
} from '@/components/pipeline/view';

/**
 * The pipeline has two views of one query, and the failure this file exists to
 * catch is the one that got the first attempt cancelled.
 *
 * The filter bar is a plain GET form. A GET form posts its own controls and
 * NOTHING ELSE, so a `?view=` the bar does not render is dropped the instant
 * somebody presses Search -- and a toggle that resets itself in the middle of
 * being used is worse than no toggle, which is exactly why the table was
 * deleted rather than hidden behind one. `carry` is the answer, and the tests
 * below walk the whole round trip: a screen states what it owns, the bar turns
 * it into hidden fields, the browser posts them, the page reads them back.
 *
 * The other half is that the two views must not be two answers. Bands here come
 * from `bandOf` -- an accepted, active quote exists -- exactly as the board's
 * do, and the totals are summed in integer cents by the same helper. A row that
 * is a job on the board is a job in the list, or these fail.
 *
 * Layout is not tested here. `scripts/width-audit.mjs` is what proves neither
 * view pushes the page sideways, because that is a question about boxes in a
 * browser.
 */

const FILTER_BAR = path.resolve(import.meta.dirname, '../../src/components/ui/FilterBar.tsx');

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

/**
 * What the browser posts when Search is pressed.
 *
 * A GET form submits its named controls: the search box, every select, and
 * every hidden input. Nothing else reaches the server -- which is the whole
 * point, and the reason this is modelled rather than assumed.
 */
function submitSearch(bar: {
  q: string;
  selects: Record<string, string>;
  revealOn?: { name: string };
  carry?: Record<string, string | undefined>;
}): URLSearchParams {
  const posted = new URLSearchParams();
  posted.set('q', bar.q);
  for (const [name, value] of Object.entries(bar.selects)) posted.set(name, value);
  if (bar.revealOn) posted.set(bar.revealOn.name, '1');
  for (const [name, value] of carriedFields(bar.carry)) posted.set(name, value);
  return posted;
}

/* -------------------------------------------------------------------------
   Reading the parameter
   ------------------------------------------------------------------------- */

describe('readView', () => {
  it('defaults to the board', () => {
    // Every link into this screen from the rest of the app is a bare
    // `/projects`. A default that moved would silently re-answer all of them.
    expect(DEFAULT_VIEW).toBe('board');
    expect(readView(undefined)).toBe('board');
    expect(readView('')).toBe('board');
    expect(readView('board')).toBe('board');
  });

  it('reads the list, and treats anything else as the default', () => {
    expect(readView('list')).toBe('list');
    // A typed URL is not an error page. `?view=table` shows the board.
    expect(readView('table')).toBe('board');
    expect(readView('LIST')).toBe('board');
  });

  it('offers both views, and only the two', () => {
    expect(PIPELINE_VIEWS.map((entry) => entry.view)).toEqual(['board', 'list']);
    // Every one carries a word. The toggle never says which is on by colour.
    expect(PIPELINE_VIEWS.every((entry) => entry.label.length > 0)).toBe(true);
  });

  it('spells the default as an absent parameter', () => {
    expect(viewParam('board')).toBe('');
    expect(viewParam('list')).toBe('list');
  });
});

/* -------------------------------------------------------------------------
   The toggle's own links
   ------------------------------------------------------------------------- */

describe('pipelineHref', () => {
  const filters = { q: 'kitchen', stage: 'quoting', kind: 'opportunity', closed: '1' };

  it('keeps every filter when the view changes', () => {
    // Switching view is a change of RENDERING. A toggle that dropped the search
    // is a toggle nobody presses twice.
    const href = pipelineHref('/projects', filters, 'list');
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('q')).toBe('kitchen');
    expect(params.get('stage')).toBe('quoting');
    expect(params.get('kind')).toBe('opportunity');
    expect(params.get('closed')).toBe('1');
    expect(params.get('view')).toBe('list');
  });

  it('says nothing about the view when the view is the default', () => {
    const href = pipelineHref('/projects', filters, 'board');
    expect(new URLSearchParams(href.split('?')[1]).has('view')).toBe(false);
  });

  it('leaves the plain address plain', () => {
    // `/projects` and not `/projects?q=&stage=&kind=&closed=&view=board`.
    expect(pipelineHref('/projects', { q: '', stage: '', kind: '', closed: '' }, 'board')).toBe(
      '/projects',
    );
    expect(pipelineHref('/projects', { q: '', stage: '', kind: '', closed: '' }, 'list')).toBe(
      '/projects?view=list',
    );
  });
});

/* -------------------------------------------------------------------------
   The carry mechanism, and the failure it was built to prevent
   ------------------------------------------------------------------------- */

describe('FilterBar carry', () => {
  it('posts the carried parameter through a search', () => {
    // THE EXACT FAILURE the first attempt predicted: somebody in the list view
    // types a search, presses Search, and lands back on the board.
    const posted = submitSearch({
      q: 'kitchen',
      selects: { kind: '', stage: '' },
      carry: { view: 'list' },
    });
    expect(readView(posted.get('view') ?? undefined)).toBe('list');
    expect(posted.get('q')).toBe('kitchen');
  });

  it('posts it through a stage filter and through the reveal being on', () => {
    const posted = submitSearch({
      q: '',
      selects: { kind: 'job', stage: 'in_progress' },
      revealOn: { name: 'closed' },
      carry: { view: 'list' },
    });
    expect(readView(posted.get('view') ?? undefined)).toBe('list');
    expect(posted.get('stage')).toBe('in_progress');
    expect(posted.get('kind')).toBe('job');
    expect(posted.get('closed')).toBe('1');
  });

  it('drops the empty value rather than posting a blank', () => {
    // `&view=` on every search of the default view is a parameter that looks
    // like a decision. `readView` would still answer correctly, which is why
    // this has to be asserted rather than noticed.
    expect(carriedFields({ view: '' })).toEqual([]);
    expect(carriedFields({ view: undefined })).toEqual([]);
    expect(carriedFields(undefined)).toEqual([]);
    expect(carriedFields({ view: 'list' })).toEqual([['view', 'list']]);
  });

  it('carries several parameters, none of which it understands', () => {
    // The bar is not to grow a `view` prop. The next screen that needs a sort
    // order or a page number gets it for free.
    expect(carriedFields({ view: 'list', sort: 'value', page: '' })).toEqual([
      ['view', 'list'],
      ['sort', 'value'],
    ]);
  });

  it('changes nothing for a screen that carries nothing', () => {
    // Five other screens share this bar. Clear used to be `href={basePath}`
    // and now goes through `filterHref`, which has to produce the same string.
    for (const basePath of ['/quotes', '/customers', '/vendors', '/expenses', '/reminders']) {
      expect(filterHref(basePath, {})).toBe(basePath);
      expect(filterHref(basePath, { view: undefined })).toBe(basePath);
    }
  });

  it('folds the carried parameters into the links the bar builds', async () => {
    // The reveal and Clear are navigations, not submissions, so the hidden
    // inputs do not reach them. A view that survived a search and died on
    // "Show lost and complete" would be the same bug with a longer fuse.
    const source = await readFile(FILTER_BAR, 'utf8');
    expect(source).toMatch(/revealHref[\s\S]{0,200}\.\.\.carried/);
    expect(source).toMatch(/clearHref = filterHref\(basePath, carried\)/);
    // And the form really renders them, from the same function tested above.
    expect(source).toContain('carriedFields(carried).map');
    // Clear must not have been left pointing at the bare path. `NoMatches`
    // still does, and correctly: the page hands IT a basePath that already
    // carries the view, so the recovery link out of an empty result stays in
    // the view the person was looking at.
    expect(source).toMatch(/href=\{clearHref\}[\s\S]{0,200}>\s*Clear\s*<\/Link>/);
  });
});

/* -------------------------------------------------------------------------
   One query, two renderings
   ------------------------------------------------------------------------- */

describe('groupIntoBands', () => {
  it('splits on the accepted quote and never on the stage', () => {
    // `on_hold` is a stalled bid on one side and a paused job on the other.
    // Reading the stage would put both in one band, which is the mistake the
    // board split in two to avoid -- and the list must make it the same way.
    const bands = groupIntoBands([
      card({ id: 'a', stage: 'on_hold', isJob: false }),
      card({ id: 'b', stage: 'on_hold', isJob: true, contractValueCents: 100_00 }),
    ]);
    expect(bands.map((band) => band.band)).toEqual(['opportunity', 'job']);
    expect(bands[0].cards.map((entry) => entry.id)).toEqual(['a']);
    expect(bands[1].cards.map((entry) => entry.id)).toEqual(['b']);
  });

  it('keeps a job at an opportunity stage in the Jobs band', () => {
    // Void the accepted quote on a `won` row and it is an opportunity at a job
    // stage; do the reverse and a job sits at `quoting`. Rare, reachable, and
    // the row must not vanish from either view.
    const bands = groupIntoBands([card({ id: 'a', stage: 'quoting', isJob: true })]);
    expect(bands.map((band) => band.band)).toEqual(['job']);
    expect(bands[0].cards.map((entry) => entry.id)).toEqual(['a']);
  });

  it('leaves the rows in the order the query returned them', () => {
    // A list's whole advantage is one order, and the query's order is project
    // number. Re-sorting here would make the list disagree with itself between
    // the two bands.
    const bands = groupIntoBands([
      card({ id: 'c', projectNumber: 'P-0003' }),
      card({ id: 'a', projectNumber: 'P-0001' }),
      card({ id: 'b', projectNumber: 'P-0002' }),
    ]);
    expect(bands[0].cards.map((entry) => entry.projectNumber)).toEqual([
      'P-0003',
      'P-0001',
      'P-0002',
    ]);
  });

  it('drops a band with no rows rather than drawing an empty heading', () => {
    // The board keeps its empty columns above `sm` because the empty column is
    // the SHAPE of the board. A table has no shape to preserve.
    const bands = groupIntoBands([card({ isJob: true, contractValueCents: 1 })]);
    expect(bands.map((band) => band.band)).toEqual(['job']);
    expect(groupIntoBands([])).toEqual([]);
  });

  it('totals in integer cents, and the total is the sum of the rows', () => {
    const bands = groupIntoBands([
      card({ id: 'a', isJob: true, contractValueCents: 1_234_57 }),
      card({ id: 'b', isJob: true, contractValueCents: 8_765_44 }),
      card({ id: 'c', isJob: false, contractValueCents: 0 }),
    ]);
    const jobs = bands.find((band) => band.band === 'job');
    expect(jobs?.wonCents).toBe(1_234_57 + 8_765_44);
    expect(Number.isInteger(jobs?.wonCents)).toBe(true);
    expect(jobs?.count).toBe(2);
    // Opportunities carry no won value by definition, not by a rule.
    expect(bands.find((band) => band.band === 'opportunity')?.wonCents).toBe(0);
  });

  it('adds a cent to a cent without going through a fraction', () => {
    // The failure a float would produce is 0.1 + 0.2; in cents it cannot
    // happen, and this is the assertion that says so out loud.
    const bands = groupIntoBands([
      card({ id: 'a', isJob: true, contractValueCents: 10 }),
      card({ id: 'b', isJob: true, contractValueCents: 20 }),
    ]);
    expect(bands[0].wonCents).toBe(30);
  });
});
