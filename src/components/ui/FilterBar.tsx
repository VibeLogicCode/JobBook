import Link from 'next/link';
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
 * `hiddenCount` is not decoration, and it is not only wording. A list that
 * quietly drops finished records is a list the owner reads as having lost
 * them, so the bar has to say how many are behind the control before he has
 * any reason to press it -- and when the answer is NONE, the control is not
 * drawn at all. A reveal over nothing is a button whose only effect is to add
 * empty columns.
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

/**
 * Parameters the bar knows nothing about and must not lose.
 *
 * The bar is a plain `GET` form, and a `GET` form submits its own controls and
 * NOTHING ELSE -- so any parameter the screen owns but the bar does not render
 * is dropped the moment somebody presses Search. That is not theoretical: it is
 * exactly why the pipeline's view toggle was deleted rather than built the
 * first time round, on the grounds that the choice would silently reset itself
 * at the moment somebody was using it.
 *
 * `reveal` already had a private answer to this -- one hidden input for its own
 * name. `carry` is that answer generalised: name/value pairs rendered as hidden
 * inputs so the form posts them back, AND folded into every link the bar builds
 * so the reveal and Clear preserve them too. A screen states what it owns; the
 * bar carries it without knowing what it means.
 *
 * Empty values are omitted from both -- a hidden input carrying `''` puts
 * `&view=` on every search, and the default is better said by an absent
 * parameter than by a blank one.
 *
 * The keys must not collide with `q`, a select's name, or the reveal's name;
 * those are the bar's own and it sets them last.
 */
export type FilterCarry = Record<string, string | undefined>;

/**
 * The carried pairs the form actually posts, empties dropped.
 *
 * Pulled out of the markup so the round trip -- a screen carries `view=list`,
 * the form posts it, the page reads it back -- can be asserted without a DOM.
 * That round trip is the whole feature; a regex over the JSX would prove only
 * that an input exists.
 */
