# Scopeline

Quoting, documents and job costing for a general contractor. Square footage and
room counts in, a priced quote out, a PDF the customer signs, and a record of
what it cost.

Self-hosted: one container plus PostgreSQL on a mini PC. No per-seat licence,
no cloud bill, no data leaving the box unless the operator turns the SharePoint
mirror on.

The name is the product's, not a customer's. Every company-specific string —
name, address, tax number, logo, terms, tax rates — lives in the
`organization` record and is set at setup. A test fails the build if a tenant's
details appear in the source.

## Running it

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
docker compose up -d db       # Postgres on 127.0.0.1:5433
npm run db:migrate            # then repeat against TEST_DATABASE_URL
npm run db:seed
npm run dev
```

```bash
npm test                      # unit, database, and integration
npm run typecheck
```

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
DATABASE_URL="$TEST_DATABASE_URL" npx drizzle-kit migrate
```

## Layout

| Path | What is in it |
|---|---|
| `src/lib/money` | Scaled-integer arithmetic. Money is integer cents, quantities thousandths, rates ten-thousandths |
| `src/lib/quote` | The pricing engine: lines, percent lines, tax, totals, templates, numbering, the repository |
| `src/db` | Drizzle schema, enums, shared audit columns, demo seed |
| `drizzle` | Migrations, including the triggers and the no-DELETE grant |
| `src/app` | Next.js routes, the worksheet, and the print document |
| `docker` | Container entrypoint, backup and restore |
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
