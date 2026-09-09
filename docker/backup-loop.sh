#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# The backup schedule.
#
# A sidecar rather than a timer inside the application process, and rather than
# cron on the host.
#
# Not in the app process: a dump is minutes of IO, and a Node process holding
# the web server should not be the thing deciding when to do it. If the app
# crashes or is restarted mid-deploy the schedule must not go with it, and a
# backup failing must never be able to take the quoting system down.
#
# Not host cron: the whole product is one `docker compose up`. A backup that
# depends on somebody remembering to add a crontab line on a mini PC is a
# backup that exists on the day it is set up and stops existing the first time
# the machine is rebuilt -- and nobody notices, because a missing backup is
# silent until it is needed.
#
# So: same image, same scripts, its own container, restarted by Docker.
# ---------------------------------------------------------------------------

# The wizard writes BACKUP_AGE_PUBLIC_KEY here when it generates the keypair
# itself, and this container is its own entrypoint -- so without this line it
# would never see a recipient the app had just configured, and would exit
# claiming no backups were possible while the app showed them as enabled.
# shellcheck source=/usr/local/bin/read-config.sh
. /usr/local/bin/read-config.sh
read_deploy_config

INTERVAL_MINUTES="${BACKUP_INTERVAL_MINUTES:-60}"

case $INTERVAL_MINUTES in
  '' | *[!0-9]*) echo "BACKUP_INTERVAL_MINUTES must be a whole number of minutes" >&2; exit 1 ;;
esac
[ "$INTERVAL_MINUTES" -ge 1 ] || { echo "BACKUP_INTERVAL_MINUTES must be at least 1" >&2; exit 1; }

if [ -z "${BACKUP_AGE_PUBLIC_KEY:-}" ]; then
  # Refuse rather than idle. A running container named `backup` that is
  # quietly taking none is worse than one that is absent: it looks like the
  # backups are handled.
  echo "BACKUP_AGE_PUBLIC_KEY is not set, so no backup can be encrypted." >&2
  echo "This deployment is taking NO backups. See docker/README-backup.md." >&2
  exit 1
fi

run_once() {
  # The label groups artifacts for retention: everything from the last 48
  # hours is kept, plus the last of each day for 30 days.
  if BACKUP_LABEL="${BACKUP_LABEL:-hourly}" /usr/local/bin/backup.sh; then
    return 0
  fi

  # A failed run is logged and the loop continues. The alternative -- exiting
  # so Docker restarts the container -- would turn one unwritable USB drive
  # into a restart loop that never takes the internal copy either.
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup run FAILED; the next attempt is in ${INTERVAL_MINUTES}m" >&2
  return 1
}

if [ "${BACKUP_RUN_ONCE:-0}" = '1' ]; then
  # Present so the wiring can be proved in a test without waiting an hour.
  run_once
  exit $?
fi

echo "backup schedule started: every ${INTERVAL_MINUTES} minute(s)"

# The first run is immediate, so a fresh deployment holds a backup within
# seconds rather than an hour. A machine that dies in its first hour is a
# machine somebody just typed a day of quotes into.
run_once || true

while true; do
  # Sleep to the next boundary rather than for a fixed interval, so a run that
  # takes four minutes does not walk the schedule forward four minutes every
  # hour until the hourly backup happens at twenty past.
  now=$(date -u +%s)
  interval_seconds=$((INTERVAL_MINUTES * 60))
  next=$(( ((now / interval_seconds) + 1) * interval_seconds ))
  sleep $((next - now))
  run_once || true
done
