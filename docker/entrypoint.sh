#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Boot sequence: wait for the database, migrate, then serve.
#
# Migration failure is fatal on purpose. A container that started anyway would
# serve an application whose code expects columns the database does not have,
# and the first thing it would do is write a malformed quote.
#
# The pre-migration dump belongs here too (Plan 4a). Until backup lands, the
# guard is that migrations are additive and reviewed.
# ---------------------------------------------------------------------------

: "${DATABASE_URL:?DATABASE_URL is not set}"

echo "waiting for the database"
for attempt in $(seq 1 60); do
  if node -e "
    const postgres = require('/app/node_modules/postgres');
    const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 2 });
    sql\`select 1\`.then(() => sql.end()).then(() => process.exit(0)).catch(() => process.exit(1));
  " 2>/dev/null; then
    echo "database is up"
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "database did not become reachable in 60 attempts" >&2
    exit 1
  fi
  sleep 1
done

# A dump before the migration, and the boot fails if it cannot be taken.
#
# A migration with no dump behind it has no way back: the container updates
# itself unattended at 3am, and a migration that half-applies or that turns out
# to be wrong leaves the owner with a database he cannot return to the state it
# was in ten seconds earlier. That is the one failure this whole backup tier
# exists for, so it is fatal rather than a warning.
#
# Skipped only when no recipient key is configured, which is the case on a
# development machine and during the first boot of a fresh install where there
# is nothing yet to lose. It is announced either way; a silent skip is how a
# deployment ends up with no dumps and nobody aware of it.
if [ -n "${BACKUP_AGE_PUBLIC_KEY:-}" ]; then
  echo "taking a pre-migration dump"
  BACKUP_LABEL=pre-migration /usr/local/bin/backup.sh
else
  echo "no BACKUP_AGE_PUBLIC_KEY set: skipping the pre-migration dump" >&2
  echo "  this deployment is taking no backups at all -- see docker/README-backup.md" >&2
fi

echo "applying migrations"
# The config carries absolute paths, because the project root the repository
# config was written against does not exist in this image.
cd /app
node node_modules/drizzle-kit/bin.cjs migrate --config /app/drizzle.container.config.ts

if [ "${SEED_DEMO:-0}" = "1" ]; then
  echo "loading the demo tenant"
  # Seeding is allowed to fail without stopping the boot: a database that
  # already holds another company's data refuses to be overwritten, and that
  # refusal is correct rather than fatal.
  ./node_modules/.bin/tsx scripts/seed.ts || echo "seeding skipped" >&2
fi

echo "starting the application"
exec "$@"
