# Backup and restore

Operator guide for `docker/backup.sh` and `docker/restore.sh`. The reasoning
behind every choice here is in the design, section 8; this file is the how.

Three copies, two media, one offsite. One artifact, three destinations — the
same encrypted `pg_dump` file is written to the internal volume, copied to the
USB drive, and dropped in a directory the SharePoint uploader watches. It is
not three backup implementations.

| Destination | Variable | Survives | Retention |
|---|---|---|---|
| Internal volume | `BACKUP_LOCAL_DIR` (default `/data/backups`) | Bad data, a dropped table, a botched migration | 48 h hourly + 30 d last-of-day |
| USB drive | `BACKUP_USB_DIR` | Internal disk failure, filesystem corruption, the machine dying | 48 h hourly + 30 d last-of-day |
| Upload outbox | `BACKUP_UPLOAD_DIR` | Fire, theft, flood, the site going away | 48 h hourly + 30 d last-of-day |

Any destination that is unset is skipped with a message. With **both** the USB
and the upload destination unset, the only copy of the backup sits on the same
disk as the database it protects — the script says so on every run, loudly,
because that is the owner's decision to make and not one to make quietly.

Each run backs up **two** artifacts, and a recovery needs both:

- `db-<UTC stamp>-<label>.dump.age` — the database
- `files-<UTC stamp>-<label>.tar.gz.age` — everything under `BACKUP_FILES_DIR`
  (default `/data/files`): receipts, logos, generated PDFs. A restored database
  whose `files` rows point at missing images is only half a recovery.

## Prerequisites

The runtime image does not carry these yet. The scripts check for every one of
them before they touch anything, and refuse to run rather than produce a backup
that only looks like one.

In the `Dockerfile`, in the runner stage, **before** it drops to `USER pwuser`:

```dockerfile
# pg_dump refuses to dump a server newer than itself, so the client major
# version is pinned to the one the db service runs. age encrypts the dump;
# mountpoint and flock come from util-linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 age util-linux curl \
    && rm -rf /var/lib/apt/lists/*

COPY docker/backup.sh docker/restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
```

In the compose file, the USB drive bind-mounted into the app service at the same
path `BACKUP_USB_DIR` names, plus the backup variables:

```yaml
    volumes:
      - /mnt/backup:/mnt/backup
    environment:
      BACKUP_AGE_PUBLIC_KEY: ${BACKUP_AGE_PUBLIC_KEY:?set this in .env}
      BACKUP_USB_DIR: /mnt/backup
      BACKUP_HEARTBEAT_URL: ${BACKUP_HEARTBEAT_URL:-}
```

The pre-migration dump is `entrypoint.sh`'s to call, before it migrates:
`BACKUP_LABEL=pre-migration /usr/local/bin/backup.sh`. Failing that dump should
fail the boot — a migration with no dump behind it has no way back.

## The age keypair

Generate it on the **maintainer's workstation**, never on the mini PC:

```sh
age-keygen -o backup-key.txt
# public key: age1... <- this is what the mini PC gets
```

`backup-key.txt` holds both halves. Put it in the password manager alongside the
other secrets in "What the backups do not contain", and delete it from the
workstation's disk. Only the **public** key goes on the mini PC, as
`BACKUP_AGE_PUBLIC_KEY`.

This is the point of the whole arrangement: the mini PC can write backups it
cannot read. A machine that could decrypt its own backups would hand everything
to whoever walked off with it, which is the realistic threat for a drive kept
in the same office. `backup.sh` refuses to start if the value it is given looks
like a private key, because that mistake is unnoticeable once made.

The consequence to accept up front: **lose the private key and every backup ever
taken is unreadable.** There is no recovery path and no support line. Two copies
in two places, one of them not on a computer.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | What gets dumped |
| `BACKUP_AGE_PUBLIC_KEY` | yes | `age1...` recipient, or an `ssh-ed25519`/`ssh-rsa` public key |
| `BACKUP_LOCAL_DIR` | no | Internal copy. Default `/data/backups` |
| `BACKUP_USB_DIR` | no | The USB **mount point** itself. Unset skips the tier |
| `BACKUP_USB_SENTINEL` | no | Filename proving the right volume is mounted. Default `.backup-volume` |
| `BACKUP_UPLOAD_DIR` | no | Directory the SharePoint uploader watches. Unset skips the tier |
| `BACKUP_FILES_DIR` | no | Uploaded files. Default `/data/files` |
| `BACKUP_HEARTBEAT_URL` | no | Dead-man's switch, pinged on success only |
| `BACKUP_RETAIN_HOURLY_HOURS` | no | Default 48 |
| `BACKUP_RETAIN_DAILY_DAYS` | no | Default 30 |
| `BACKUP_LABEL` | no | Goes in the filename. Default `hourly` |

