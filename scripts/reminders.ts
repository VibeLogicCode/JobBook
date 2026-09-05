/**
 * One pass of the reminder scheduler.
 *
 * Run by `docker/reminder-loop.sh` in its own container, hourly. Run by hand
 * on a development machine with:
 *
 *   npx tsx --env-file=.env scripts/reminders.ts
 *
 * ONE PASS, and the process exits. The loop lives in the shell script, so a
 * run that leaks a connection or wedges on a lock cannot accumulate across the
 * day -- each hour gets a fresh process, and a crash costs one evaluation
 * rather than every evaluation until somebody notices.
 *
 * Running it twice in a row must create nothing the second time. That is the
 * property the whole design turns on, and it is asserted in
 * `tests/integration/reminders.test.ts` rather than assumed here.
 */
import { closeDb } from '@/db/client';
import { runReminderEvaluation } from '@/lib/reminders/repository';

async function main() {
  const summary = await runReminderEvaluation();

  // One line, and it names the tenant's date rather than the server's, because
  // an off-by-one day is the failure this subsystem is most likely to have and
  // a log that prints UTC would hide it.
  console.log(
    [
      `reminders ${summary.today}`,
      `rules=${summary.rulesConsidered}`,
      `facts=${summary.factsGathered}`,
      `drafted=${summary.drafted}`,
      `inserted=${summary.inserted}`,
    ].join('  '),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
