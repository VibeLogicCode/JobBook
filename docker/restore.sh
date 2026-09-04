#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Restore one backup artifact (design section 8.3).
#
# A backup that has never been restored is not a backup, so this script is not
# only for the bad day: it is the weekly drill, run against a scratch database,
# and it is the thing that proves the encrypted artifact is decryptable at all
# -- the check backup.sh deliberately cannot make, because the private key is
# not on the machine that writes the backups.
#
# It handles both halves of a recovery, because a restored database whose files
# rows point at missing images is only half a recovery:
#
#     db-*.dump.age          -> pg_restore into the database DATABASE_URL names
#     files-*.tar.gz.age     -> the uploaded files tree
#
# Two rules shape everything below:
#
#   1. Nothing is touched until the plan has been printed. The operator reading
#      it is under pressure and has one chance to notice the wrong artifact or
#      the wrong database.
#   2. It refuses to write over anything that is not empty unless RESTORE_FORCE
#      is set. The realistic accident is restoring last week over today.
# ---------------------------------------------------------------------------

export LC_ALL=C
umask 077 # The decrypted plaintext lands in a temp file; it is readable by no one else.

log() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() { warn "restore aborted: $*"; exit 1; }

usage() {
  cat <<'USAGE'
usage: restore.sh <artifact> [--key <age-identity-file>]

  <artifact>  db-*.dump.age        restore the database named by DATABASE_URL
              files-*.tar.gz.age   restore uploaded files into RESTORE_FILES_DIR
              a plain .dump or .tar.gz is accepted as-is (already decrypted)

environment
  DATABASE_URL          target of a database restore
  RESTORE_AGE_KEY_FILE  age identity file; needed only for .age artifacts
  RESTORE_FORCE=1       allow restoring over a database or files tree that is
                        not empty. Read the printed plan first.
  RESTORE_FILES_DIR     where a file archive lands (default /data/files)
  RESTORE_ASSUME_YES=1  skip the interactive pause before writing
USAGE
}

# --- arguments -------------------------------------------------------------
#
# The age identity is passed as a FILE, never as a key in an environment
# variable: the environment of a process is readable through ps and through
# docker inspect, and this is the one key that opens every backup ever taken.
artifact=""
key_file="${RESTORE_AGE_KEY_FILE:-}"
while [ $# -gt 0 ]; do
  case $1 in
    --key | -i)
      [ $# -ge 2 ] || die "--key needs a path"
      key_file=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*) die "unknown option $1" ;;
    *)
      [ -z "$artifact" ] || die "one artifact at a time (got $artifact and $1)"
      artifact=$1
      shift
      ;;
  esac
done
[ -n "$artifact" ] || {
  usage
  exit 2
}
[ -f "$artifact" ] || die "$artifact does not exist"

RESTORE_FILES_DIR="${RESTORE_FILES_DIR:-/data/files}"
RESTORE_FORCE="${RESTORE_FORCE:-0}"

# --- what kind of artifact is this? ----------------------------------------
#
# Decided by name rather than by content sniffing, because the names are ours:
# backup.sh writes them, and a file that does not match one of these shapes is
# far more likely to be the wrong file than an oddly named right one.
case $(basename -- "$artifact") in
  *.dump.age | *.dump) kind=database ;;
  *.tar.gz.age | *.tgz.age | *.tar.gz | *.tgz) kind=files ;;
  *) die "cannot tell what $artifact is. Expected a db-*.dump.age or files-*.tar.gz.age artifact." ;;
esac

encrypted=no
case $artifact in *.age) encrypted=yes ;; esac

# --- preflight -------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed (see docker/README-backup.md)"; }
[ "$encrypted" = no ] || need age
if [ "$kind" = database ]; then
  need pg_restore
  need psql
  : "${DATABASE_URL:?DATABASE_URL is not set; there is nothing to restore into}"
else
  need tar
fi

if [ "$encrypted" = yes ]; then
  [ -n "$key_file" ] || die "this artifact is encrypted; pass --key <file> or set RESTORE_AGE_KEY_FILE"
  [ -f "$key_file" ] || die "the key file $key_file does not exist"
  [ -r "$key_file" ] || die "the key file $key_file is not readable"
  if command -v stat >/dev/null 2>&1; then
    mode=$(stat -c '%a' "$key_file" 2>/dev/null || echo "")
    # Group- or world-readable key material on a shared box is worth saying out
    # loud, but it is not a reason to block a recovery in progress.
    case $mode in
      "" | 400 | 600) : ;;
      *) warn "note: $key_file is mode $mode; it should be 600" ;;
    esac
  fi
