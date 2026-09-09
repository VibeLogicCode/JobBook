# Running JobBook on a Synology NAS

**The NAS never builds the image.** That is not a preference: the runtime
stage is the Playwright base image, because the PDF pipeline drives real
Chromium and Playwright refuses to drive a build it did not ship with. That
base is over 2GB, and `next build` on top of it wants more RAM than a DS220+
has. A NAS asked to do this either takes most of an hour or gets OOM-killed
part way, and the failure reads like a broken Dockerfile rather than a small
machine.

So there are two ways to get the image onto the NAS, and everything after
that is identical:

| | Use it when | How the image arrives |
|---|---|---|
| **From the registry** (recommended) | The NAS has internet access | `docker compose pull`, one line of `.env` |
| **From a `.tar`** | No internet on the NAS, or a first install where 2GB over a domestic line is slower than a USB stick | `docker save` elsewhere, `docker load` here |

The registry path is **[Deploying from git](#deploying-from-git)**, three
sections down. The rest of this file is written for the `.tar` path and
applies to both from *Which volume?* onward — you can read it top to bottom
either way.

If you *do* have the source repo somewhere (a laptop, say), `docker/README-
access.md` and `docker/README-backup.md` there go into more depth than this
file repeats. Everything you need for a first Synology install is below,
inline, on purpose — this file does not assume you can get to those.

Everything here targets **x86_64** Synology models running Container Manager
(DSM 7.2+, the package that replaced "Docker"). If your model is ARM (some
smaller `DS2xx`/`DS4xx` units), the image built for this deployment will not
run on it — check **Control Panel > Info Center** for the CPU architecture
before you start.

## Deploying from git

The repository carries the compose file, the `.env.example` and this guide.
The **image** comes from GitHub Container Registry, built by
`.github/workflows/release.yml` on every `v*` tag.

### Once, on the machine that owns the repo

```sh
git tag v0.1.0
git push origin v0.1.0
```

That builds and publishes `ghcr.io/<owner>/jobbook:v0.1.0`. The workflow's
summary prints the exact `docker compose` line to run on the NAS.

**Make the package readable by the NAS.** A GHCR package inherits its
repository's visibility on first publish. For a **private** repo the package
is private too, and the NAS needs to log in:

```sh
# On the NAS. Use a GitHub personal access token with `read:packages` ONLY --
# not a password, and not a token that can write anything.
echo '<token>' | sudo docker login ghcr.io -u '<github-username>' --password-stdin
```

That token sits in `/root/.docker/config.json` on the NAS, base64 but not
encrypted. Scope it to `read:packages`, give it an expiry, and treat it as
something to rotate — it is the one credential this deployment keeps that the
app itself never sees.

For a **public** repo, or a package you set to public in
*Package settings > Change visibility*, no login is needed at all.

### On the NAS

```sh
cd /volume1/docker/jobbook/compose
git clone --depth 1 https://github.com/<owner>/jobbook.git repo
cp repo/deploy/synology/docker-compose.yml .
cp repo/deploy/synology/.env.example .env
```

**Only those two files are needed.** Cloning is a convenient way to get them
onto the NAS and to `git pull` a newer compose file later; nothing runs from
the clone, and `docker compose` is pointed at the copies. If you would rather
not have a source tree on the NAS at all, download those two files instead —
the tar path's *What to copy over* section is exactly that.

Then in `.env`, add the image and fill in the rest as
[Configuring `.env`](#configuring-env) describes:

```sh
JOBBOOK_IMAGE=ghcr.io/<owner>/jobbook:v0.1.0
```

A **version tag, not `latest`.** With a tag you know what is running and can
go back to it; `docker compose pull` on `latest` is an upgrade nobody asked
for, applied whenever the container next restarts — which on a NAS is
whenever DSM decides to install an update.

```sh
sudo docker compose pull
sudo docker compose up -d
```

Skip *Loading the image* below; carry on from *Which volume?*.

### Updating later

```sh
cd /volume1/docker/jobbook/compose
git -C repo pull                     # in case the compose file changed
sed -i 's/jobbook:v0.1.0/jobbook:v0.2.0/' .env
sudo docker compose pull && sudo docker compose up -d
```

**Take a backup first.** Migrations run automatically on start and there is
no down migration — see *Backups* below, and note that the answer to "how do
I go back" is the backup, not the old image: an older image against a
migrated database is a combination nothing has tested.

## What to copy over

Three files, from wherever the image was built to the NAS (USB stick, network
share, `scp` — whatever gets a file onto DSM):

1. **`jobbook.tar`** — the image, produced elsewhere with `docker save
   jobbook:latest -o jobbook.tar`. This step happens on the machine that
   builds the image, not on the NAS; the whole point of this file is that the
   NAS never runs a build.
2. **`docker-compose.yml`** — the file next to this README.
3. **`.env.example`** — the file next to this README. You'll copy it to
   `.env` and fill it in below; the compose file does not read
   `.env.example` directly.

Put all three in the same folder on the NAS, for example
`/volume1/docker/jobbook/compose/`. Where exactly is your call — Container
Manager's Project feature (below) asks you to point at a folder, and this is
the one you'll point it at.

## Loading the image

Reliable path, over SSH (**Control Panel > Terminal & SNMP**, enable SSH
first if it's off):

```sh
ssh admin@<nas-address>
sudo docker load -i /volume1/docker/jobbook/compose/jobbook.tar
```

`docker load` prints the tag it loaded — confirm it says `jobbook:latest`.
If it loaded under a different tag, retag it:

```sh
sudo docker tag <whatever-it-printed> jobbook:latest
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
`JOBBOOK_DATA` in `.env` to match — `/volume2/docker/jobbook` if that is
where yours is. Every path below hangs off it, and the examples say
`/volume1/...` only because something has to be written down.

## The folders make themselves

Nothing to do here — an `init-folders` step in the compose file creates the
four data directories and gives them the right owners before anything else
starts, and every other service waits for it to finish.

It exists because Docker's own behaviour is a trap. It *does* create a missing
bind-mount source, but as `root:root`, and neither Postgres nor the app runs as
root — so the folders appear, the containers start, and the database fails to
initialise with an error that reads like a broken database rather than a
permissions problem. Three lines of `mkdir` and `chown` over SSH would fix it,
which is fine once and wrong for something installed more than once.

The four live under whatever `JOBBOOK_DATA` names:

- `db` — every quote, customer and rate. **This is the one that matters.**
- `files` — uploaded receipts and the letterhead logo
- `backups` — where the backup job writes
- `config` — what the setup wizard persists

Bind mounts under a folder you chose, deliberately, rather than Docker named
volumes: a named volume lives somewhere File Station cannot browse and a
Container Manager "reset project" can quietly take with it.

## Configuring `.env`

```sh
cp /volume1/docker/jobbook/compose/.env.example /volume1/docker/jobbook/compose/.env
```

Then edit `.env` and set, at minimum:

| Variable | What to set it to |
|---|---|
| `JOBBOOK_DATA` | The folder every bind mount hangs off. `/volume1/docker/jobbook` unless Container Manager lives on another volume — see above. |
| `POSTGRES_PASSWORD` | Output of `openssl rand -hex 32`. The compose file refuses to start without this. |
| `INTERNAL_RENDER_SECRET` | Output of `openssl rand -hex 48`. Also required to start. |
| `JOBBOOK_IMAGE` | Registry path only — `ghcr.io/<owner>/jobbook:v0.1.0`. Leave it out entirely for the `.tar` path. |
| `LOCAL_USER_EMAIL` | **Optional.** Leave it blank and the app signs you in as the single active user it finds, which on a fresh install is whoever the wizard created. Set it only if this deployment has several accounts and you want one specific address treated as the local user. |
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
2. Once confirmed: stop the stack, **wipe** `/volume1/docker/jobbook/db`
   (`sudo docker compose down` then `sudo rm -rf
   /volume1/docker/jobbook/db/*`), set `SEED_DEMO=0` in `.env`, and start
   again clean.
3. Only then run the first-run setup wizard with the real company's details.

If real data already went in alongside the demo seed, restoring from a
backup taken *before* that happened is the way back — which is the other
reason the next section is not optional.

## Starting it

Reliable path, over SSH, from the folder holding the three files:

```sh
cd /volume1/docker/jobbook/compose
sudo docker compose up -d
```

Container Manager's **Project** tab (DSM 7.2+) can also create a project
from this same folder — **Project > Create > Create docker-compose.yml >
Path**, pointing at `/volume1/docker/jobbook/compose`. If it complains
about the `name: jobbook` line near the top of `docker-compose.yml`,
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

1. **Generate the key in the app: Settings > Backups > Generate a backup
   key.**

   No `age-keygen`, no second machine, no shell. The screen shows the private
   half **once** and never stores it — not in the database, not in
   `/data/config`, not in the logs. It writes only the public half, which is
   what the backup container needs.

   **Put the private half in a password manager before you leave that page.**
   There is no way to get it back. That is the point — see the warning below.

   An earlier version of this guide told you to run `age-keygen` on another
   machine and paste the public half into `.env`. That instruction was
   correct and almost nobody would follow it: it needs a tool you do not
   have, on a computer you are not looking at, in the middle of setting up a
   NAS. The observed result was an empty `BACKUP_AGE_PUBLIC_KEY` and a
   deployment taking no backups at all.

   The `.env` route still works and is still read — set
   `BACKUP_AGE_PUBLIC_KEY` there and it wins over the file. Use it if you
   already run `age` and would rather keep key management where the rest of
   your keys live.

2. **You are the only person who can read these backups, and nobody can get
   the key back for you.**

   This NAS writes backups it cannot itself read, which is why a stolen or
   improperly decommissioned NAS yields no customer data. The other side of
   that: lose the private half and you lose every backup you have taken, and
   you find out on the day you need one. There is no recovery path and no
   support call that can help, by design.

   Leave the key unset and the deployment takes **no backups at all** — it
   says so, loudly, in the logs on every boot and every hourly attempt. A
   real choice for kicking the tyres; not one to still be true once real
   customer data is in.

3. **No restart needed** when the key comes from the app: it is written to
   `/data/config`, which the backup container reads on every run — mounted
   read-only, so the container that encrypts cannot rewrite what it encrypts
   to. If you set `BACKUP_AGE_PUBLIC_KEY` in `.env` instead, that one **does**
   need `sudo docker compose up -d` again, because the environment is read at
   container start.

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

Open `http://<this NAS's LAN address>:<APP_PORT>` in a browser (the default
`APP_PORT` is `38080`). With no company yet it takes you straight to the
wizard — you do not have to know the `/setup` URL.

It walks through, in this order:

1. **Company** — the names on every document.
2. **Contact** — the address block a customer reads.
3. **Your work** — service work, contract work or both, and your trade. This
   one loads your starting lists: job types, cost codes and a rate-book
   skeleton. **The rate book arrives with no prices in it**, deliberately: a
   rate book of numbers the software guessed looks authoritative, and the app
   refuses to put an unpriced line on a quote, so an item you have not got to
   yet cannot reach a customer.
4. **Locale** — currency, language, timezone, area unit. The timezone decides
   what date a quote carries, which is why it is asked before the first quote
   exists.
5. **Financial** — tax registration, fiscal year, holdback, payment terms,
   margin.
6. **Tax rate** — the first rate and the date it took effect.
7. **First user** — the owner's own account. This is the `users` row the app
   signs you in as; with `LOCAL_USER_EMAIL` blank it finds this one on its
   own.
8. **Access** — where this deployment sits on the network and who may reach
   it. Read it rather than clicking through: the software cannot tell whether
   this machine is reachable from the internet, and the wrong answer here
   hands the company away.
9. **Environment** — a read-only report of what the deployment has and what it
   is missing. Collects nothing, because a credential in a form is a
   credential in every backup.

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

1. Copy the new `jobbook.tar` onto the NAS, same as the first time.
2. Load it — this replaces what `jobbook:latest` points to:
   ```sh
   sudo docker load -i /volume1/docker/jobbook/compose/jobbook.tar
   ```
3. Recreate the containers that use it (loading the image alone does not
   restart anything already running):
   ```sh
   cd /volume1/docker/jobbook/compose
   sudo docker compose up -d --force-recreate app backup reminders
   ```
   `db` is deliberately left out of that command — it's a different image
   (`postgres:16-alpine`) that a JobBook update never touches, and
   recreating it is an unnecessary restart of the database for no reason.
4. `sudo docker compose logs -f app` — the boot sequence takes a
   pre-migration backup automatically (if `BACKUP_AGE_PUBLIC_KEY` is set)
   and applies any new database migrations before serving traffic. Watch for
   that to finish before calling the update done.

## Getting your data back out

Two kinds of artifact, and a real recovery needs both: `db-*.dump.age` (the
database) and `files-*.tar.gz.age` (uploaded receipts, logos, generated
PDFs — a restored database whose file references point at nothing is only
half a recovery). Both live in `/volume1/docker/jobbook/backups` and,
if configured, on the USB drive.

**Do not treat copying `/volume1/docker/jobbook/db` itself as a backup.**
That directory is Postgres's live, running data files — not a portable
artifact, and not what the `db-*.dump.age` files above are for.

Restoring needs the **private** half of the age key — the
`AGE-SECRET-KEY-...` string the app showed you once, on
*Settings > Backups*. By design it is nowhere on this NAS and nowhere in the
database, so it comes from wherever you put it: a password manager, a printed
copy in a safe.

Get it onto the NAS *temporarily*, for this operation only — `scp`, or a USB
stick, and not left in an email or a chat. Save it to a file, one line, no
trailing spaces:

```sh
cd /volume1/docker/jobbook/compose

# Into the container, not just onto the NAS's own disk:
sudo docker compose cp /path/to/age.key app:/data/config/age.key
sudo docker compose exec -T --user root app chown pwuser:pwuser /data/config/age.key

sudo docker compose exec -T \
  -e RESTORE_AGE_KEY_FILE=/data/config/age.key \
  app /usr/local/bin/restore.sh /data/backups/db-<timestamp>-<label>.dump.age

# Remove it from both places the moment the restore is done:
sudo docker compose exec -T app rm -f /data/config/age.key
rm -f /path/to/age.key
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
