#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Hourly backup. One artifact, three destinations (design section 8).
#
# The order of operations is the design, and it is not interchangeable:
#
#     dump -> verify -> encrypt -> distribute -> prune -> heartbeat
#
# Verification runs on the plaintext dump, BEFORE encryption, because the age
# private key deliberately does not live on this machine (section 8.2). A box
# that could decrypt its own backups would defeat the reason for encrypting
# them. That the encrypted artifact is still decryptable is proven separately,
# by the restore drill in README-backup.md, run from a workstation that holds
# the private half.
#
# The heartbeat is last and fires only on success. Every failure path below
# exits non-zero without pinging, so the external monitor alerts on the missed
# window. Backups fail silently by default, and the realistic failure here is
# the mini PC being dead or unplugged -- which nothing running on the mini PC
# can report.
#
# Safe to run by hand at any time; safe to run twice.
# ---------------------------------------------------------------------------

# Associative arrays carry the last-of-day retention decision.
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  echo "this script needs bash 4 or newer" >&2
  exit 1
fi

# Timestamps are both the sort key and the retention key, so sorting and
# matching must be byte-deterministic rather than locale-dependent.
export LC_ALL=C

# A dump holds every customer record and every dollar figure. Even encrypted,
# it is nobody else's to read.
umask 077

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { warn "backup aborted: $*"; exit 1; }

# cron mails whatever a job prints. Naming the failing line is the difference
# between a usable mail and "exit status 1".
trap 'status=$?; [ "$status" -eq 0 ] || warn "failed at line $LINENO with status $status"' ERR

# --- configuration ---------------------------------------------------------
#
# Only the dump itself is mandatory. Every destination is optional and is
# skipped with a message when unset: a development box has no USB drive, and a
# deployment with the SharePoint mirror off (section 7.0) has no upload
# directory.

: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${BACKUP_AGE_PUBLIC_KEY:?BACKUP_AGE_PUBLIC_KEY is not set -- see docker/README-backup.md}"

BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/data/backups}"
BACKUP_USB_DIR="${BACKUP_USB_DIR:-}"
BACKUP_USB_SENTINEL="${BACKUP_USB_SENTINEL:-.backup-volume}"
BACKUP_UPLOAD_DIR="${BACKUP_UPLOAD_DIR:-}"
BACKUP_FILES_DIR="${BACKUP_FILES_DIR:-/data/files}"
BACKUP_HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-}"
RETAIN_HOURLY_HOURS="${BACKUP_RETAIN_HOURLY_HOURS:-48}"
RETAIN_DAILY_DAYS="${BACKUP_RETAIN_DAILY_DAYS:-30}"

# The label lands in the filename so a dump taken for a specific reason -- the
# pre-migration dump the entrypoint takes before it migrates -- is still
# identifiable in a directory listing months later. Restricted to a safe
# character set, because it becomes part of a path and part of a glob.
BACKUP_LABEL="${BACKUP_LABEL:-hourly}"
case $BACKUP_LABEL in
  "" | *[!a-z0-9-]*) die "BACKUP_LABEL must be lowercase letters, digits and dashes" ;;
esac

# Pasting the private key into the public variable would put the secret on the
# one machine the whole scheme exists to keep it off. It is an easy mistake to
# make once and an impossible one to notice afterwards, so it is checked.
case $BACKUP_AGE_PUBLIC_KEY in
  AGE-SECRET-KEY-*) die "BACKUP_AGE_PUBLIC_KEY holds a PRIVATE key. The private half must never be on this machine." ;;
  age1* | "ssh-rsa "* | "ssh-ed25519 "*) : ;;
  *) die "BACKUP_AGE_PUBLIC_KEY does not look like an age or ssh recipient" ;;
esac

verify_usb_mount() {
  local dir=$1
  # Writing to an unmounted mount point succeeds -- against the internal disk,
  # at the same path. There is then no external backup at all while every log
  # line claims there is, and the internal disk quietly fills with the copies
  # that were meant to be elsewhere. Two independent checks, because each alone
  # has a hole: mountpoint proves something is mounted but not that it is the
  # right drive, and a sentinel file can be created in the directory that shows
  # through when nothing is mounted.
  command -v mountpoint >/dev/null 2>&1 \
    || die "BACKUP_USB_DIR is set but mountpoint is not installed; refusing to write an unverified backup"
  mountpoint -q "$dir" \
    || die "$dir is not a mount point -- the USB drive is not mounted. Refusing to write this backup to the internal disk."
  [ -f "$dir/$BACKUP_USB_SENTINEL" ] \
    || die "sentinel $BACKUP_USB_SENTINEL is missing from $dir -- something is mounted there, but it is not the backup drive."
  # ext4 remounts read-only on error (section 8.2, requirement 2). That is the
  # filesystem doing the right thing, and it must not read as success here.
  [ -w "$dir" ] \
    || die "$dir is mounted but not writable; check dmesg for an errors=remount-ro event"
}

