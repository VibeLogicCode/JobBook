/**
 * Apply the migrations to the TEST database as well as the development one.
 *
 * There are two databases, and every migration has to reach both. The README
 * said so in a footnote — "then repeat against TEST_DATABASE_URL" — and a
 * footnote is not a mechanism: migration 0016 went to `quote` and not to
 * `quote_test`, and the suite came back with eighteen failures whose message
 * was `column "trade_id" does not exist`. That reads like a broken migration
 * rather than a forgotten command, which is what makes it expensive.
 *
 * So `npm run db:migrate` now does both, and this script is the second half.
 * `drizzle.config.ts` reads `DATABASE_URL`, so the whole job is to run
 * drizzle-kit again with `TEST_DATABASE_URL` in that variable.
 *
 * Run `db:migrate:dev` if you deliberately want only the development database.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import 'dotenv/config';

const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl) {
  // Not an error. A deployment has one database and no test database, and
  // failing the migration there because a development variable is absent would
  // be a footgun of its own.
  console.log('TEST_DATABASE_URL is not set; skipping the test database.');
  process.exit(0);
}

if (testUrl === process.env.DATABASE_URL) {
  // The guard that matters. These suites truncate, so pointing them at the
  // development database would empty it — the failure `docs/superpowers/
  // FABLE-DECISIONS.md` records as the first thing that had to be fixed.
  console.error('TEST_DATABASE_URL and DATABASE_URL are the same database. Refusing.');
  process.exit(1);
}

const result = spawnSync('npx', ['drizzle-kit', 'migrate'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: testUrl },
});

process.exit(result.status ?? 1);
