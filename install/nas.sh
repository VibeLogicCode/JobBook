#!/bin/sh
#
# JobBook, installed on a NAS or any Linux box.
#
#   curl -fsSL https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/nas.sh | sh
#
# Or, if you would rather read it first -- and you should, it is a shell script
# from the internet:
#
#   curl -fsSLO https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/nas.sh
#   less nas.sh && sh nas.sh
#
# Works on Synology DSM, QNAP, Unraid, TrueNAS SCALE, Debian, Ubuntu, and
# anything else with Docker. `/bin/sh`, not bash, because a Synology does not
# ship bash on every model.
#
# ---------------------------------------------------------------------------
# IT NEVER OVERWRITES AN EXISTING .env
# ---------------------------------------------------------------------------
#
# That file holds the database password. Regenerating it against a data folder
# that already exists locks the app out of its own records, with a password
# error nobody can act on. A second run reuses what is there, which is what
# makes this safe to re-run.

set -eu

REPO="VibeLogicCode/JobBook"
BRANCH="main"
COMPOSE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/install/docker-compose.yml"
DEFAULT_PORT=38080

say()  { printf '%s\n' "$1"; }
step() { printf '\n%s\n' "$1"; }
good() { printf '  %s\n' "$1"; }
fail() { printf '\n%s\n' "$1" >&2; exit 1; }

say ''
say 'JobBook'
say 'Quoting, invoicing and job costing, on your own machine.'

# ---------------------------------------------------------------------------
# 1. Docker
# ---------------------------------------------------------------------------
step 'Checking Docker...'

if ! command -v docker >/dev/null 2>&1; then
  say ''
  say '  Docker is not installed, or not on this shell'"'"'s PATH.'
  say ''
  say '  On Synology: Package Center -> Container Manager -> Install.'
  say '  On QNAP:     App Center -> Container Station.'
  say '  On Linux:    https://docs.docker.com/engine/install/'
  fail 'Install Docker, then run this again.'
fi

# `docker info` rather than `--version`: the CLI answers while the engine is
# still starting, and every command after this would fail naming nothing.
if ! docker info >/dev/null 2>&1; then
  say ''
  say '  Docker is installed but not answering. Either it is still starting, or'
  say '  this user is not allowed to talk to it.'
  say ''
  say '  On a NAS, SSH in as an administrator and try again with sudo:'
  say "    curl -fsSL $COMPOSE_URL >/dev/null && echo ok"
  fail 'Cannot reach the Docker engine.'
fi

# `docker compose` (v2, a plugin) or `docker-compose` (v1, a separate binary).
# Older DSM ships v1 and the arguments here are identical in both.
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  fail 'Docker is present but Docker Compose is not. Update Container Manager, or install the compose plugin.'
fi
good "Docker is running ($DC)."

# The image carries a real Chromium for the PDF pipeline, and that build is
# amd64 only. Said here rather than left to a platform mismatch mid-pull.
ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$ARCH" in
  x86_64|amd64) : ;;
  *)
    say ''
    say "  This machine is $ARCH, and the image is x86_64 only."
    say '  The ARM Synology models (DS220j, DS223 and similar) cannot run it.'
    fail 'Unsupported architecture.'
    ;;
esac

# ---------------------------------------------------------------------------
# 2. Where it goes
# ---------------------------------------------------------------------------
step 'Choosing a folder...'

# /volume1/docker is the Synology convention and exists on most NAS units;
# anywhere else falls back to the current directory.
if [ -d /volume1/docker ]; then
  ROOT="/volume1/docker/jobbook"
elif [ -d /share/Container ]; then
  ROOT="/share/Container/jobbook"      # QNAP
else
  ROOT="$PWD/jobbook"
fi

# Reading from /dev/tty, not stdin: stdin is the pipe carrying this script when
# it is run through `curl | sh`, so `read` would swallow the rest of the file.
if [ -r /dev/tty ]; then
  printf '  Default: %s\n' "$ROOT"
  printf '  Press Enter to accept, or type another path: '
  read -r answer < /dev/tty || answer=''
  [ -n "$answer" ] && ROOT="$answer"
fi

mkdir -p "$ROOT/data/db" "$ROOT/data/files" "$ROOT/data/config"
good "Using $ROOT"

