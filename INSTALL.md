# Installing JobBook

JobBook runs on your own machine: two containers, one folder, no cloud account and no
subscription. Nothing leaves the box unless you turn on a backup destination or the SharePoint
mirror yourself.

Pick the path that matches where you want it. Each one ends with an address you can open.

---

## Windows — one line

Open **PowerShell** and paste:

```powershell
irm https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/windows.ps1 | iex
```

It checks Docker, makes a folder, generates the passwords, downloads JobBook, starts it, waits
for it to answer, and opens your browser. Two questions, both with sensible defaults: where to
put it, and which port.

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) first — it is free,
and it is the only thing JobBook needs on Windows. The script says so and offers to open the
download page if it is missing.

---

## Synology, QNAP or any Linux box — one line

SSH in as an administrator and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/nas.sh | sh
```

Same thing: checks Docker, picks `/volume1/docker/jobbook` on a Synology (or `/share/Container`
on a QNAP), generates the passwords, pulls, starts, and prints the address to open from your
phone.

Piping a script from the internet into a shell deserves a moment's thought. If you would rather
read it first — and that is the right instinct:

```sh
curl -fsSLO https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/nas.sh
less nas.sh && sh nas.sh
```

---

## Synology without SSH — Container Manager

If you would rather not touch a terminal:

1. Open **File Station** and make a folder: `docker/jobbook`, with `data` inside it.
2. Download [`install/docker-compose.yml`](install/docker-compose.yml) and upload it into
   `docker/jobbook`.
3. Make a file called `.env` beside it, with these four lines — replacing the two passwords with
   long random strings of your own:

   ```sh
   POSTGRES_PASSWORD=change-this-to-something-long-and-random
   INTERNAL_RENDER_SECRET=change-this-to-something-else-long-and-random
   JOBBOOK_DATA=/volume1/docker/jobbook/data
   APP_PORT=38080
   ```

4. **Container Manager → Project → Create**, point it at `docker/jobbook`, and start it.
5. Open `http://<your NAS address>:38080`.

Those two passwords are never typed again. The first is how the app opens its own database; the
second signs the internal request that renders a PDF. Keep the file.

---

## What you need

| | |
|---|---|
| **Processor** | x86_64 (Intel or AMD). Any NAS with a Celeron, Pentium, i3 or Ryzen, or any ordinary PC. |
| **Not supported** | ARM. The DS220j, DS223 and similar Realtek/ARM Synology models cannot run this image. |
| **Memory** | About 2 GB free. |
| **Disk** | About 3 GB for the image, plus your own records — a few MB a year. |

**Why x86_64 only:** the PDF your customer signs is rendered by a real Chromium inside the
image, and that build is amd64. An ARM machine would need emulation, which is slow enough to
turn a quote into a wait.

---

## The first run

The first boot takes a minute or two: it waits for the database, applies every migration, and
only then starts serving. After that, opening the address drops you into a ten-step setup that
asks for your company, what kind of work you do, your trade, your tax rate and your first user.

Two of those answers shape the rest:

- **What kind of work you do** — service, contract, or both. It decides which job types you are
  offered and what your forms carry: a service call does not withhold a holdback nobody agreed
  to.
- **What you want to start with** — just quotes and invoices, or everything. Starting small hides
  the pipeline, calendar, expenses, vendors, templates and reminders until you want them.
  Nothing is deleted by that choice and nothing is migrated when you turn a part back on.

Both are changeable afterwards under **Settings**.

Your trade also loads a starter pack: job types, cost codes, a rate-book skeleton, the quote
templates that trade writes weekly, and its standard exclusions. **The rate book arrives with no
prices in it, deliberately** — a price this software guessed would lose you the job or lose you
money. A quote cannot be sent while a line on it has no price, so an item you have not got to
yet cannot reach a customer.

---

## Who can reach it

Out of the box, `AUTH_MODE=local` treats **every visitor as the owner**. That is correct for a
machine on your own network and wrong for anything reachable from the internet.

**Do not port-forward it.** When you want it from outside, `docker/README-access.md` covers
Cloudflare Tunnel and in-app sign-in. The app refuses to run two authentication modes at once
rather than quietly treating a stranger as you.

---

## Updating

```powershell
irm https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/update.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/update.sh | sh
```

It pulls the newest image and restarts. Your `.env` is never touched — the database password
stays what it was — and your data folder is untouched, because an update replaces the program
and not the records. Migrations run at boot, and the app does not serve until they finish.

To stay on a version you have tested, set the image explicitly in `.env`:

```sh
JOBBOOK_IMAGE=ghcr.io/vibelogiccode/jobbook:v0.1.0
```

---

## Backups

Backups are **off** until you give the machine a public key, and the design is deliberate: the
box writes backups it cannot itself read.

On a workstation — not on the NAS:

```sh
age-keygen -o backup-key.txt
```

Put the **public** half (`age1...`) in `.env` as `BACKUP_AGE_PUBLIC_KEY`, and keep the private
half in a password manager. Without it, nothing is encrypted and the boot log says so; without
the private half, nothing can ever be restored.

Whatever else you do, **back up the `data` folder**. That is the whole business: the database,
the uploaded files, and the deployment's configuration.

---

## Stopping, starting, removing

```sh
cd <your install folder>
docker compose down      # stop
docker compose up -d     # start again
```

To remove it entirely, stop it and delete the folder. Nothing lives anywhere else — no registry
keys, no system services, no files outside that folder.

---

## If something goes wrong

**"unauthorized" when pulling** — the image is not published publicly yet. See the maintainer
note below.

**The page says the database is not answering** — the app is running and PostgreSQL is not.
Check both containers are started; after a power cut the database can take a minute to open its
files.

**It does not answer at all** — watch it boot:

```sh
cd <your install folder>
docker compose logs -f app
```

---

## Maintainer note: publishing the image

**One-time, manual, and every instruction above depends on it.** GitHub Container Registry
packages are **private by default**, so the first `docker pull` fails for everyone but the owner
with `unauthorized`.

After the release workflow's first successful run:

1. Open <https://github.com/VibeLogicCode/JobBook/pkgs/container/jobbook>
2. **Package settings → Danger Zone → Change visibility → Public**

Publishing a new version is a tag:

```sh
git tag -a v0.2.0 -m "what changed"
git push origin v0.2.0
```

`.github/workflows/release.yml` runs the full test suite first and only then builds and pushes
`:v0.2.0` and `:latest`. The NAS does not build the image — the runtime stage is the Playwright
base image and `next build` on top of it wants more memory than a small NAS has.
