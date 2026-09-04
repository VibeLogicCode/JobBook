# Distribution and Updates

**Companion to** `2026-08-30-maple-quote-design.md`
Date: 2026-08-30
Status: Awaiting review

How a build reaches a customer's hardware, how it updates itself, and what that means for source secrecy. Adapted from the update module in the existing Budget Tracker project, whose design is sound and is followed closely; the differences are recorded in section 4.

**Why this exists.** Without it, every bug fix is an SSH session for the maintainer. The owner is not technical and the maintainer is part-time doing a favour. An app that cannot update itself is a permanent obligation rather than a product.

---

## 1. Distribution model

Three locations, and only one of them is public.

| Location | Contents | Readable by |
|---|---|---|
| Private source repository | All source | The maintainer |
| Private container registry (GHCR) | Built image, no source | The maintainer, plus one `read:packages` token per install |
| Public manifest repository | One JSON file and a changelog. **No code, ever.** | Anyone |

```
private repo (source)
  └─ GitHub Actions, on tag v*
       ├─ docker build   (multi-stage, source-free runtime stage)
       ├─ push           ghcr.io/<owner>/contractor-quote:X.Y.Z   [private]
       └─ commit         version.json -> public manifest repo

customer mini PC
  ├─ Watchtower  — holds a read:packages PAT, pulls the private image
  └─ app         — fetches version.json from the public repo, holds no credential
```

The `read:packages` scope is the crux: **it pulls images and cannot clone the repository.** The update path therefore works with a credential that grants no source access.

A public repository is public permanently — third parties archive it. So the manifest repository contains the manifest and a changelog and nothing else, and it is given no workflow with any access to the source repository.

## 2. What source secrecy is and is not achievable

Three separate concerns are usually conflated. Two are achievable; one is not, and pretending otherwise leads to wasted effort.

**Repository secrecy — genuinely secure.** A private repository with 2FA on the account. This is real, and it is most of what is actually wanted.

**Image readability — not fixable.** The image contains the application as bundled JavaScript. Anyone holding the image can extract the layers and read it. Minified and mangled, but recoverable.

**Runtime access — not fixable.** The owner is root on his own machine: `docker exec`, the filesystem, environment variables, and the database are all reachable. This is inherent to self-hosting, not a defect in the setup.

Measures worth taking, and where they stop:

| Measure | Verdict |
|---|---|
| Source maps disabled | **Mandatory.** Otherwise the image ships original source verbatim |
| `.git` excluded from the image | **Mandatory.** See section 5.1 |
| Multi-stage build, source-free runtime | Mandatory, and nearly free |
| JavaScript obfuscation | Rejected. Destroys stack traces, breaks intermittently on a Next.js server bundle, and buys delay rather than protection |
| Bytecode or single-executable packaging | Rejected. Next.js does not package cleanly this way, and bytecode decompiles |
| Keeping logic on maintainer-controlled servers | Rejected. It is the only real protection and it destroys the premise — self-hosted, offline-capable, the customer's data on the customer's hardware |

**What actually protects the work.** For a niche trade application the code is not the moat: whoever extracted it would still have to understand statutory holdback, prompt-payment timelines, and T5018 filing, then maintain and support it. The real controls are a written licence agreement, the revocable install token described in section 3.4, and ongoing maintenance — which is the thing of value.

Design accordingly. Effort spent past "no source maps, no `.git`, multi-stage build" is spent on something that does not hold.

## 3. Update mechanism

### 3.1 Version source — the manifest

The Budget Tracker design checks GitHub's `releases/latest` unauthenticated. That returns 404 against a private repository, so the version source changes. The property worth preserving is that **the update checker never sends a credential**, and the manifest keeps it.

`version.json`, published by CI to the public repository:

```json
{
  "version": "1.4.2",
  "published_at": "2026-09-04T02:15:00Z",
  "min_upgrade_from": "1.0.0",
  "notes": [
    { "title": "Quote worksheet", "items": ["Linear-foot lines", "Discount lines"] }
  ]
}
```

Two rules carried over from the original, both load-bearing:

