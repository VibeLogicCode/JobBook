/**
 * The page a deployment shows when its database does not answer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Every request passes through `proxy.ts`, which resolves who is asking before
 * any route renders. Resolving that reads the `users` table. So when Postgres
 * is down the proxy's catch-all fired and the whole application answered every
 * request with the words `Not authorised`, status 401, as bare text.
 *
 * That is the wrong sentence for the commonest failure a self-hosted box has.
 * A NAS reboots, a container does not come back, a volume is not mounted yet --
 * and the owner, who has no IT support, reads that he lacks permission to use
 * his own quoting system. He goes looking for a permissions problem that does
 * not exist. The setup wizard already has the right words for exactly this
 * state, and the proxy short-circuits long before any of them can render.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HTML IS INLINE HERE
 * ---------------------------------------------------------------------------
 *
 * Because a database outage is the one moment the application cannot be
 * trusted to render anything. A React error page is a route, a route is a
 * render, and a render on this codebase reads the organization row for the tab
 * title and the accent colour. A page that needs the database in order to
 * explain that the database is missing would fail in the same breath.
 *
 * So this is a string: no imports, no data access, no stylesheet request. It
 * carries its own colours, in both themes, and it works if every other part of
 * the deployment is broken.
 *
 * 503 and not 401: the service is unavailable, the visitor is not unwelcome.
 * `Retry-After` is what tells a probe, a phone browser and Cloudflare alike
 * that this is temporary.
 */

/** Neither the message nor the detail is ever shown; both are for the log. */
export function outagePage(detail: string): Response {
  return new Response(OUTAGE_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': '15',
      // Nothing about this page should ever be cached: the next request may
      // well be the one that works.
      'cache-control': 'no-store',
      // Kept out of the body on purpose -- a connection string or a host name
      // in a page is a page somebody screenshots into a support chat.
      'x-outage-detail': detail.slice(0, 200).replace(/[^\x20-\x7e]/g, ' '),
    },
  });
}

/**
 * Deliberately plain, and deliberately not branded.
 *
 * The owner is looking at this because something is broken; a logo would be
 * the least useful thing on the screen. What he needs is the name of the
 * problem, the fact that nothing is lost, and the two things worth checking
 * before he calls anybody.
 *
 * The palette is the app's own light and dark values, hard-coded because there
 * is no stylesheet to load them from. They are the only duplicated colours in
 * the product besides the print document, for the same reason: this file
 * cannot depend on anything that might itself be down.
 */
const OUTAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The database is not answering</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #f5f5fa;
    color: #16162b;
    font: 400 15px/22px 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  main {
    max-width: 34rem;
    width: 100%;
    background: #ffffff;
    border-radius: 12px;
    padding: 28px;
    box-shadow: 0 1px 2px rgb(22 22 43 / 0.04), 0 12px 28px -18px rgb(22 22 43 / 0.28);
  }
  h1 { font: 600 21px/28px 'IBM Plex Serif', Georgia, serif; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { margin: 0 0 12px; color: #5a5a72; max-width: 60ch; }
  ul { margin: 0 0 20px; padding-left: 20px; color: #5a5a72; }
  li { margin-bottom: 6px; }
  strong { color: #16162b; font-weight: 600; }
  button {
    min-height: 44px;
    padding: 0 20px;
    border: 0;
    border-radius: 8px;
    background: #4b49d6;
    color: #fff;
    font: 600 15px/1 inherit;
    font-family: inherit;
    cursor: pointer;
  }
  button:hover { background: #3f3dbf; }
  button:focus-visible { outline: 2px solid #4b49d6; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0e0f17; color: #ededf5; }
    main { background: #171826; box-shadow: none; border: 1px solid #2a2c40; }
    p, ul { color: #a9adc4; }
    strong { color: #ededf5; }
    button { background: #5d59e8; }
    button:hover { background: #6f6bf2; }
  }
</style>
</head>
<body>
  <main>
    <h1>The database is not answering</h1>
    <p>
      This is not a problem with your account or your password, and
      <strong>nothing has been lost</strong>. The application is running; the
      database it stores your quotes in did not respond, so it cannot sign you
      in or show you anything.
    </p>
    <p>Two things are worth checking, in this order:</p>
    <ul>
      <li>Is the machine that runs it switched on and finished starting up? After a power cut it can take a couple of minutes.</li>
      <li>Is the database container running? On the NAS, Container Manager should show both it and the application as started.</li>
    </ul>
    <p>
      If both look right, wait a minute and try again — a database that is still
      opening its files refuses connections until it is ready.
    </p>
    <button type="button" onclick="location.reload()">Try again</button>
  </main>
</body>
</html>`;