# --- preflight -------------------------------------------------------------
#
# Checked up front rather than discovered halfway through, which would leave a
# plaintext dump on disk and no finished artifact anywhere.
for tool in pg_dump pg_restore age tar; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed (see README-backup.md, prerequisites)"
done

# The USB drive is checked here as well as immediately before it is written to.
# Failing in preflight is what makes a missing drive cheap: nothing has been
# dumped, no artifact is half-distributed, and -- the reason this matters --
# retention has not been skipped, which is what a run that dies mid-flight
# every hour for a week would otherwise do to the internal disk.
[ -z "$BACKUP_USB_DIR" ] || verify_usb_mount "$BACKUP_USB_DIR"

if [ -z "$BACKUP_USB_DIR" ] && [ -z "$BACKUP_UPLOAD_DIR" ]; then
  # Section 7.0's interlock. Running this way is the owner's decision; it is
  # not one to make silently.
  warn "NEITHER a USB nor an upload destination is configured: the only copy of this backup sits on the same disk as the database it protects, and survives nothing"
fi

if [ -n "${SHAREPOINT_SYNC_ENABLED:-}" ] && [ "${SHAREPOINT_SYNC_ENABLED}" != "0" ] && [ -z "$BACKUP_UPLOAD_DIR" ]; then
  warn "SHAREPOINT_SYNC_ENABLED is on but BACKUP_UPLOAD_DIR is unset: nothing will be uploaded offsite"
fi

mkdir -p "$BACKUP_LOCAL_DIR"

# Two runs at once would write the same timestamped name and race the pruner.
# Hourly cron plus one impatient manual run is all that takes.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_LOCAL_DIR/.lock"
  flock -n 9 || die "another backup is already running"
else
  warn "flock is not installed; concurrent runs are not prevented"
fi

# A run killed between the dump and the encryption leaves an UNENCRYPTED dump
# in its work directory. Left alone it sits there permanently -- filling the
# disk, and holding in plaintext exactly what the encryption exists to protect.
# Safe to do here and only here: this process holds the lock, so no live run
# owns any of these directories.
find "$BACKUP_LOCAL_DIR" -maxdepth 1 -name '.work.*' -type d -mmin +120 -exec rm -rf {} + 2>/dev/null || true

# The work directory sits inside the primary destination on purpose: same
# filesystem, so the final rename into place is atomic, and not a container
# tmpfs that a large file archive would fill.
work=$(mktemp -d "$BACKUP_LOCAL_DIR/.work.XXXXXX")
trap 'rm -rf "$work"' EXIT

stamp=$(date -u +%Y%m%dT%H%M%SZ)
db_name="db-${stamp}-${BACKUP_LABEL}.dump"
files_name="files-${stamp}-${BACKUP_LABEL}.tar.gz"

# --- dump ------------------------------------------------------------------
#
# --format=custom is not a preference. pg_restore --list reads archive formats
# only, so a plain-SQL dump cannot be verified at all (section 8.2). It also
# compresses, and it lets a restore be selective.
#
# Piping pg_dump straight into age would avoid writing plaintext to disk, but
# pg_restore needs a seekable file to read a table of contents, and an
# unverified backup is the exact failure this script exists to prevent. The
# plaintext lives in $work for seconds and is removed on exit.
log "dumping the database"
pg_dump --format=custom --compress=9 --file="$work/$db_name" --dbname="$DATABASE_URL"

# --- verify, on the plaintext ---------------------------------------------
log "verifying the dump"
pg_restore --list --format=custom "$work/$db_name" >"$work/toc.txt" \
  || die "the dump did not survive pg_restore --list; it is not a usable backup"

# An archive with no data entries reads as perfectly valid. Dumping an empty
# database -- wrong DATABASE_URL, wrong container, a database that was never
# migrated -- therefore passes verification and looks healthy forever. A fresh
# install legitimately has nothing yet, so this warns rather than fails.
data_entries=$(grep -c "TABLE DATA" "$work/toc.txt" || true)
if [ "${data_entries:-0}" -eq 0 ]; then
  warn "the dump contains no table data. If this is not a brand-new install, DATABASE_URL points somewhere unexpected."