- **Severity is computed locally** by comparing the manifest version with the running version. It is never read from the payload. A publisher has no concept of "is this breaking for you", and a hand-written field is a field that gets it wrong. The manifest deliberately carries no severity field, so there is nothing to be tempted by.
- **Every remote field is length-bounded and shape-checked before use.** `published_at` is sliced to a generous bound, then matched against an ISO-8601 shape. `notes` is bounded in groups, items, and per-item length. A remote string never reaches stored state or a rendered message unbounded.

`min_upgrade_from` is new. If old migrations are ever pruned, a jump from an ancient version cannot be applied safely; the app refuses the apply and says which intermediate version is needed.

### 3.2 Egress policy

Follows `src/lib/update/egress.ts` exactly: one module holds the only `://` literal in the update tree, and a test fails the build if a second appears.

- Exactly one allowed origin and one exact pathname. Pinned paths, never prefixes — a prefix on a repository path would allow issues, comments, and arbitrary content reads, none of which this feature has any business doing.
- `assertManifestUrl()` sits on the line immediately above the single `fetch`, and is deliberately **not** folded into a shared request helper. That adjacency is the first property a refactor loses, and a source-level test checks for it.
- The check compares `origin`, which folds scheme, host, and port together, so `example.com.evil.com`, plain HTTP, and an odd port are all rejected by one comparison. Parsing with `new URL()` first is what catches a userinfo section — `https://host@evil.com` puts the real host in `host`, where a naive check does not look.
- Timeout, response size bound, and JSON shape validation on every fetch.
- No credential is ever attached.

### 3.3 Applying an update

**The application never touches the Docker socket, never shells out, never writes a compose file, and never restarts itself.** It sends one HTTP request to a Watchtower companion container on the compose network. Watchtower already holds the socket and the label scope.

This is the most important decision in this document. A container able to restart itself through the Docker socket is effectively root on the host, and it would put that capability behind a web request.

- `WATCHTOWER_URL` and `WATCHTOWER_TOKEN` come from the environment. No `://` literal appears in the module, and the default URL is written once, in the compose file.
- A token shorter than 8 characters is treated as absent rather than accepted — secret-scrubbing on a 1-character token would shred every occurrence of that character in every error message.
- Any 2xx is "accepted". The outcome distinguishes `accepted` from `accepted-unconfirmed`, because the container may be replaced before the response is read.

### 3.4 The install token as a licence control

Each install gets its own fine-grained `read:packages` token. Revoking it stops that install receiving new images; the running install continues working unchanged.

That is a cleaner enforcement mechanism than anything implemented in code, and it arrives free with this distribution model. It gates future value rather than disabling software somebody paid for — which is both more defensible and less likely to strand a business mid-job.

### 3.5 Rate limits and scheduling

One automatic check per 24 hours, counted from every attempt rather than every success. Manual buckets are **global rather than per-user**, deliberately: there is one registry quota and one install to update, so the contended resource is the install itself, and two people pressing the button are contending for the same thing.

| Action | Limit |
|---|---|
| Check now | 5 per 10 minutes |
| Review notes | 10 per 10 minutes |
| Apply | 3 per hour |

The apply limit is not a security boundary — an administrator can already restart the container. It bounds a stuck form and a double-click storm against a container that is mid-replacement.

### 3.6 State

**No new table, no new column, no migration.** Every byte of update state is a key/value row under the `update.` prefix, owned by one module.

That is structural rather than stylistic: there is no column with a default, no seeded row, and no `NOT NULL DEFAULT true` anywhere that could switch the feature on for someone who never asked. **Absence is the off state.**

This requires a generic key/value table that the current Phase 1 schema does not have:

```
settings          -- key/value; NOT mirrored to SharePoint
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
```

Distinct from `organization`, which holds typed tenant configuration. `settings` holds machine state — update bookkeeping, sync cursors, feature toggles. **It is excluded from the SharePoint mirror**, for the same reason credentials were pulled out of `feature_flags`: a mirrored table ends up in the mirror and in every backup, and machine state has no business being read by an accountant.

Keys: `update.checks_enabled`, `update.auto_apply`, `update.last_checked_at`, `update.last_check_error`, `update.latest_version`, `update.latest_published_at`, `update.dismissed_version`, `update.apply_requested_version`, `update.apply_requested_at`, `update.last_applied_at`, `update.last_apply_error`, `update.apply_timed_out_version`.

### 3.7 Reconciling an apply that may never land

