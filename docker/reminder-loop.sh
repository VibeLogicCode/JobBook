#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# The reminder schedule.
#
# A sidecar, the same shape as backup-loop.sh and for the same two reasons: a
# slow evaluation cannot slow the web server, and a failing evaluation cannot
# take the quoting system down with it. Same image, so it carries the same
# code and updates with the app rather than drifting a version behind the
# schema it queries.
#
# Not host cron, for the reason the backup loop gives: the whole product is one
# `docker compose up`, and a schedule that depends on somebody remembering a
# crontab line on a mini PC stops existing the first time the machine is
# rebuilt, silently.
#
# Unlike the backup loop, this one does NOT refuse to start when something is
# missing. There is nothing to configure: the rules are rows in the database
# and the evaluation is idempotent, so the worst an unconfigured deployment can
# do is evaluate a database with no rules in it and report zero.
# ---------------------------------------------------------------------------

INTERVAL_MINUTES="${REMINDER_INTERVAL_MINUTES:-60}"

case $INTERVAL_MINUTES in
  '' | *[!0-9]*) echo "REMINDER_INTERVAL_MINUTES must be a whole number of minutes" >&2; exit 1 ;;
esac
[ "$INTERVAL_MINUTES" -ge 1 ] || { echo "REMINDER_INTERVAL_MINUTES must be at least 1" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL is not set}"

cd /app

run_once() {
  if ./node_modules/.bin/tsx scripts/reminders.ts; then
    return 0
  fi

  # Logged, and the loop continues. Exiting so Docker restarts the container
  # would turn one bad hour -- a lock held by a migration, say -- into a
  # restart loop, and a container flapping every few seconds buries the message
  # that says what actually went wrong.
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) reminder evaluation FAILED; the next attempt is in ${INTERVAL_MINUTES}m" >&2
  return 1
}

if [ "${REMINDER_RUN_ONCE:-0}" = '1' ]; then
  # Present so the wiring can be proved without waiting an hour -- and so that
  # running the container twice by hand is how the idempotency claim is checked
  # against a real deployment rather than only in a test.
  run_once
  exit $?
fi

echo "reminder schedule started: every ${INTERVAL_MINUTES} minute(s)"

# Immediately, then on the hour. A deployment that has just been brought up
# should have its reminders before the first hour is out; the owner opening the
# screen on a fresh install and finding it empty is how a feature gets written
# off in its first five minutes.
run_once || true

while true; do
  # Sleep to the next boundary rather than for a fixed interval, so an
  # evaluation that takes four minutes does not walk the schedule forward four
  # minutes every hour until it runs at twenty past.
  now=$(date -u +%s)
  interval_seconds=$((INTERVAL_MINUTES * 60))
  next=$(( ((now / interval_seconds) + 1) * interval_seconds ))
  sleep $((next - now))
  run_once || true
done
