# Running Scopeline on a Synology NAS

For a deployment with **no git, no source tree, and no `docker build` on the
NAS** — you copy a `.tar` image file over, load it, and start it. Written for
doing this once, at night, without the repository in front of you.

If you *do* have the source repo somewhere (a laptop, say), `docker/README-
access.md` and `docker/README-backup.md` there go into more depth than this
file repeats. Everything you need for a first Synology install is below,
inline, on purpose — this file does not assume you can get to those.

Everything here targets **x86_64** Synology models running Container Manager
(DSM 7.2+, the package that replaced "Docker"). If your model is ARM (some
smaller `DS2xx`/`DS4xx` units), the image built for this deployment will not
run on it — check **Control Panel > Info Center** for the CPU architecture
before you start.

## What to copy over

Three files, from wherever the image was built to the NAS (USB stick, network
share, `scp` — whatever gets a file onto DSM):

1. **`scopeline.tar`** — the image, produced elsewhere with `docker save
   scopeline:latest -o scopeline.tar`. This step happens on the machine that
   builds the image, not on the NAS; the whole point of this file is that the
   NAS never runs a build.
2. **`docker-compose.yml`** — the file next to this README.
3. **`.env.example`** — the file next to this README. You'll copy it to
   `.env` and fill it in below; the compose file does not read
   `.env.example` directly.

Put all three in the same folder on the NAS, for example
`/volume1/docker/scopeline/compose/`. Where exactly is your call — Container
Manager's Project feature (below) asks you to point at a folder, and this is
the one you'll point it at.

## Loading the image

