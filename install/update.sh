#!/bin/sh
#
# Updates a JobBook install on a NAS or Linux box.
#
#   curl -fsSL https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/update.sh | sh
#
# Pulls the newest image, refreshes the compose file, and restarts. Your .env
# is never touched, so the database password stays what it was -- which is the
# whole reason this is a separate script rather than "run the installer again".
#
# The data folder is untouched too. An update replaces the program, not the
# records: migrations run at boot, and the app does not serve until they have
# finished.

set -eu

REPO="VibeLogicCode/JobBook"
BRANCH="main"
COMPOSE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/install/docker-compose.yml"

say()  { printf '%s\n' "$1"; }
step() { printf '\n%s\n' "$1"; }
good() { printf '  %s\n' "$1"; }
fail() { printf '\n%s\n' "$1" >&2; exit 1; }

say ''
say 'Updating JobBook'

if [ -d /volume1/docker/jobbook ]; then
  ROOT="/volume1/docker/jobbook"
elif [ -d /share/Container/jobbook ]; then
  ROOT="/share/Container/jobbook"
else
  ROOT="$PWD/jobbook"
fi

# From /dev/tty, not stdin: stdin is the pipe carrying this script.
if [ -r /dev/tty ]; then
  printf '\n  Default: %s\n' "$ROOT"
  printf '  Press Enter to accept, or type where you installed it: '
  read -r answer < /dev/tty || answer=''
  [ -n "$answer" ] && ROOT="$answer"
fi

[ -f "$ROOT/.env" ] || fail "No .env in $ROOT -- that does not look like a JobBook install.
Run the installer instead:
  curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install/nas.sh | sh"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  fail 'Docker Compose is not available.'
fi

step 'Backing up your settings file...'
# Cheap insurance: the .env holds the only copy of the database password.
cp "$ROOT/.env" "$ROOT/.env.backup"
good 'Copied .env to .env.backup'

step 'Refreshing the compose file...'
curl -fsSL "$COMPOSE_URL" -o "$ROOT/docker-compose.yml" || fail "Could not download $COMPOSE_URL"
good 'Updated docker-compose.yml'

cd "$ROOT"

step 'Downloading the new image...'
$DC pull || fail 'Could not pull the image.'

step 'Restarting...'
# Recreates only what changed, so the database container is left alone when
# only the app image moved.
$DC up -d || fail 'Docker could not restart the containers.'

step 'Tidying up old images...'
docker image prune -f >/dev/null 2>&1 || true
good 'Done.'

PORT="$(grep '^APP_PORT=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)"
[ -z "$PORT" ] && PORT=38080
LAN="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -z "$LAN" ] && LAN="127.0.0.1"

say ''
say "  JobBook is restarting at http://$LAN:$PORT"
say '  The first request after an update waits for the migrations to finish.'
say ''