fi

# Same filesystem as the target where possible, and cleaned up on every exit
# path: the decrypted plaintext must not outlive this process.
work=$(mktemp -d "${TMPDIR:-/tmp}/restore.XXXXXX")
trap 'rm -rf "$work"' EXIT

# --- decrypt ---------------------------------------------------------------
#
# Done before the plan is printed, not after. Decryption writes nothing outside
# the temp directory, and it is what lets the plan below quote real facts about
# the archive -- when it was taken, how many tables it carries -- instead of
# asking the operator to trust a filename.
if [ "$encrypted" = yes ]; then
  payload="$work/$(basename -- "${artifact%.age}")"
  log "decrypting $(basename -- "$artifact")"
  age --decrypt --identity "$key_file" --output "$payload" "$artifact" \
    || die "decryption failed. Wrong key file, or the artifact is truncated."
  [ -s "$payload" ] || die "decryption produced an empty file"
else
  payload=$artifact
fi

size=$(du -h "$artifact" | cut -f1)
checksum=$(sha256sum "$artifact" 2>/dev/null | cut -c1-16 || echo unavailable)

mask_url() {
  # The plan is printed to a terminal, into cron mail, and pasted into the
  # runbook. The password does not travel with it.
  printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'
}

pause_before_writing() {
  # A drill and a cron job have no terminal and must not block. A human at a
  # keyboard gets a moment to read what is above and press Ctrl-C.
  if [ -t 0 ] && [ "${RESTORE_ASSUME_YES:-0}" != "1" ]; then
    log ""
    log "starting in 5 seconds -- Ctrl-C to abort"
    sleep 5
  fi
}

# ===========================================================================
# Database
# ===========================================================================
if [ "$kind" = database ]; then
  # Verified before the target is touched, for the same reason backup.sh
  # verifies: finding out the archive is unreadable AFTER dropping the schema
  # turns a recoverable morning into a lost one.
  pg_restore --list --format=custom "$payload" >"$work/toc.txt" \
    || die "$payload is not a readable custom-format archive"
  taken_at=$(grep -m1 '^; *Archive created at' "$work/toc.txt" | sed 's/^; *Archive created at //' || true)
  server_version=$(grep -m1 '^; *Dumped from database version' "$work/toc.txt" | sed 's/^; *Dumped from database version: *//' || true)
  data_entries=$(grep -c 'TABLE DATA' "$work/toc.txt" || true)

  # One query, one round trip, exact counts. query_to_xml runs the count for
  # each table and hands the number back as a value, which is what makes an
  # exact inventory possible in a single statement; pg_class.reltuples is an
  # estimate and reads -1 on a table that was never analysed, so it would
  # report a loaded database as empty.
  inventory_sql="
    select format('%I.%I', schemaname, tablename) as relation,
           (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename),
                           false, true, '')))[1]::text::bigint as row_count
      from pg_tables
     where schemaname not in ('pg_catalog', 'information_schema')
     order by 2 desc, 1"

  inventory() {
    psql --dbname="$DATABASE_URL" --no-psqlrc --quiet --no-align --tuples-only \
      --field-separator='|' --set=ON_ERROR_STOP=1 --command="$inventory_sql"
  }

  before=$(inventory) || die "cannot read the target database. Does it exist, and are the credentials right?"
  table_count=$(printf '%s' "$before" | grep -c . || true)
  row_count=$(printf '%s\n' "$before" | awk -F'|' '{ total += $2 } END { print total + 0 }')

  log ""
  log "restore plan"
  log "  artifact     : $artifact"
  log "                 $size, sha256 $checksum..."
  log "  taken        : ${taken_at:-unknown}"
  log "  dumped from  : PostgreSQL ${server_version:-unknown}"
  log "  carries      : $data_entries tables with data"
  log "  into         : $(mask_url "$DATABASE_URL")"
  log "  which holds  : ${table_count:-0} tables, ${row_count:-0} rows"

  clean_args=()
  if [ "${table_count:-0}" -gt 0 ]; then
    log ""
    log "  THIS WILL BE DROPPED AND REPLACED:"
    # Named individually with their row counts. "12 tables" is not something an
    # operator can check against what they believe is in there; a list is.
    printf '%s\n' "$before" | awk -F'|' 'NF { printf "    %-40s %12s rows\n", $1, $2 }'
    log ""
    if [ "$RESTORE_FORCE" != "1" ]; then
      die "the target is not empty. Nothing has been changed. Re-run with RESTORE_FORCE=1 once the list above is what you expect to lose."
    fi
    warn "RESTORE_FORCE=1: the objects listed above will be dropped."
    # Only with force, and only because the target already holds the schema.
    # Without --clean, pg_restore would layer the dump over existing objects and
    # report a hundred "already exists" errors around the handful that matter.
    clean_args=(--clean --if-exists)
  else
    log "  the target is empty, so nothing will be lost"
  fi

  pause_before_writing
  log "restoring"

  # --single-transaction: all of it or none of it. A half-restored database is
  #   worse than an untouched one, because it looks like a database.
  # --no-owner, --no-privileges: the dump records the role that owned each
  #   object. On new hardware, or in a scratch database for a drill, that role
  #   need not exist, and ownership statements would fail the restore for a
  #   reason that has nothing to do with the data.
  # No --create, deliberately: this restores into the database DATABASE_URL
  #   names, which is what makes a drill against a scratch database possible
  #   without editing the artifact.
  pg_restore \
    --dbname="$DATABASE_URL" \
    --format=custom \
    --single-transaction \
    --no-owner \
    --no-privileges \
    "${clean_args[@]+"${clean_args[@]}"}" \
    "$payload" \
    || die "pg_restore failed. Inside a single transaction, so the target is as it was."

  # The planner has no statistics for freshly restored tables, and the first
  # thing the application does is run the queries behind the quote list.
  psql --dbname="$DATABASE_URL" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --command='analyze' >/dev/null \
    || warn "analyze failed; the restore itself succeeded"

  after=$(inventory)
  after_tables=$(printf '%s' "$after" | grep -c . || true)
  after_rows=$(printf '%s\n' "$after" | awk -F'|' '{ total += $2 } END { print total + 0 }')

  log ""
  log "restored: ${after_tables:-0} tables, ${after_rows:-0} rows"
  # The row counts are the drill's result, so they are printed rather than
  # logged away: a restore that lands zero rows is a green exit code and a
  # failed recovery.
  printf '%s\n' "$after" | awk -F'|' 'NF { printf "    %-40s %12s rows\n", $1, $2 }'
  if [ "${after_rows:-0}" -eq 0 ]; then
    die "the restore completed but the database is empty. Treat this as a failed drill."
  fi
  log ""
  log "done. Uploaded files are a separate artifact: re-run with the matching files-*.tar.gz.age"
  exit 0