`BACKUP_LABEL` is how the pre-migration dump identifies itself: the entrypoint
runs `BACKUP_LABEL=pre-migration backup.sh` before it migrates, so the dump
taken minutes before a bad schema change is recognisable in a directory listing
months later.

## Preparing the USB drive

ext4, not NTFS or exFAT — permissions and reliability under Linux.

```sh
sudo mkfs.ext4 -L quote-backup /dev/sdX1
sudo mkdir -p /mnt/backup
sudo mount /dev/disk/by-label/quote-backup /mnt/backup
# The script treats a missing sentinel as "the wrong volume is mounted here".
sudo touch /mnt/backup/.backup-volume
# A fresh ext4 volume is owned by root, and the app container does not run as
# root. Without this the mount verifies and then the write fails.
sudo chown -R "$(docker compose exec -T app id -u):$(docker compose exec -T app id -g)" /mnt/backup
```

Mount it by label or UUID in `/etc/fstab`, never by `/dev/sdX` — device names
are assigned in discovery order and a reboot with another drive attached
reorders them. `nofail` so the machine still boots without the drive:

```
LABEL=quote-backup  /mnt/backup  ext4  defaults,nofail  0  2
```

**Why the sentinel exists.** Writing to `/mnt/backup` when nothing is mounted
there succeeds — against the internal disk, at that same path. There would then
be no external backup at all while every log line said there was, and the
internal disk would fill with the copies meant to be elsewhere. `mountpoint -q`
catches an unmounted drive; the sentinel catches a *different* drive mounted
there. Both are checked before the dump starts and again immediately before the
write, and either failing aborts the run without pinging the monitor.

## Scheduling

Hourly, not nightly. The dump is a few megabytes and stays that way for years;
writing it hourly takes the USB recovery point from 24 hours to 1.

Host cron, not cron inside the container — a container is replaced on every
update and takes its crontab with it:

```cron
# Backup, hourly at :17. Off the hour, where everything else runs.
# -T because cron has no TTY.
17 * * * * cd /opt/quote && docker compose exec -T app /usr/local/bin/backup.sh >> /var/log/quote-backup.log 2>&1
```

Failures exit non-zero and print the failing line, so cron mails the reason.
Concurrent runs are prevented with `flock`; running it by hand at any time is
safe.

## The dead-man's switch