else
  log "verified: $data_entries tables with data"
fi

# --- uploaded files --------------------------------------------------------
#
# A restored database whose files rows point at missing images is only half a
# recovery (section 8.2), so receipts, logos and generated PDFs travel in the
# same run, as part of the same artifact set, to the same destinations.
artifacts=("$work/$db_name")
if [ -d "$BACKUP_FILES_DIR" ] && [ -n "$(ls -A "$BACKUP_FILES_DIR" 2>/dev/null || true)" ]; then
  log "archiving uploaded files"
  # -C the parent and name the leaf, so the archive holds relative paths and a
  # restore can land the tree wherever /data/files is mounted next time.
  tar_status=0
  tar -czf "$work/$files_name" \
    -C "$(dirname "$BACKUP_FILES_DIR")" "$(basename "$BACKUP_FILES_DIR")" || tar_status=$?
  if [ "$tar_status" -eq 1 ]; then
    # Exit 1 is "file changed as we read it", which an upload landing mid-run
    # causes routinely. Exit 2 and above is a real error. One retry, because
    # the second pass sees a finished file.
    warn "the uploaded files changed while being archived; retrying once"
    tar -czf "$work/$files_name" \
      -C "$(dirname "$BACKUP_FILES_DIR")" "$(basename "$BACKUP_FILES_DIR")" \
      || die "the file archive failed twice"
  elif [ "$tar_status" -ne 0 ]; then
    die "tar exited $tar_status archiving $BACKUP_FILES_DIR"
  fi
  # A tarball that cannot be listed is not a backup either, and the same
  # off-box-key argument applies: check it before it is encrypted.
  tar -tzf "$work/$files_name" >/dev/null || die "the file archive could not be listed back"
  artifacts+=("$work/$files_name")
else
  log "no uploaded files at $BACKUP_FILES_DIR yet; skipping the file archive"
fi

# --- encrypt ---------------------------------------------------------------
#
# The dump is encrypted, not the disk (section 8.2, requirement 3). Full-disk
# LUKS needs a keyfile on the internal disk for unattended boot, so stealing
# the machine defeats it -- and the realistic threat is the external drive
# alone walking out of an office.
log "encrypting to $BACKUP_AGE_PUBLIC_KEY"
encrypted=()
for plain in "${artifacts[@]}"; do
  age --recipient "$BACKUP_AGE_PUBLIC_KEY" --output "$plain.age" "$plain"
  # A zero-byte output means age wrote nothing and exited happily, which is
  # what a recipient it could not parse looks like from here.
  [ -s "$plain.age" ] || die "$(basename "$plain").age is empty after encryption"
  encrypted+=("$plain.age")
  rm -f "$plain"
done

# --- distribute ------------------------------------------------------------
#
# One artifact, three destinations. Not three backup implementations.

deliver() {
  local name=$1 dir=$2
  shift 2
  if [ -z "$dir" ]; then
    log "skipping the $name copy: not configured"
    return 0
  fi
  mkdir -p "$dir"
  local src base
  for src in "$@"; do
    base=$(basename "$src")
    # Written under a .part name and renamed into place. The rename is atomic
    # within a filesystem, so the SharePoint uploader watching its directory
    # can never pick up a half-written dump and store a truncated backup
    # offsite -- the one copy nobody checks until it is needed.
    cp -- "$src" "$dir/$base.part"
    mv -- "$dir/$base.part" "$dir/$base"
  done
  log "wrote $# artifact(s) to the $name copy at $dir"
}

deliver "internal volume" "$BACKUP_LOCAL_DIR" "${encrypted[@]}"

if [ -n "$BACKUP_USB_DIR" ]; then
  # Checked in preflight too, but this is the check that actually guards the
  # write: a drive can spin down or unmount in the seconds it takes to dump and
  # encrypt, and the cost of being wrong is a backup that silently lands on the
  # disk it was supposed to leave.
  verify_usb_mount "$BACKUP_USB_DIR"
  deliver "USB" "$BACKUP_USB_DIR" "${encrypted[@]}"
  # A copy sitting in the page cache is not on the drive. This is the tier that
  # exists for the drive being unplugged and carried away.
  sync
else
  log "skipping the USB copy: BACKUP_USB_DIR is not set"
fi

deliver "upload" "$BACKUP_UPLOAD_DIR" "${encrypted[@]}"