# ---------------------------------------------------------------------------
# 3. The compose file
# ---------------------------------------------------------------------------
step 'Fetching the compose file...'
if ! curl -fsSL "$COMPOSE_URL" -o "$ROOT/docker-compose.yml"; then
  fail "Could not download $COMPOSE_URL"
fi
good 'Saved docker-compose.yml'

# ---------------------------------------------------------------------------
# 4. Secrets, generated once and kept
# ---------------------------------------------------------------------------
step 'Settings...'

new_secret() {
  # Straight from the kernel's CSPRNG. $RANDOM is seeded and predictable, and
  # this is a database password.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

PORT="$DEFAULT_PORT"

if [ -f "$ROOT/.env" ]; then
  good 'Existing .env found -- keeping your password and settings.'
  existing="$(grep '^APP_PORT=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [ -n "$existing" ] && PORT="$existing"
else
  if [ -r /dev/tty ]; then
    printf '  Port to use [%s]: ' "$DEFAULT_PORT"
    read -r answer < /dev/tty || answer=''
    [ -n "$answer" ] && PORT="$answer"
  fi

  cat > "$ROOT/.env" <<EOF
# Written by install/nas.sh. Keep this file.
#
# POSTGRES_PASSWORD is the database password. If you lose it or change it, the
# app can no longer open its own records -- nothing else knows it, so there is
# nothing to recover it from.
POSTGRES_PASSWORD=$(new_secret)

# Signs the internal request that renders a PDF. Never leaves the machine.
INTERNAL_RENDER_SECRET=$(new_secret)

JOBBOOK_DATA=$ROOT/data
APP_PORT=$PORT

# AUTH_MODE=local treats every visitor as the owner. Right for your own
# network; wrong for anything reachable from the internet. Do not port-forward
# this. See docker/README-access.md when you want it from outside.
AUTH_MODE=local

# A fictional demo tenant on first boot. Leave it at 0 for real work.
SEED_DEMO=0

# Encrypted backups. Generate a keypair on a workstation with age-keygen, put
# the PUBLIC half here, and keep the private half in a password manager -- the
# NAS then writes backups it cannot itself read. Empty means no backups are
# taken and the log says so.
BACKUP_AGE_PUBLIC_KEY=
EOF
  chmod 600 "$ROOT/.env"
  good 'Wrote .env with freshly generated passwords (mode 600).'
fi

# ---------------------------------------------------------------------------
# 5. Pull and start
# ---------------------------------------------------------------------------
step 'Downloading JobBook (about 2 GB the first time)...'
cd "$ROOT"

if ! $DC pull; then
  say ''
  say '  The download failed. The usual cause is that the image has not been'
  say '  made public yet, in which case Docker says "unauthorized".'
  say ''
  say "    https://github.com/$REPO/pkgs/container/jobbook"
  fail 'Could not pull the image.'
fi

step 'Starting...'
$DC up -d || fail 'Docker could not start the containers.'

# ---------------------------------------------------------------------------
# 6. Wait for it to answer
# ---------------------------------------------------------------------------
step 'Waiting for the first boot (it migrates the database, so give it a minute)...'

READY=0
i=0
while [ "$i" -lt 60 ]; do
  sleep 2
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  i=$((i + 1))
done

# The address somebody types on their phone, which is not localhost.
LAN="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -z "$LAN" ] && LAN="<this machine's address>"

say ''
if [ "$READY" -eq 1 ]; then
  good 'JobBook is running.'
  say ''
  say "  On this machine:  http://127.0.0.1:$PORT"
  say "  From a phone:     http://$LAN:$PORT"
  say '  It will walk you through setting up your company.'
else
  say '  It has not answered yet. That is not necessarily wrong -- a first boot'
  say '  on a slow disk can take a few minutes.'
  say ''
  say "  Try:   http://$LAN:$PORT"
  say "  Logs:  cd $ROOT && $DC logs -f app"
fi

say ''
say "  Stop:    cd $ROOT && $DC down"
say "  Start:   cd $ROOT && $DC up -d"
say "  Update:  curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install/update.sh | sh"
say ''
say "  Your data is in $ROOT/data. Back that folder up."
say ''