fi

# ===========================================================================
# Uploaded files
# ===========================================================================
tar -tzf "$payload" >"$work/listing.txt" || die "$payload is not a readable gzip archive"
entries=$(grep -c . <"$work/listing.txt" || true)

existing=0
if [ -d "$RESTORE_FILES_DIR" ]; then
  existing=$(find "$RESTORE_FILES_DIR" -type f | grep -c . || true)
fi

log ""
log "restore plan"
log "  artifact    : $artifact"
log "                $size, sha256 $checksum..."
log "  carries     : $entries entries"
log "  into        : $RESTORE_FILES_DIR"
log "  which holds : $existing file(s)"

if [ "${existing:-0}" -gt 0 ]; then
  log ""
  log "  Files in the archive will overwrite files of the same name."
  log "  Anything already there that the archive does not carry is left in place,"
  log "  so this merges rather than replaces. Empty the directory first if you"
  log "  need an exact restore of that moment."
  log ""
  if [ "$RESTORE_FORCE" != "1" ]; then
    die "$RESTORE_FILES_DIR is not empty. Nothing has been changed. Re-run with RESTORE_FORCE=1."
  fi
  warn "RESTORE_FORCE=1: overwriting matching files in $RESTORE_FILES_DIR"
fi

pause_before_writing
mkdir -p "$RESTORE_FILES_DIR"
# --strip-components=1 drops the archive's own top-level directory name, so the
# tree lands in RESTORE_FILES_DIR whatever that directory was called on the
# machine the backup came from.
tar -xzf "$payload" --strip-components=1 -C "$RESTORE_FILES_DIR" \
  || die "extraction failed; $RESTORE_FILES_DIR may be partially written"

restored=$(find "$RESTORE_FILES_DIR" -type f | grep -c . || true)
log ""
log "restored: $RESTORE_FILES_DIR now holds ${restored:-0} file(s)"
exit 0
