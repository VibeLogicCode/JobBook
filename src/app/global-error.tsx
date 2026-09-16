'use client';

/**
 * The last boundary: a failure in the root layout itself.
 *
 * `error.tsx` renders INSIDE the layout, so it cannot catch the layout. When
 * the shell is what threw -- the organization read for the tab title, the
 * theme script, the navigation -- React unmounts everything and renders this,
 * which must therefore supply its own `<html>` and `<body>`.
 *
 * No shell, no Tailwind class that might not have compiled, no import beyond
 * React: this is the screen that has to work when the assumption that anything
 * else works has already failed. Inline styles, both themes, one action.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#f5f5fa',
          color: '#16162b',
          font: "400 15px/22px 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <main style={{ maxWidth: '34rem', width: '100%' }}>
          <h1
            style={{
              font: "600 21px/28px 'IBM Plex Serif', Georgia, serif",
              letterSpacing: '-0.01em',
              margin: '0 0 8px',
            }}
          >
            JobBook could not start this page
          </h1>
          <p style={{ margin: '0 0 12px', color: '#5a5a72' }}>
            The application itself failed to load, not just the screen you asked for. Nothing was
            saved and nothing was changed.
          </p>
          <p style={{ margin: '0 0 20px', color: '#5a5a72' }}>
            Reload first. If it happens again, the server log holds the detail
            {error.digest ? ` under reference ${error.digest}` : ''}.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 44,
              padding: '0 20px',
              border: 0,
              borderRadius: 8,
              background: '#4b49d6',
              color: '#fff',
              font: '600 15px/1 inherit',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
