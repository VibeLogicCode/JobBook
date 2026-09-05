import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { Card } from '@/components/ui/Card';

/**
 * The search-and-filter bar every list screen puts above its table.
 *
 * Written once, for the reason the table wrapper was: three screens each need
 * a text box, a status dropdown, a way to reveal the records the default
 * hides, a count, and an empty state that says what was searched -- and held
 * apart, those five drift into three different answers to "does the filter
 * survive the back button".
 *
 * It is a plain `GET` form, so the state of the screen is the URL and nothing
 * else. That is not a stylistic choice:
 *
 * - The back button works, because each filter is a navigation.
 * - A filtered view can be sent to somebody, or bookmarked.
 * - The filtering happens in SQL on the server. Client-side array filtering
 *   is only correct while the whole list is in the browser, which stops being
 *   true the first time a list needs a page.
 * - It works with JavaScript still loading, which on a phone on a job site is
 *   most of the time.
 *
 * The empty option in every select carries a real word ("Any status"), never a
 * blank: a dropdown showing nothing reads as "not loaded yet".
 *
 * A `GET` form posts its empty controls too, so submitting an untouched bar
 * lands on `?q=&status=`. That is left alone deliberately -- the alternative
 * is a client component whose only job is to strip empty fields before
 * submit, and the pages read a blank parameter as absent anyway.
 */

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterOptionGroup {
  label: string;
  options: FilterOption[];
}

export interface FilterSelect {
  /** The URL parameter, and the control's name. */
  name: string;
  /** A real label, always rendered -- never a placeholder standing in for one. */
  label: string;
  value: string;
  /** The word on the empty option. It is a choice, not the absence of one. */
  anyLabel: string;
  options?: FilterOption[];
  /** Used instead of `options` when the members fall into named sets. */
  groups?: FilterOptionGroup[];
}

/**
 * The one control that reveals what the screen hides by default.
 *
 * `hiddenCount` is not decoration. A list that quietly drops finished records
 * is a list the owner reads as having lost them, so the bar has to say how
 * many are behind the control before he has any reason to press it.
 */
export interface FilterReveal {
  /** The URL parameter, set to `1` when everything is showing. */
  name: string;
  on: boolean;
  showLabel: string;
  hideLabel: string;
  hiddenCount: number;
  /** Names what is hidden, for the count line: "closed", "finished". */
  hiddenNoun: string;
}

/** A URL with the empty values dropped, so a shared link carries only what is set. */
export function filterHref(basePath: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function selectFieldValues(selects: FilterSelect[]): Record<string, string> {
  return Object.fromEntries(selects.map((select) => [select.name, select.value]));
}

export function FilterBar({
  basePath,
  q,
  searchLabel,
  searchPlaceholder,
  selects = [],
  reveal,
  shown,
  noun,
}: {
  basePath: string;
  q: string;
  /** Names what the box searches, in the owner's words -- not "Search". */
  searchLabel: string;
  searchPlaceholder?: string;
  selects?: FilterSelect[];
  reveal?: FilterReveal;
  /** Rows the screen is about to draw. */
  shown: number;
  noun: { singular: string; plural: string };
}) {
  const filtered = q !== '' || selects.some((select) => select.value !== '');
  const current = selectFieldValues(selects);
  const revealHref = reveal
    ? filterHref(basePath, { q, ...current, [reveal.name]: reveal.on ? '' : '1' })
    : undefined;

  return (
    <div className="mb-3 flex flex-col gap-2">
      <form
        method="get"
        action={basePath}
        // A column on a phone and a wrapping row above it: one DOM tree, and
        // `items-end` so a label above one control does not push its own
        // input out of line with the button beside it.
        className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
        role="search"
      >
        {/* The reveal is a link, not a checkbox, so it takes one press rather
            than a press and a submit. Its state still has to survive a search,
            which is what this carries. */}
        {reveal?.on ? <input type="hidden" name={reveal.name} value="1" /> : null}

        <div className="flex min-w-0 flex-col gap-1 sm:flex-1 sm:basis-64">
          <label htmlFor="filter-q" className="t-small font-semibold">
            {searchLabel}
          </label>
          <input
            id="filter-q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder={searchPlaceholder}
            className="field"
          />
        </div>

        {selects.map((select) => (
          <div key={select.name} className="flex min-w-0 flex-col gap-1 sm:flex-1 sm:basis-44">
            <label htmlFor={`filter-${select.name}`} className="t-small font-semibold">
              {select.label}
            </label>
            <select
              id={`filter-${select.name}`}
              name={select.name}
              defaultValue={select.value}
              className="field"
            >
              <option value="">{select.anyLabel}</option>
              {select.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {select.groups?.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          {/* `SubmitButton`, not `Button`: this form is a plain GET that the
              browser posts, so `useFormStatus` reports nothing for it and the
              search button was the one control in the product that could be
              pressed twice with nothing on screen to say why. */}
          <SubmitButton variant="primary" pendingLabel="Searching…">
            Search
          </SubmitButton>
          {reveal && revealHref ? (
            <Link href={revealHref} className={buttonClass('secondary')}>
              {reveal.on ? reveal.hideLabel : reveal.showLabel}
            </Link>
          ) : null}
          {filtered ? (
            <Link href={basePath} className={buttonClass('secondary')}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {/* Announced, not merely drawn: the count is the answer to what the
          person just did, and it is the only thing on screen that says a
          filter removed anything. */}
      <p role="status" aria-live="polite" className="t-small text-muted">
        {shown} {shown === 1 ? noun.singular : noun.plural} shown
        {filtered ? ' · filtered' : ''}
        {reveal && !reveal.on && reveal.hiddenCount > 0
          ? ` · ${reveal.hiddenCount} ${reveal.hiddenNoun} hidden`
          : ''}
        {reveal?.on ? ` · including ${reveal.hiddenNoun}` : ''}
      </p>
    </div>
  );
}

/**
 * What a screen shows when the filter matched nothing.
 *
 * A blank page reads as a broken query. This says what was asked for and
 * offers the way back, because the fastest recovery from a search that found
 * nothing is almost always to drop the search rather than to retype it.
 */
export function NoMatches({
  basePath,
  q,
  describe = [],
  noun,
  hint,
}: {
  basePath: string;
  q: string;
  /** The non-search filters in force, already worded: "Stage: Lead". */
  describe?: string[];
  noun: string;
  /** Said when the default hiding, rather than a typed filter, emptied the list. */
  hint?: React.ReactNode;
}) {
  return (
    <Card as="div" className="p-6 t-small text-muted">
      <p>
        No {noun} match
        {q ? (
          <>
            {' '}
            <span className="font-semibold text-ink">&ldquo;{q}&rdquo;</span>
          </>
        ) : (
          ' this filter'
        )}
        {describe.length > 0 ? ` (${describe.join(' · ')})` : ''}.
      </p>
      {hint ? <p className="mt-2">{hint}</p> : null}
      <p className="mt-3">
        <Link href={basePath} className="text-accent-text hover:underline">
          Clear the filter
        </Link>{' '}
        to see everything again.
      </p>
    </Card>
  );
}
