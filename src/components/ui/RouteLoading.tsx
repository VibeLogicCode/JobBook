/**
 * The quiet "working on it" that fills a list route while it loads.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT A SKELETON
 * ---------------------------------------------------------------------------
 *
 * Grey rounded rectangles standing in for rows are a guess at a layout this
 * component cannot know; when the real page arrives shorter or taller the
 * screen jumps, and on a fast navigation the whole thing flashes. A quiet line
 * that says the truth costs nothing and lies about nothing.
 *
 * ---------------------------------------------------------------------------
 * THE DELAY IS THE DESIGN
 * ---------------------------------------------------------------------------
 *
 * Invisible for 400ms. Most navigations against a warm database finish inside
 * that, and an indicator that appears and vanishes in 150ms reads as the
 * interface twitching rather than working. Past 400ms the wait is real and
 * worth naming.
 *
 * `animation-delay` with `forwards`, not a timer in state: no client
 * component, no JavaScript, and it cannot outlive its own page.
 */
export function RouteLoading() {
  return (
    <div
      className="flex min-h-[40vh] items-center justify-center px-4 py-8 opacity-0 motion-reduce:opacity-100"
      style={{ animation: 'jb-appear 120ms ease-out 400ms forwards' }}
    >
      <p className="flex items-center gap-2 t-small text-subtle">
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
        />
        Loading…
      </p>
    </div>
  );
}