export function carriedFields(carry: FilterCarry | undefined): [string, string][] {
  return Object.entries(carry ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1]));
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
  carry,
  trailing,
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
  /** Parameters the screen owns and the bar must not drop. See `FilterCarry`. */
  carry?: FilterCarry;
  /**
   * A control that belongs WITH the count rather than above it -- the pipeline's
   * list/board toggle is the one today.
   *
   * It sits in the count line for the reason "Show lost and complete" and
   * "Clear" do: a full row of its own is a row the owner scrolls past before he
   * reaches his work, every time, on the screen he opens most.
   */
  trailing?: React.ReactNode;
  /** Rows the screen is about to draw. */
  shown: number;
  noun: { singular: string; plural: string };
}) {
  const filtered = q !== '' || selects.some((select) => select.value !== '');
  const current = selectFieldValues(selects);
  // Carried parameters are in every link the bar builds, not only in the form:
  // the reveal is a navigation, so a view or a sort left out here would survive
  // a search and die on "Show lost and complete".
  const carried: FilterCarry = carry ?? {};
  const revealHref = reveal
    ? filterHref(basePath, { q, ...current, ...carried, [reveal.name]: reveal.on ? '' : '1' })
    : undefined;
  // Clear drops the FILTERS. It does not drop what the screen carries -- a
  // person clearing a search has said nothing about which view he wants.
  const clearHref = filterHref(basePath, carried);

  /**
   * The reveal is drawn only when it would DO something.
   *
   * It used to render whenever a screen passed one, so on a board with nothing
   * lost or complete behind it, pressing "Show lost and complete" added two
   * empty grey columns and changed nothing else -- a control that answers a
   * question nobody can have asked, taking a full button's height at the top
   * of a phone screen. It stays visible while it is ON, because the way back
   * from a revealed list has to be where the way in was.
   */
  const revealShown = reveal !== undefined && (reveal.on || reveal.hiddenCount > 0);

  return (
    <div className="mb-3 flex flex-col gap-2">
      {/* A column on a phone; at `sm` and up ONE WRAPPING ROW again -- the
          select row below sets `sm:contents`, so its children stop being a
          block and become items of this row. `items-end` so a label above one
          control does not push its own input out of line with the box beside
          it. Two rows is what a phone needs and what a monitor wastes. */}
      <form
        method="get"
        action={basePath}
        className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3"
        role="search"
      >
        {/* The reveal is a link, not a checkbox, so it takes one press rather
            than a press and a submit. Its state still has to survive a search,
            which is what this carries. */}
        {reveal?.on ? <input type="hidden" name={reveal.name} value="1" /> : null}

        {/* Everything else the screen owns and the form does not render. A GET
            form posts its controls and nothing else, so without these a search
            silently resets the view toggle -- which is the whole reason the
            pipeline had no toggle to reset. */}
        {carriedFields(carried).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

        {/* The box and the button that works it, ON ONE ROW. Stacked, they
            cost a 48px input plus a 44px button plus two gaps before any work
            appeared, which is most of why the first card on this board sat 600
            pixels down an 844px phone. Capped at `sm` so the pair stays a
            control rather than becoming a 900px-wide slot with a button
            stranded at the far edge of a monitor. */}
        <div className="flex min-w-0 flex-col gap-1 sm:max-w-xl sm:flex-1 sm:basis-64">
          <label htmlFor="filter-q" className="t-small font-semibold">
            {searchLabel}
          </label>
          {/* No `items-center`: stretch is what makes the button take the
              input's height, which is 48px on a phone and 32px above it. */}
          <div className="flex min-w-0 gap-2">
            <input
              id="filter-q"
              name="q"
              type="search"
              defaultValue={q}
              placeholder={searchPlaceholder}
              // `min-h-11` on every control in this bar, not just this one.
              // `.field` floors at 32px above `sm`, so the search box was
              // taking 44px only because the Search button beside it stretched
              // the row, while the selects -- sitting in their own column with
              // nothing to stretch them -- rendered 34px and ten pixels lower.
              // Three controls, three heights, none of them aligned.
              className="field min-h-11 min-w-0 flex-1"
            />
            {/* `SubmitButton`, not `Button`: this form is a plain GET that the
                browser posts, so `useFormStatus` reports nothing for it and the
                search button was the one control in the product that could be
                pressed twice with nothing on screen to say why. */}
            <SubmitButton variant="primary" pendingLabel="Searching…">
              Search
            </SubmitButton>
          </div>
        </div>

        {/* Two selects sit SIDE BY SIDE on a phone, half width each, and each
            keeps its own label above it -- a select is unreadable without one,
            and a placeholder option standing in for a label disappears the
            moment somebody chooses something. A lone select takes the row, in
            a flex rather than a grid, because half a row of "Type" beside
            nothing looks like a control that failed to load. */}
        {selects.length > 0 ? (
          <div
            className={
              selects.length > 1
                ? 'grid grid-cols-2 gap-2 sm:contents'
                : 'flex gap-2 sm:contents'
            }
          >
            {selects.map((select) => (
              <div
                key={select.name}
                className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs sm:basis-44"
              >
                <label htmlFor={`filter-${select.name}`} className="t-small font-semibold">
                  {select.label}
                </label>
                <select
                  id={`filter-${select.name}`}
                  name={select.name}
                  defaultValue={select.value}
                  className="field min-h-11"
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
          </div>
        ) : null}
      </form>

      {/* The count, and the two controls that belong WITH it rather than above
          it. "Show lost and complete" and "Clear" are both statements about
          what this line is counting, so they read as one sentence with it and
          cost no extra row -- where as full-height secondary buttons they were
          the second of two control rows the owner has to scroll past to reach
          his work. They are links because each is a navigation to another URL,
          which is also why they sit outside the form. */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 t-small">
        {/* Announced, not merely drawn: the count is the answer to what the
            person just did, and it is the only thing on screen that says a
            filter removed anything. The live region is the TEXT alone -- with
            the links inside it, every filter change read the controls out
            too. */}
        <span role="status" aria-live="polite" className="min-w-0 text-muted">
          {shown} {shown === 1 ? noun.singular : noun.plural} shown
          {filtered ? ' · filtered' : ''}
          {reveal && !reveal.on && reveal.hiddenCount > 0
            ? ` · ${reveal.hiddenCount} ${reveal.hiddenNoun} hidden`
            : ''}
          {reveal?.on ? ` · including ${reveal.hiddenNoun}` : ''}
        </span>

        {revealShown || filtered || trailing ? (
          // `flex-wrap` and shrinkable, where this used to be `shrink-0`: with
          // a third control in it the group can exceed a 390px phone, and a
          // group that refuses to shrink does not wrap -- it pushes the page
          // sideways. Wrapping inside is the failure mode that costs a line
          // rather than an axis.
          <span className="no-print ml-auto flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            {trailing}
            {revealShown && revealHref ? (
              // `min-h-8` rather than the 44px a button gets: a text link in a
              // line of prose cannot be 44px tall without becoming the row it
              // was moved out of, so this is the deliberate trade -- still a
              // comfortable target, at a third of the height.
              <Link
                href={revealHref}
                className="inline-flex min-h-8 items-center text-accent-text hover:underline"
              >
                {reveal.on ? reveal.hideLabel : reveal.showLabel}
              </Link>
            ) : null}
            {filtered ? (
              <Link
                href={clearHref}
                className="inline-flex min-h-8 items-center text-accent-text hover:underline"
              >
                Clear
              </Link>
            ) : null}
          </span>
        ) : null}
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