# --- retention -------------------------------------------------------------
#
# Enforced every run, not hoped for: a full disk stops backups silently
# (section 8.2, requirement 4). Pruning runs AFTER the new artifact has landed,
# so a failed write never costs an older good copy. A full disk therefore fails
# this run loudly -- no heartbeat, monitor alerts -- rather than deleting
# history to make room for a backup that may not be written.
#
# Two tiers, and deliberately no third. A twelve-month monthly tier was
# considered and dropped: the offsite copy already holds long-term history, and
# every tier is pruning code that can fail silently.

stamp_of() {
  # Fixed-width UTC stamp, so it serves as both sort key and day key.
  # || true: a stranger's file in the directory is not this script's failure.
  basename -- "$1" | grep -oE "[0-9]{8}T[0-9]{6}Z" | head -n1 || true
}

stamp_epoch() {
  local s=$1
  # date cannot read 20260904T140000Z as it stands. Reshaping it here beats
  # carrying a second, friendlier timestamp in every filename.
  date -u -d "${s:0:4}-${s:4:2}-${s:6:2} ${s:9:2}:${s:11:2}:${s:13:2} UTC" +%s
}

prune_dir() {
  local dir=$1
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  local now removed=0 pattern f s epoch age_s
  now=$(date -u +%s)

  for pattern in "db-*.dump.age" "files-*.tar.gz.age"; do
    local -a found=()
    shopt -s nullglob
    found=("$dir"/$pattern)
    shopt -u nullglob
    [ "${#found[@]}" -gt 0 ] || continue

    # Fixed-width UTC stamps sort chronologically as plain text, so the last
    # name to sort under a date IS that date's final backup. Deciding from the
    # names rather than from mtimes matters, because copying to the USB drive
    # and to the upload directory rewrites every mtime to the copy time.
    local -A last_of_day=()
    while IFS= read -r f; do
      s=$(stamp_of "$f")
      [ -n "$s" ] || continue
      last_of_day["${s:0:8}"]=$f
    done < <(printf '%s\n' "${found[@]}" | sort)

    for f in "${found[@]}"; do
      s=$(stamp_of "$f")
      if [ -z "$s" ]; then
        warn "cannot read a timestamp from $f; leaving it alone"
        continue
      fi
      epoch=$(stamp_epoch "$s")
      age_s=$((now - epoch))
      # Tier 1: every dump from the last 48 hours. A negative age means a clock
      # jump, and keeping the file is the safe reading of that.
      if [ "$age_s" -le $((RETAIN_HOURLY_HOURS * 3600)) ]; then
        continue
      fi
      # Tier 2: the last dump of each day, for 30 days.
      if [ "${last_of_day[${s:0:8}]-}" = "$f" ] && [ "$age_s" -le $((RETAIN_DAILY_DAYS * 86400)) ]; then
        continue
      fi
      rm -f -- "$f"
      removed=$((removed + 1))
    done
  done

  [ "$removed" -eq 0 ] || log "pruned $removed expired artifact(s) from $dir"
}

prune_dir "$BACKUP_LOCAL_DIR"
prune_dir "$BACKUP_USB_DIR"
# The upload directory is pruned on the same schedule. It is an outbox, not an
# archive: the uploader has a 48-hour window to move an hourly artifact
# offsite, and an outbox that is never pruned fills the disk that holds the
# database. Long-term history lives in the offsite copy, not here.
prune_dir "$BACKUP_UPLOAD_DIR"

# --- dead-man's switch ----------------------------------------------------
#
# Success only, and last. Everything above exits non-zero on failure, so a
# broken backup is a missed ping, and a missed ping is an alert raised by a
# machine that is not this one.
if [ -z "$BACKUP_HEARTBEAT_URL" ]; then
  warn "BACKUP_HEARTBEAT_URL is not set: a backup that stops running will not be noticed"
elif ! command -v curl >/dev/null 2>&1; then
  warn "curl is not installed; the dead-man's switch was not pinged"
elif curl -fsS --max-time 10 --retry 2 -o /dev/null "$BACKUP_HEARTBEAT_URL"; then
  log "pinged the dead-man's switch"
else
  # Deliberately not a failure. The artifacts are written and verified; only
  # the report failed. The monitor alerts on the missed window anyway, which is
  # the safe direction -- an alert with a good backup on disk beats a run that
  # claims a success it could not report.
  warn "could not reach the dead-man's switch; the monitor will alert on the missed window"
fi

log "backup complete: $(basename "${encrypted[0]}")"
exit 0