An apply request is made by a process that is about to be replaced, so it cannot observe its own outcome. Two failure shapes, both handled in the original design and both carried over:

- **The container was replaced.** A boot-time reconciler sees a pending request whose version matches the now-running version and records success.
- **The container was never replaced** — a pinned image tag being the concrete case. A pending request older than 30 minutes is recorded as timed out, and its version is remembered so the app stops re-offering an update that structurally cannot apply on this install.

### 3.8 Auto-apply

**Off by default, and it stays off until the pre-migration backup in section 4.1 is proven in a drill.**

Automatic patch application is genuinely attractive for a non-technical owner — security fixes arrive without a phone call. But this system holds tax records and a schema migration sits in the update path, which is a different risk profile from a personal budget tool. Notify, and require a click.

## 4. Differences from the Budget Tracker module

Recorded so the port is a deliberate adaptation rather than a drifting copy.

1. **Version source** is a public manifest, not GitHub `releases/latest`, because the repository is private (section 3.1).
2. **Notification** is an in-app banner plus the existing dead-man's-switch ping. Budget Tracker routes through a notify outbox with e-mail and Telegram; email from the app was cut from this product, since the realistic failure is the machine being unplugged and an e-mail job on a dead machine sends nothing.
3. **Storage** is Drizzle over PostgreSQL rather than SQLite. The `getSetting`/`setSetting` port is mechanical.
4. **Migration on boot** is new, and is the subject of section 4.1.
5. `min_upgrade_from` is new.

### 4.1 Migration on boot, and the backup that must precede it

A new image may carry schema changes. Boot order is fixed:

```
start -> verify database reachable
      -> take a dump, tagged with the outgoing version
      -> run migrations
      -> serve
```

Two requirements:

**Back up immediately before migrating, not on the nightly schedule.** A migration that goes wrong on a Tuesday morning must be recoverable to Tuesday 08:59, not to Monday night. The dump is written to the local volume and named for the version being upgraded from.

**Fail closed.** If a migration fails, the application must refuse to serve rather than run against a half-migrated database. Serving a quote screen backed by a partially migrated schema is worse than an outage, because it produces wrong figures instead of no figures.

Recovery, which belongs in the runbook: pin the previous image tag in the compose file, restore the pre-migration dump, restart. The failure is loud — the container will not come up, the health check fails, the dead-man's ping stops.

Migrations use `drizzle-kit generate` plus `migrate`. `push` is a development convenience only and never runs against a customer install.

## 5. Image construction

### 5.1 Excluding `.git` is not optional

`.dockerignore` must exclude `.git`. Without it the entire commit history ships inside the image — every version of every file, plus any secret ever committed and later removed. That single line matters more than every other measure in section 2 combined.

Also excluded: `docs/`, `tests/`, `.env*`, `node_modules`. **Not** excluded: `drizzle/`, whose migration files must ship.

### 5.2 Multi-stage build

The build stage holds the full repository and runs `npm ci` and `next build`. The runtime stage copies only `.next/standalone`, `.next/static`, `public`, and `drizzle`. No `src/`, no development dependencies, no tests, no configuration files beyond what the runtime reads.

- `output: 'standalone'` in `next.config.ts`.
- Source maps disabled for both browser and server output.
- Runs as a non-root user.
- Chromium for PDF generation puts the image above 1GB. Watchtower pulls the whole image on every update, so an update over a home connection takes minutes rather than seconds. Worth stating in the runbook so nobody assumes a hang.

### 5.3 White-label guard interaction

The registry path and the manifest URL are **product** constants, not tenant values, so they belong in code and the guard from Plan 1 must not flag them. The guard's patterns target a customer's name, domain, phone number, and tax rate — none of which appear here. Worth a comment at each constant explaining why it is exempt from the rule the rest of the codebase follows.

## 6. Consequent changes elsewhere

- **Phase 1 schema** gains the `settings` key/value table (section 3.6), excluded from the mirror.
- **Plan 4** adds Watchtower and registry authentication to the production compose file, and the boot sequence from section 4.1.
- **CI** gains an image publish and a manifest publish, both on tag.
- **The runbook** gains: update failure recovery, image size expectations, and token rotation.
- **A licence agreement** is a deliverable, not a code artifact, and it is the actual protection for the work.
