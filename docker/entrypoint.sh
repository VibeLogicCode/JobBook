#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Boot sequence: wait for the database, migrate, then serve.
#
# Migration failure is fatal on purpose. A container that starts anyway would
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
    const postgres = require('/app/migrate_modules/postgres');
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

echo "applying migrations"
NODE_PATH=/app/migrate_modules \
  node /app/migrate_modules/drizzle-kit/bin.cjs migrate --config /app/drizzle.config.ts

if [ "${SEED_DEMO:-0}" = "1" ]; then
  echo "loading the demo tenant"
  NODE_PATH=/app/migrate_modules \
    /app/migrate_modules/.bin/tsx /app/scripts/seed.ts || echo "seeding skipped" >&2
fi

echo "starting the application"
exec "$@"