Reliable path, over SSH (**Control Panel > Terminal & SNMP**, enable SSH
first if it's off):

```sh
ssh admin@<nas-address>
sudo docker load -i /volume1/docker/scopeline/compose/scopeline.tar
```

`docker load` prints the tag it loaded — confirm it says `scopeline:latest`.
If it loaded under a different tag, retag it:

```sh
sudo docker tag <whatever-it-printed> scopeline:latest
```

Container Manager (DSM 7.2+) also has an **Image** tab with an **Add > Add
From File** action that does the same import through the GUI. That menu path
is accurate as of recent DSM 7.2 releases, but Synology has moved things
between versions before, so if it doesn't match what you see, trust the SSH
command above over this description — it does not depend on which DSM
version you're running.

## Which volume?

**Check this before you create anything.** A Synology's first storage volume
is `/volume1`, but that is not always where Container Manager was installed —
a NAS whose packages went onto a second pool keeps them under `/volume2`.
Pointing a bind mount at a volume the package does not live on surfaces later
as a database that will not start, which is a poor way to learn it.

Look at **Package Center > Container Manager** (or Storage Manager) and set
`SCOPELINE_DATA` in `.env` to match — `/volume2/docker/scopeline` if that is
where yours is. Every path below hangs off it, and the examples say
`/volume1/...` only because something has to be written down.

## Creating the folders

Do this before the first `up`, not after. Bind mounts (below) do not create
missing parent directories reliably, and Postgres refuses to initialize into
a directory it doesn't like the permissions on.

```sh
sudo mkdir -p \
  /volume1/docker/scopeline/db \
  /volume1/docker/scopeline/files \
  /volume1/docker/scopeline/backups \
  /volume1/docker/scopeline/config
```

These four map directly to `docker-compose.yml`'s bind mounts — deliberately
**not** Docker named volumes. A named volume lives somewhere under
`/var/lib/docker/volumes/` that File Station cannot browse and a Container
Manager "reset project" can quietly take with it. A folder under
`/volume1/docker/scopeline/` is one you can see, back up by hand, and find
again in six months. The database directory (`db`) is the one that matters
most — it is where every quote, customer and rate table actually lives.

If containers later fail to start with permission errors on `/data/files`,
`/data/backups` or `/data/config`, the app runs as a non-root user baked into
the image (`pwuser`). Find its numeric ID and match the folder ownership to
it:

```sh
sudo docker run --rm scopeline:latest id -u pwuser   # prints a number, e.g. 1000
sudo chown -R 1000:1000 /volume1/docker/scopeline/files /volume1/docker/scopeline/backups /volume1/docker/scopeline/config
```

(Postgres's own image manages the ownership of `db` itself on first start —
leave that one alone unless it specifically complains.)

## Configuring `.env`

```sh
cp /volume1/docker/scopeline/compose/.env.example /volume1/docker/scopeline/compose/.env
```

Then edit `.env` and set, at minimum:

| Variable | What to set it to |
|---|---|
| `SCOPELINE_DATA` | The folder every bind mount hangs off. `/volume1/docker/scopeline` unless Container Manager lives on another volume — see above. |
| `POSTGRES_PASSWORD` | Output of `openssl rand -base64 32`. The compose file refuses to start without this. |
| `INTERNAL_RENDER_SECRET` | Output of `openssl rand -base64 48`. Also required to start. |
| `LOCAL_USER_EMAIL` | The address you'll sign in as. See the note below — what this needs to be depends on `SEED_DEMO`. |
| `APP_PORT` | Only if the default (`38080`) collides with something else already running on this NAS. |

Everything else in `.env.example` has a workable default or is optional (the
backup variables) — read the comments there, they carry the reasoning.

### `SEED_DEMO` — read this before you go further

`SEED_DEMO=1` (the default) loads a **fictional demo company** on first boot,
so there's something on screen to confirm the deployment works — fake
customers, fake quotes, fake dollar figures.

**It must be `0` before any real customer's data goes into this
deployment.** Leaving it at `1` doesn't just add clutter next to real
records — with a fresh database it loads a fictional tenant *as the tenant*,
and every quote and price you enter afterward sits in the same company
record as fabricated demo data. There is no supported way to strip the demo
tenant back out of a database that also holds real rows.

The sequence that avoids this:

1. First boot: leave `SEED_DEMO=1`, confirm the deployment works (next
   sections).
2. Once confirmed: stop the stack, **wipe** `/volume1/docker/scopeline/db`
   (`sudo docker compose down` then `sudo rm -rf
   /volume1/docker/scopeline/db/*`), set `SEED_DEMO=0` in `.env`, and start
   again clean.
3. Only then run the first-run setup wizard with the real company's details.

If real data already went in alongside the demo seed, restoring from a
backup taken *before* that happened is the way back — which is the other
reason the next section is not optional.

## Starting it

Reliable path, over SSH, from the folder holding the three files:

```sh
cd /volume1/docker/scopeline/compose
sudo docker compose up -d
```

Container Manager's **Project** tab (DSM 7.2+) can also create a project
from this same folder — **Project > Create > Create docker-compose.yml >
Path**, pointing at `/volume1/docker/scopeline/compose`. If it complains
about the `name: scopeline` line near the top of `docker-compose.yml`,
delete that one line and try again — it only sets the label Docker groups
these containers under, and Container Manager assigns its own regardless.
As with the image import, this UI description may not match your exact DSM
version; the SSH command above is the one to fall back on.

First boot takes a minute or two: Postgres initializes, the app waits for
it, applies its database migrations, and (if `SEED_DEMO=1`) loads the demo
tenant. `sudo docker compose logs -f app` shows that happening.

## Backups — set this up now, not after real data goes in

This is not optional, and it is not something to come back to later. A
database with no backup is one bad migration, one failed drive, or one
`SEED_DEMO` mistake (above) away from starting over from nothing.

The image already carries everything needed — `pg_dump`, `age`, and the
backup/restore scripts — nothing further to install.

1. **Generate an `age` keypair, on a workstation — never on this NAS:**

   ```sh
   age-keygen -o backup-key.txt
   # Public key: age1...   <- this is what the NAS gets
   ```

   Put `backup-key.txt` (both halves) in a password manager, then delete it
   from the workstation's disk. Only the **public** half — the `age1...`
   line — goes on the NAS, as `BACKUP_AGE_PUBLIC_KEY` in `.env`.

2. **Why a public key and not a shared secret:** this NAS writes backups it
   cannot itself read. A stolen or improperly decommissioned NAS yields no
   customer data, because the key that would decrypt the backups was never
   on it. Leave `BACKUP_AGE_PUBLIC_KEY` unset and the deployment takes **no
   backups at all** — it says so, loudly, in the logs on every boot and
   every hourly attempt. That is a real, supported choice for kicking the
   tyres; it is not one to still be true once real customer data is in.

3. **Restart after setting the key** (`sudo docker compose up -d` again —
   the key is read from the environment at container start, an already-
   running container does not pick it up).

4. **Second copy, off this NAS's disk.** If a USB drive is attached to the
   NAS, format it ext4 (not NTFS/exFAT), find its mount path with `ls
   /volumeUSB1` over SSH, uncomment the `/volumeUSB1/...` bind-mount lines
   in `docker-compose.yml` for both the `app` and `backup` services, and set
   `BACKUP_USB_DIR` in `.env` to the same path. Without this, the only copy
   of every backup sits on the same disk as the database it protects — the
   backup container says so on every run, deliberately, because that is a
   decision to make on purpose rather than by default.

5. **A dead-man's switch.** Set `BACKUP_HEARTBEAT_URL` to a ping URL from
   [healthchecks.io](https://healthchecks.io) or similar, with an hourly
   period. A NAS that is off, disconnected, or dead reports nothing on its
   own — the monitor is what notices the silence.

6. **Prove it works, once, before trusting it.** After the stack has been up
   an hour:

   ```sh
   sudo docker compose exec -T backup ls -la /data/backups
   ```

   should show a `db-*.dump.age` and `files-*.tar.gz.age` pair. That
   confirms a backup was *taken*; it does not confirm it can be *restored* —
   only an actual restore does that (see "Getting your data back out",
   below).

**The unresolved question this doesn't paper over:** the public/private
split above means the private key — the only thing that can ever decrypt
these backups — lives with whoever generated it, off this NAS. That is
correct for protecting against a stolen box, but it is also, deliberately,
an open question the maintainer has flagged and not yet answered: if the
owner ever wants to walk away holding readable backups of his own company's
data, the current design does not give him a private key of his own — he'd
hold an encrypted USB drive he cannot open. There is a proposal on the table
(a second recipient, so both the maintainer and the owner hold a private
half) but it is not decided, and it is partly a legal question, not only a
technical one. If that matters to you, raise it with whoever set this up
rather than assuming it is already handled.

## The first-run setup wizard

Open `http://<this NAS's LAN address>:<APP_PORT>/setup` in a browser (the
default `APP_PORT` is `38080`). It walks through, in this order: company
details, contact info shown on quotes, locale (currency/timezone), financial
settings (tax registration, fiscal year, holdback, margin), the first tax
rate, and finally the owner's own user account — the "first user" step,
which is what creates the `users` row that `LOCAL_USER_EMAIL` in `.env`
needs to match.

Each step is its own URL, so a browser crash or a closed laptop lid resumes
where it left off rather than losing the form. A finished setup, or a
`SEED_DEMO=1` demo tenant already in place, redirects away from the wizard
entirely — which is why the "wipe the database and start clean" step above
comes *before* running this wizard for real, not after.

## Checking it worked

```sh
sudo docker compose ps
```

All four containers (`db`, `app`, `backup`, `reminders`) should show
`Up`/`healthy` — except `backup`, which shows `Up` only once
`BACKUP_AGE_PUBLIC_KEY` is set; with no key it exits with status 1 by
design (see Backups, above), so a `db`/`app`/`reminders` all healthy plus
`backup Exited (1)` is the *expected* state of an install with backups not
yet configured, not a fault to chase.

```sh
curl -s http://127.0.0.1:<APP_PORT>/api/health
```

run from the NAS itself (over SSH) should return `{"ok":true}`. From a
browser on another device on the LAN, `http://<nas-address>:<APP_PORT>/`
should load the dashboard (or redirect to `/setup` on a fresh install).

## Updating later, with a new `.tar`

1. Copy the new `scopeline.tar` onto the NAS, same as the first time.
2. Load it — this replaces what `scopeline:latest` points to:
   ```sh
   sudo docker load -i /volume1/docker/scopeline/compose/scopeline.tar
   ```
3. Recreate the containers that use it (loading the image alone does not
   restart anything already running):
   ```sh
   cd /volume1/docker/scopeline/compose
   sudo docker compose up -d --force-recreate app backup reminders
   ```
   `db` is deliberately left out of that command — it's a different image
   (`postgres:16-alpine`) that a Scopeline update never touches, and
   recreating it is an unnecessary restart of the database for no reason.
4. `sudo docker compose logs -f app` — the boot sequence takes a
   pre-migration backup automatically (if `BACKUP_AGE_PUBLIC_KEY` is set)
   and applies any new database migrations before serving traffic. Watch for
   that to finish before calling the update done.

## Getting your data back out

Two kinds of artifact, and a real recovery needs both: `db-*.dump.age` (the
database) and `files-*.tar.gz.age` (uploaded receipts, logos, generated
PDFs — a restored database whose file references point at nothing is only
half a recovery). Both live in `/volume1/docker/scopeline/backups` and,
if configured, on the USB drive.

**Do not treat copying `/volume1/docker/scopeline/db` itself as a backup.**
That directory is Postgres's live, running data files — not a portable
artifact, and not what the `db-*.dump.age` files above are for.

Restoring needs the **private** half of the age key, which by design lives
only with whoever ran `age-keygen` — never on this NAS. Get a copy of
`backup-key.txt` onto the NAS *temporarily*, for this operation only (`scp`
from the password manager's holder, or a USB stick — not left in an email
or a chat), then:

```sh
cd /volume1/docker/scopeline/compose

# Into the container, not just onto the NAS's own disk:
sudo docker compose cp /path/to/backup-key.txt app:/data/config/age.key
sudo docker compose exec -T --user root app chown pwuser:pwuser /data/config/age.key

sudo docker compose exec -T \
  -e RESTORE_AGE_KEY_FILE=/data/config/age.key \
  app /usr/local/bin/restore.sh /data/backups/db-<timestamp>-<label>.dump.age

# Remove it from both places the moment the restore is done:
sudo docker compose exec -T app rm -f /data/config/age.key
rm -f /path/to/backup-key.txt
```

It prints exactly what it's about to do — the artifact, when it was taken,
the target database and what's already in it — before touching anything,
and it refuses to write over a database that already holds data unless you
re-run it with `RESTORE_FORCE=1`. Restoring the matching `files-*.tar.gz.age`
is the same command, pointed at that artifact instead.

A backup that has never been restored is not a backup — run this once,
against a scratch database, before you need it for real. The reasoning
behind every choice in `backup.sh`/`restore.sh`, the full restore-drill
schedule, and what to do when something goes wrong live in
`docker/README-backup.md` in the source repo, if you have access to it; the
essentials for a first install are all above.
