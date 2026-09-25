# JobBook

Quoting, documents and job costing for a general contractor. Square footage and
room counts in, a priced quote out, a PDF the customer signs, and a record of
what it cost.

Self-hosted: one container plus PostgreSQL on a mini PC. No per-seat licence,
no cloud bill, no data leaving the box unless the operator turns the SharePoint
mirror on.

The name is the product's, not a customer's. Every company-specific string —
name, address, tax number, logo, terms, tax rates — lives in the `companies`
record and is set at setup. A test fails the build if a tenant's details
appear in the source.

**One deployment can issue documents as two companies.** Sister corporations
under one owner share customers, the rate book and the subcontractor list, and
each keeps its own legal name, HST registration number and document series.
`organization` holds what the deployment owns — timezone, currency, units;
`companies` holds what a legal person owns. A job belongs to one company and
never moves, which is what lets every document under it resolve its letterhead
through one join.

**A company says what kind of work it does** — service, contract, or both —
and each job type carries the paperwork that kind of work needs: holdback,
progress draws, a schedule, Construction Act dates. A service call does not
withhold a holdback nobody agreed to. Starter packs for general
contracting, electrical, plumbing, HVAC and machine shop work give a fresh
install job types, cost codes, a rate-book skeleton, the quote templates that
trade writes weekly and its standard exclusions — instead of five empty
lists, and **with no prices in it**, on purpose. A quote cannot be sent while a
line on it has no price, which is what makes shipping an unpriced rate book
safe. Another trade's lists can be added later from Settings; that path adds
only, and never retires or reprices anything.

## Installing it

One line, on Windows:

```powershell
irm https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/windows.ps1 | iex
```

One line, on a Synology, QNAP or any Linux box:

```sh
curl -fsSL https://raw.githubusercontent.com/VibeLogicCode/JobBook/main/install/nas.sh | sh
```

Both check Docker, generate the two passwords, pull the image, start it and hand
you an address. [INSTALL.md](INSTALL.md) has the no-terminal Synology path, what
the first run asks you, updating, backups and the x86_64 requirement.

## Running it from source

```bash
cp .env.example .env          # then set INTERNAL_RENDER_SECRET to something long
docker compose -f docker-compose.app.yml up -d --build
```

Then open `http://localhost:3000`, or the machine's LAN address from a phone on
the same network. The container waits for the database, applies migrations, and
on a first run loads a fictional demo tenant so there is something to click.
Set `SEED_DEMO=0` before real data goes in.

**Authentication is off in that configuration.** `AUTH_MODE=local` treats every
visitor as one named user, which is correct for a LAN under test and wrong for
anything reachable from the internet. Production runs behind Cloudflare Tunnel
with Access in front, or with in-app SSO; the code refuses to run two modes at
once, because a half-configured tunnel quietly treating strangers as the owner
is the failure that guards against.

## Developing

```bash
npm install
npx playwright install chromium   # the PDF pipeline and its test need it
docker compose up -d db       # Postgres on 127.0.0.1:5433
npm run db:migrate            # both databases: development and test
npm run db:seed
npm run dev
```

```bash
npm test                      # unit, database, and integration
npm run typecheck
```

The PDF suite launches real Chromium, so `npx playwright install chromium` has
to have been run once on the machine. The container needs no such step -- its
base image carries the browser, pinned to the same version as the library,
because Playwright refuses to drive a build it did not ship with.

**One test run at a time.** The database suites truncate shared tables, so two
concurrent runs against the same `quote_test` deadlock: one holds an
`AccessExclusiveLock` for the truncate while the other holds a row lock through
the audit trigger. The failures look like logic bugs, land in whichever file
lost the race, and vanish on a re-run. `fileParallelism` is already off inside
a run; this is about not starting a second one.

The test suite connects to `TEST_DATABASE_URL`, not `DATABASE_URL`. Database
suites truncate tables, so a client that only knew `DATABASE_URL` would empty
the development database on the first run. Create it once:

```bash
docker compose exec db psql -U quote -d quote -c 'create database quote_test'
npm run db:migrate
```

`db:migrate` applies to **both** databases. It used to apply to one, with a
footnote here saying to repeat the command by hand — and a footnote is not a
mechanism. Migration 0016 reached `quote` and not `quote_test`, and the suite
returned eighteen failures reading `column "trade_id" does not exist`, which
looks like a broken migration rather than a forgotten command.

`db:migrate:dev` is there for the rare case you want the development database
alone.

## Deploying it

`deploy/synology/README.md` is the full guide for a Synology NAS, which is the
target this is built for. The short version:

**The NAS does not build the image.** The runtime stage is the Playwright base
image, because the PDF pipeline drives real Chromium — over 2GB, and `next
build` on top of it wants more RAM than a small NAS has. Push a `v*` tag and
`.github/workflows/release.yml` builds and publishes to GitHub Container
Registry; the NAS runs `docker compose pull`. `docker save` to a `.tar` still
works for a NAS with no internet.

## Layout

| Path | What is in it |
|---|---|
| `src/lib/money` | Scaled-integer arithmetic. Money is integer cents, quantities thousandths, rates ten-thousandths |
| `src/lib/quote` | The pricing engine: lines, percent lines, tax, totals, templates, numbering, the repository |
| `src/db` | Drizzle schema, enums, shared audit columns, demo seed |
| `drizzle` | Migrations, including the triggers and the no-DELETE grant |
| `src/app` | Next.js routes, the worksheet, and the print document |
| `src/db/seed/packs` | Trade starter packs. Content, and the loader that retires what a pack does not want |
| `src/lib/company` | Which company issues a document, and the code on its numbers |
| `src/lib/posture` | Service work against contract work, and the per-job-type flags |
| `docker` | Container entrypoint, backup and restore |
| `deploy/synology` | The NAS deployment: compose file, `.env.example`, and the guide |
| `docs/superpowers` | Specifications and plans. Read these before changing behaviour |

## Two rules that explain most of the code

**Nothing is ever deleted.** Voiding sets `record_status = 'void'` with a
reason. The application's database role is not granted `DELETE`, so an
accidental delete fails as a permission error rather than destroying a tax
record — and a watermark-based sync cannot observe a row that no longer exists.

**Money never passes through a float.** Products are computed in `BigInt` and
rounded once, half away from zero, at the line boundary. Tax is computed on the
summed taxable base and rounded once, never per line: rounding each line drifts
a cent every few lines, which is enough to make a customer's own arithmetic
disagree with the printed document.