Silent failure is the normal way backups fail, and the realistic failure here is
the mini PC being dead or unplugged — a machine in that state reports nothing at
all. So the report is inverted: an external monitor
([healthchecks.io](https://healthchecks.io) or equivalent) expects a ping every
hour and alerts when one does not arrive.

Create a check with a 1-hour period and a generous grace, then set
`BACKUP_HEARTBEAT_URL` to its ping URL. Every failure path in `backup.sh` exits
before the ping, so a broken backup and a dead machine look the same to the
monitor, which is exactly right.

A ping that cannot be sent is logged but does not fail the run: the artifacts
are written and verified, only the report failed, and the monitor alerts on the
missed window anyway.

## Restoring

Pick by failure mode, not by habit:

| Failure | Use | Recovery point |
|---|---|---|
| Bad data, dropped table, bad migration; hardware fine | Internal volume | 1 hour |
| Internal disk failed, machine and USB intact | USB drive | 1 hour |
| Machine dead, USB intact | USB drive on new hardware | 1 hour |
| Machine and USB both gone | The offsite copy | 1 hour |
| A bad migration during an update | The `pre-migration` dump | Minutes |

Every path restores a `pg_dump`, so all of them are byte-exact. Rebuilding from
the SharePoint lists is **not** a restore path — the mirror is for reading.

```sh
# The key is mounted read-only, for this command only, and is not left behind.
docker compose exec -T \
  -e RESTORE_AGE_KEY_FILE=/run/secrets/age.key \
  app /usr/local/bin/restore.sh /data/backups/db-20260904T140000Z-hourly.dump.age
```

`restore.sh` prints what it is about to do before it does anything: the
artifact, when the dump was taken, how many tables it carries, the target
database with its password masked, and every table already in that target with
its row count. Then:

- An **empty** target restores with no further ceremony.
- A target holding anything at all **refuses**, having changed nothing, and
  tells you to re-run with `RESTORE_FORCE=1`. Read the list first: it is what
  you are about to lose. The realistic accident is restoring last week over
  today.
- Forced, it restores with `--clean --if-exists` inside a `--single-transaction`.
  All of it or none of it — a half-restored database is worse than an untouched
  one, because it looks like a database.

Afterwards it prints per-table row counts, and fails if the restore landed zero
rows: a green exit code on an empty database is a failed recovery that reports
success.

Uploaded files are a separate artifact and a separate run:

```sh
docker compose exec -T \
  -e RESTORE_AGE_KEY_FILE=/run/secrets/age.key \
  app /usr/local/bin/restore.sh /data/backups/files-20260904T140000Z-hourly.tar.gz.age
```

A file restore merges: same-named files are overwritten, anything else in the
directory is left alone. Empty the directory first if you need the tree exactly
as it was at that moment.

## The restore drill

**A backup that has never been restored is not a backup.** Two drills, because
they prove different things and neither substitutes for the other.

**Weekly, on the mini PC — the dump and restore round trip.** This runs where
the private key deliberately is not, so it cannot open a stored artifact. It
takes a fresh plaintext dump and restores that into a scratch database, which
proves `pg_dump`/`pg_restore` agree and that the row counts survive:

```sh
docker compose exec -T app bash -c '
  set -euo pipefail
  psql "$DATABASE_URL" -c "create database quote_drill" || true
  pg_dump --format=custom --file=/tmp/drill.dump --dbname="$DATABASE_URL"
  DATABASE_URL="${DATABASE_URL%/*}/quote_drill" RESTORE_FORCE=1 \
    /usr/local/bin/restore.sh /tmp/drill.dump
  rm -f /tmp/drill.dump
  psql "${DATABASE_URL%/*}/postgres" -c "drop database quote_drill"
'
```

Schedule it weekly and send the output somewhere a person sees. It does **not**
prove the stored `.age` artifact can be opened.

**Quarterly, from the maintainer's workstation — that the artifact decrypts.**
This is the only drill that exercises the encryption, and it has to run where
the private key lives:

1. Copy a `db-*.dump.age` off the USB drive or out of the offsite copy.
2. Start a scratch Postgres: `docker run --rm -e POSTGRES_PASSWORD=drill -p 5433:5432 postgres:16-alpine`
3. `DATABASE_URL=postgres://postgres:drill@127.0.0.1:5433/postgres restore.sh --key backup-key.txt db-....dump.age`
4. Read the row counts it prints. Compare them against production.
5. Do the same with the matching `files-*.tar.gz.age` and open a PDF from it.

Write the date and the row counts in the runbook. A drill nobody recorded did
not happen.

## What the backups do not contain

A perfect data restore is useless if nobody can bring the service back up. None
of the following are in a database dump or in the offsite copy, and every one is
needed to stand the system up on new hardware:

- The Cloudflare Tunnel token and the Access application configuration
- The PostgreSQL password
- The Graph certificate and its private key
- **The `age` private key that decrypts every dump**
- The registry `read:packages` token that pulls the image
- `INTERNAL_RENDER_SECRET`

They live in the maintainer's password manager, and the recovery runbook names
each one with where it is used. Secrets never enter the database, because the
database is mirrored and dumped.

Also not backed up, deliberately: the container image (pull it again), the
Postgres data directory as files (the dump is the backup), and anything in
`/tmp`.

## When it goes wrong

| Message | What happened |
|---|---|
| `is not a mount point` | The USB drive is unmounted or unplugged. Nothing was written; fix the drive and the next run catches up. |
| `sentinel ... is missing` | Something is mounted there, but it is not the backup drive. Check what — do not just create the sentinel. |
| `mounted but not writable` | Usually ext4 remounting read-only after an I/O error. Check `dmesg`; the drive may be failing. |
| `the dump contains no table data` | `DATABASE_URL` points at an empty or wrong database. Expected only on a brand-new install. |
| `holds a PRIVATE key` | The private half was pasted into `BACKUP_AGE_PUBLIC_KEY`. Remove it from this machine and from any shell history. |
| `another backup is already running` | A previous run has not finished. Normal if a run is slow; investigate if it persists. |
| Monitor alerted, no cron mail | The machine is off, unplugged, or has no network. This is the case the dead-man's switch exists for. |

An in-app banner covers the same staleness from the other side — last USB
backup older than 2 hours, last upload older than 26 hours — by reading the
newest artifact in each destination. That lives in the application, not in these
scripts.
