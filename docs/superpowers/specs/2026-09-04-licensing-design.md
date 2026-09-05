# Licensing and Expiry — Contractor Quote & Project Management System

**Companion to** `2026-08-30-distribution-and-updates.md` (sections 2 and 3.4), `2026-08-30-scopeline-design.md` (sections 8.2, 8.4, 8.6) and `2026-09-04-sso-design.md` (sections 5, 10)
Date: 2026-09-04
Status: Awaiting review

The question, as it was asked: can the source be protected, and can there be a licence key with an expiry?

The first half was settled on 2026-08-30 and the answer has not changed. This document does not reopen it; section 1 restates the conclusion in three lines and moves on. The second half is buildable, and this document specifies it: what a licence contains, how it is signed, what happens when it runs out, and where the check sits in a codebase that already has a gate which deliberately fails closed and a permission matrix that already knows the difference between reading and writing.

**Why this exists.** A licence with an expiry is easy to build badly, and the bad version is worse than none: it locks a paying contractor out of his own job costing on a Friday afternoon because a file was unreadable, or it disables software somebody already paid for and turns one unpaid invoice into a story told at every supply house in the county. The mechanism is not hard. Deciding what it is allowed to do is the hard part, and that is most of what follows.

**The frame for the whole document.** The customer is root on hardware he owns, running a container whose contents he can read. Nothing here is a lock, and nothing here should be built as though it were one. Everything here is a speed bump with a receipt: it makes the honest path the easy one, it makes a dishonest path visible, and it leaves an evidence trail a conversation can be built on. The enforceable instrument is the licence agreement. The code's job is to make the agreement's terms legible and to make a breach observable — not to police them.

---

## 1. What was already decided, and is not reopened

The distribution document, section 2, separated three things that are usually confused:

- **Repository secrecy is real** and is most of what was actually wanted. Private repository, 2FA, `.git` excluded from the image, no source maps, multi-stage build with a source-free runtime stage.
- **Image readability is not fixable.** Whoever holds the image can extract the layers and read the bundled JavaScript.
- **Runtime access is not fixable.** `docker exec`, the filesystem, the environment, and the database are all the owner's. That is inherent to self-hosting, not a defect.

Obfuscation and bytecode packaging were considered and rejected there, with reasons. **Section 8 of this document restates that refusal so that the next person does not spend a week rediscovering it**, but adds no new argument, because none is needed.

The distribution document also established that **the code is not the moat**: whoever extracted it would still have to understand statutory holdback, prompt-payment timelines, and T5018 filing, then maintain and support it for people who phone at seven in the morning. And it established that **the install token already gates updates** — revoking a per-install `read:packages` token stops that install receiving new images while leaving the running install untouched, which withholds future value rather than confiscating paid-for value.

Everything below is built on top of those three, and is subordinate to them. If a decision in this document conflicts with section 3.4 of the distribution document, section 3.4 wins, because withholding updates is a cleaner lever than anything that runs inside the customer's container.

## 2. The licence token

### 2.1 Signed asymmetrically, and why that is the one part worth doing properly

A licence is a **JWS in compact serialisation, signed with Ed25519 (`alg: EdDSA`)**, verified with `jose`, which is already a dependency and already verifies the Cloudflare Access assertion in `src/lib/auth/access.ts` and the provider `id_token` in the SSO design.

Asymmetric, not symmetric, and this is the load-bearing choice. A shared secret would have to ship inside the image, and an image the customer can read is an image whose HMAC key the customer can read — at which point anybody who found it could mint themselves a licence expiring in 2099 and, worse, could publish a generator. **The private key never leaves the maintainer's machine; the image carries only the public half.** Forgery is therefore genuinely off the table, and it is the one attack in this whole area that would otherwise scale beyond a single install.

Which is worth stating precisely, because it is easy to oversell: signing prevents a licence from being *manufactured*. It does nothing about a licence being *ignored*. See section 2.5.

`Ed25519` rather than `ES256`: smaller keys, no curve-parameter footguns, and no nonce-reuse failure mode. `jose` supports `EdDSA` and Node 22 exposes Ed25519 through Web Crypto, but **this should be verified against the pinned `jose` version at implementation rather than taken from this document** — if it turns out to be awkward on the runtime the image actually ships, `ES256` is the fallback and nothing else in this section changes. The SSO design already mints an ES256 JWT for Apple, so that path is known to work here.

### 2.2 The claims

```json
{
  "iss": "urn:product:licence",
  "aud": "urn:product:install",
  "sub": "0f8c2b6e-4a1d-4c7f-9b52-7d3e1a9c04ab",
  "jti": "lic-2026-0007",
  "iat": 1772582400,
  "nbf": 1772582400,
  "exp": 1804118400,
  "tier": "standard",
  "features": [],
  "grace_days": 14,
  "issued_to": "<customer legal name, as it appears on the agreement>"
}
```

| Claim | Meaning | Notes |
|---|---|---|
| `iss`, `aud` | Product-level constants | Fixed strings, checked on verify. They exist so a token minted by this key for some other purpose cannot be replayed as a licence |
| `sub` | The install identity | A UUID the maintainer allocates when he issues the licence. **Bookkeeping, not an enforcement key** — see below |
| `jti` | The licence's own identity | So a reissue is distinguishable from the same licence pasted twice, and so a support conversation has something to name |
| `iat`, `nbf` | Issued and not-before | `nbf` equals `iat`; it is present so a licence dated forward for a renewal cycle is possible without a code change |
| `exp` | The expiry | The only claim the customer will ever care about |
| `tier` | A named plan | One value today. It exists so that adding a second is a licence reissue rather than a schema change |
| `features` | Named capabilities | **Ships empty**, meaning "everything in the tier". An unrecognised name is ignored rather than refused, so an older image meets a newer licence without failing |
| `grace_days` | How long the grace state lasts past `exp` | In the token so the maintainer can grant a longer runway to a customer he knows is slow to pay, without shipping an image. Bounded at parse: anything outside 0–180 is clamped |
| `issued_to` | A display label | Shown on the licence screen so the owner can see whose licence he is running. Never matched against anything |

**The install id is not an enforcement key, and this is deliberate.** Nothing stops one customer's licence being pasted into another customer's install, because there is nothing on the box that could prove which box it is without hardware fingerprinting — and hardware fingerprinting is refused in section 8 for a reason that matters more than licensing does: the product's documented disaster path (main design, section 8.3) is *restore the dump onto new hardware*. A licence bound to a MAC address or a machine id turns a fire into a lockout. So `sub` is recorded, shown, and audited when it changes, and never used to refuse anything. Two installs sharing one licence is a contract breach, it is discoverable at renewal, and both copies expire on the same day, so it does not scale.

**No seat count.** Discussed and refused in section 8.

### 2.3 The keys, and rotating them

- **The private key lives in the maintainer's password manager**, alongside the six secrets already listed in main design section 8.4, and is used by a small offline signing script. It is **not a CI secret**. Licences are issued a handful of times a year by a person; putting the key in a build system puts it in a system with many moving parts and many people's tokens, for no gain.
- **The public key is embedded in the image as a constant**, with a `kid`. It is a product constant rather than a tenant value, so the white-label guard must not flag it — the same exemption, with the same comment, that distribution section 5.3 gives the registry path and the manifest URL.
- **Two public keys are trusted at once**: current and next. A licence verifies if it verifies against either. Rotation is then: ship an image trusting both, issue under the new key, drop the old key an image or two later. Without this, rotation is a flag day across every install, some of which are offline, some of which have a revoked install token and will never take a new image at all.
- **If the private key is lost**, every existing licence keeps verifying until it expires and reissue requires an image update. That is a slow problem, not an outage, and it is worth knowing it is slow.
- **If the private key leaks**, anybody can mint licences, and the response is a rotation in a new image — which only reaches installs that still hold a valid install token. That circularity is real and there is no way out of it in an offline product. It is another reason not to treat any of this as a security boundary.

### 2.4 Where the licence lives, and why it may go through a form

The licence is stored as a row in `settings` — `licence.token` — which is the key/value table introduced in distribution section 3.6 and **already excluded from the SharePoint mirror**.

This breaks a rule the codebase otherwise holds firmly. `src/app/setup/environment.ts` says it in capitals: *it validates, it does not collect*, because a form writes to the database, and the database is mirrored and dumped hourly to three destinations, so a Graph certificate entered through a text box would be in all of them forever.

**The licence is exempt because it is not a credential.** It grants nothing to whoever steals it; it is a signed statement *about* an install, readable by anyone, and its presence in a backup is desirable rather than dangerous — a restore onto new hardware should come back licensed. The rule exists to keep secrets out of mirrored storage, and this is not a secret.

That exemption buys something specific and necessary: **a renewal is a string the owner pastes into a screen, and it takes effect on save without a restart.** The alternative — a mounted file or an environment variable — means every renewal is an SSH session or a phone call walking a non-technical person through editing a Compose file, once a year, forever, on a box that may be behind no remote access at all. That is precisely the permanent obligation the distribution document was written to avoid.

An environment fallback exists anyway, for the installer's first provisioning: `LICENCE_FILE` pointing at a mounted file. **Precedence between the two is by `exp`, later wins**, so a stale file left on disk can never downgrade an install that has since had a renewal pasted in, and pasting always works.

Two rules on the paste screen:

- **Verification happens before the row is written.** A bad paste is refused with a sentence in front of the person who pasted it, which is the only moment anyone can do anything about it. It never reaches storage, which is why section 7.4 can treat a stored-but-unverifiable licence as a maintainer problem rather than a customer error.
- **Every field displayed back is length-bounded and shape-checked**, the same rule distribution section 3.1 applies to the update manifest. `issued_to` in particular is attacker-controlled in the sense that matters — it is a string from outside the app that gets rendered — even though the signature means the attacker would have to be the maintainer.

### 2.5 The check can be patched out, and that is acceptable

Say it plainly, because a document that leaves it implied invites someone to spend money on it later.

The licence check is JavaScript, in a bundle, in a container the customer is root over. Anyone willing to spend an afternoon can `docker exec` in, edit the file, and restart. They can also simply set the system clock back, which takes ten seconds and is covered in section 3. A patched image can be redistributed, so it is not even true that patching is per-install.

This is acceptable, and not because it is unfortunate-but-unavoidable. It is acceptable because:

- **The population does not contain the attacker.** These are small contracting businesses buying a mini PC with software on it. The customer capable of patching a Next.js server bundle is also the customer who was never going to pay, and there are not many of him.
- **The lever that works is elsewhere.** Distribution section 3.4: revoke the install token and the install receives no further images. That withholds future value, needs no cooperation from code running on the customer's machine, and cannot be patched out from inside the container.
- **The lever that really works is a signature on a licence agreement**, which is enforceable against a business with a name, an address, and a stake in its own reputation. Code cannot do that and should not pretend to.
- **Everything that would raise the bar lowers something else.** Obfuscation destroys stack traces and the ability to support the product. Self-integrity checks break on legitimate rebuilds and are removed by the same edit that removes the licence check. Phone-home breaks the offline premise. Each of them costs support hours in exchange for delaying an adversary who does not exist in this market.

So: sign asymmetrically, because that is cheap and it stops forgery from scaling. Then stop.

## 3. Time is the attack, not forgery

An expiry that cannot be forged can still be outrun by a clock. Set the box to last year and it runs forever. This is the attack that actually happens, it needs no skill, and any expiry design that does not address it is decorative.

### 3.1 What a rollback costs today

Nothing. `new Date()` reads the container clock, which reads the host clock, which the owner sets. There is no NTP requirement, and there must not be one, because the box may have no internet at all (section 4).

### 3.2 The high-water mark

**The app records the furthest-forward time it has ever observed, and evaluates the licence against that rather than against the raw clock.**

```
highWater   = max( settings['licence.seen_max_at'],
                   max(settings.updated_at),
                   max(audit_log.changed_at)   -- read at boot only, see below
                 )

effectiveNow = max( systemNow, highWater )
```

- `licence.seen_max_at` advances at most once an hour, reusing the write-throttling pattern `readSession` already applies to `sessions.last_seen_at`, so an afternoon of use costs one write.
- The corroborators matter more than the stored value, because the stored value is one row that anybody with `psql` can update. `settings.updated_at` is a tiny table read constantly by the update bookkeeping and by this mechanism itself. `audit_log.changed_at` is the strong one: to defeat it, the customer would have to rewrite the change log his own accountant relies on, which is a materially different act from typing `date -s`.
- **`audit_log` is read at boot only, not per evaluation.** The existing index is `(table_name, record_id)`; there is none on `changed_at`, and `audit_log` is expected to be the largest table in the database, so `max(changed_at)` is a sequential scan. A once-per-boot cost is invisible; a per-request cost is not. Whether to add `audit_log_changed_at_idx` and read it more often is left open in section 9.

A rollback is then not free: expiry is judged against `effectiveNow`, so moving the clock back does not move the expiry back.

It is also **visible**. When `systemNow` is behind `highWater` by more than a tolerance, the app records `licence.clock_warning_at` and the delta, and the licence screen says so in plain words — *this system's clock is N days behind the latest activity recorded on it*. The banner is informational and does not itself change state.

The tolerance is generous, because the commonest cause of a backwards clock is not fraud. A dead CMOS battery makes a machine boot at its BIOS default; NTP stepping a badly drifted clock can move it by hours. **48 hours** is proposed, and it is a guess (section 9).

### 3.3 What this does not achieve

Honestly, and in full:

- Root can `UPDATE settings SET value = ... WHERE key = 'licence.seen_max_at'`. The corroborators raise the effort; they do not stop it.
- Restoring an older dump resets everything, including the audit log, because a dump is byte-exact by design. There is no way to distinguish "restored from a legitimate backup after a disk failure" from "restored a nine-month-old dump to reset the clock history", and any attempt to would sabotage the restore paths, which are worth more than the licensing is.
- A brand new install has no history to be monotonic about.
- The mark cannot tell an attack from a hardware fault, which is exactly why the response is a notice rather than a punishment.

What it buys is that a rollback stops being invisible and free, and becomes something with a timestamp on it that a conversation can start from. For this product, against this population, that is the right amount of effort.

### 3.4 Poisoning the mark forwards

The mirror-image failure is worse than the attack, and it is an accident rather than an attack: a clock set once to 2099 — a typo in a BIOS date, a bad container `TZ`/date experiment — writes a high-water mark far in the future, and the install is instantly and permanently expired even after the clock is corrected.

Two guards:

1. **The mark advances at most once per boot to `min(systemNow, oldMark + 400 days)`.** Within a running process it advances only by monotonic elapsed time. A box genuinely powered off for three years catches up over two or three restarts, which is a footnote in the runbook; a clock knocked to 2099 costs the install 400 days of high-water instead of seventy years.
2. **A poisoned mark cannot brick anything.** It can push the install into read-only, and read-only still exports, still prints, still backs up, and still shows every record. That is the payoff for section 5, and it is worth stating as a general property: *every failure mode of this subsystem, including the ones nobody predicted, costs the customer his write access for a day rather than his books.*

Recovery from a poisoned mark is a maintainer action, not an owner action, because unwinding it means deciding which recorded timestamps are wrong. There is no self-service reset, because a self-service reset is also the rollback bypass.

### 3.5 An optional corroborated clock, for installs that have internet

The update checker already fetches `version.json` from a public repository once a day, with no credential (distribution section 3.1). That fetch could carry a **signed timestamp under the same key as the licence** — a tiny detached JWS in the manifest — and an install that successfully reads it feeds it into `highWater`.

The properties work out well: it needs no credential and no new egress (the allowlist in `egress.ts` already permits exactly that one origin and pathname); replay is harmless, because a replayed old timestamp is smaller than the mark and `max` ignores it; and a future timestamp cannot be minted without the private key, so a hosts-file redirect gains nothing.

**It must remain strictly optional.** An offline install is identical in every state except that its clock is uncorroborated. If this ever becomes a dependency, the product has broken its own premise, and section 4 is the reason.

## 4. Offline is the premise, not an edge case

The product is a mini PC in a contractor's office. It may have no internet. Backups are local-first, to an internal volume and a USB drive, with SharePoint as an optional disaster path that some deployments will decline outright. A licensing scheme that assumes connectivity contradicts the thing being sold.

Consequences, all of them accepted:

- **No activation.** A licence is valid the moment it is pasted in, with no call to anything.
- **No heartbeat, no phone-home, no licence server.** A licence server's downtime is the customer's downtime, and the customer is the one running a business.
- **No revocation.** A revocation list cannot be delivered to a machine with no internet, so there is none. **A licence issued for twelve months is good for twelve months.** The exposure is bounded by the term, which is the reason terms are annual rather than perpetual, and it is one more reason the install token — which acts on the maintainer's side of the wire — is the real lever.
- **Renewal is an email and a paste.** The maintainer signs a new token, sends it, the owner pastes it into `Settings → Licence`, and the state changes on save. That works over a phone call, from a printed sheet, from a USB stick.
- **The clock is the only time source**, which is why section 3 exists at all.

## 5. Degradation, which matters more than enforcement

This is the most important section in the document, and it is the one a lawyer should read first.

### 5.1 A lapsed licence means read-only, with export and backup intact

**There is no hard stop anywhere in this product.** No state refuses to boot, refuses to sign in, refuses to show a record, refuses to print a document the customer already sent to a client, refuses to run a backup, or refuses to produce the accountant export. There is no remote disable path of any kind, and none may be added.

When a licence lapses, the product declines to *change* records. It continues to serve every record it holds, and it continues to hand them back in a form the customer can take elsewhere.

### 5.2 Exactly which capabilities

`src/lib/auth/permissions.ts` already enumerates every capability in one array with a `satisfies`-checked matrix, so that adding a capability without classifying it is a compile error rather than a silent `undefined`. **The licence gate uses the same shape**, as a second `Record<Capability, boolean>` — "does this capability change the record set" — so a capability added next year for invoicing or payroll cannot be forgotten here either.

| Capability | Available when lapsed | Why |
|---|---|---|
| `worksheet:read` | Yes | Reading |
| `audit:read` | Yes | Reading, and it is the record of what happened |
| `export:read` | **Yes, always** | This is the customer's data leaving in a form he can use. Blocking it is the one thing that would be indefensible |
| `document:generate` | Yes | A contractor who cannot reprint a quote he already issued cannot do his job. It writes a `files` row, which is discussed below |
| `backup:configure` | Yes | Denying a customer the ability to secure his own data is not a payment reminder |
| `quote:write` | No | |
| `quote:transition` | No | |
| `record:void` | No | |
| `user:manage` | No | |
| `user:reset-link` | No | |
| `rates:edit` | No | |
| `tax:edit` | No | |
| `organization:edit` | No | |
| `sync:configure` | No | Configuring it is a write. The sync job itself keeps running, because it is data reaching a place the customer can read it |

**"Read-only" is about the record set, not about zero writes, and pretending otherwise would produce a broken product.** A lapsed install still writes sessions, audit rows, the high-water mark, and the `files` row behind a regenerated PDF. Those are machine bookkeeping and copies of data the customer already owns. The rule is that no *business* record is created, changed, or transitioned.

**The backup job is outside the app entirely** — `docker/backup-loop.sh` and `docker/backup.sh` run as their own process on their own schedule, touching PostgreSQL directly. Nothing in the application layer can stop them, including by accident. That is a property worth naming, because it means the "your data keeps being protected" promise does not depend on this subsystem being correct.

### 5.3 Why never a hard stop

Three arguments, and they are independent — any one of them is sufficient.

**Commercial.** Trade markets run on word of mouth. A contractor whose quoting and job-costing system locks him out mid-job, with a change order pending and a GC waiting on a number, does not quietly pay the invoice. He tells every general contractor, every sub, and everyone at the supply counter, and he tells the version where the software held his books hostage. The revenue recovered from the one lapsed account is trivially smaller than the cost of that story in a market where the maintainer sells one box at a time on reputation.

**Legal.** This is the customer's data, on the customer's hardware, which he owns. Denying him access to it is a different act from declining to provide further service, and several jurisdictions have rules about undisclosed remote disabling of software, self-help repossession, and unfair contract terms that bear on it. **This document does not attempt to say what those rules are or where they apply** — see section 10. It says only that the risk is real enough that the design should not walk into it for a benefit it does not need, and that a soft, disclosed, proportionate degradation sits in a much better place than a hard stop does.

**Contractual.** An undisclosed kill switch is a term the customer never agreed to, exercised without notice. A disclosed degradation, described in plain words in the agreement he signed, is an agreed consequence. The difference between those two is most of the legal exposure, and it costs nothing to be on the right side of it.

### 5.4 The agreement and the code must say the same thing

**Whatever is built must be written into the licence agreement plainly, and the agreement must not describe more than the code does.** Both directions are failures:

- If the code degrades to read-only and the agreement says "the software will cease to function", the agreement is describing something harsher than what happens, and a customer reading it makes decisions on a false picture.
- If the agreement is silent and the code degrades anyway, the customer is subject to a consequence he never agreed to, which is the exposure section 5.3 is trying to avoid.

The agreement should state, in the owner's language and not in this one:

1. That the licence has a term and an expiry date.
2. That after expiry, and after a stated grace period, the software stops accepting changes to records.
3. **That the software never deletes, encrypts, withholds, or degrades access to the customer's data, in any state**, and that viewing, printing, exporting, and backing up continue to work.
4. That there is no remote disable, no phone-home, and no requirement for the system to have internet access.
5. What the customer's route to his own data is if the relationship ends — which is the export, the backups, and section 5.5.
6. That updates cease when the install token is revoked, which is a separate mechanism from the licence and is what actually happens first.

### 5.5 The backup key problem, which is larger than licensing

Raising it here because this is the document where it becomes urgent.

Main design section 8.2 encrypts every backup with `age`, and **deliberately keeps the private key off the machine** so that a box which is stolen cannot decrypt its own backups. Section 8.4 puts that key in the maintainer's password manager, alongside the tunnel token and the database password.

That is sound reasoning about theft. It also means that today, **if the relationship between the maintainer and the customer ends, the customer holds a USB drive full of backups he cannot read.** That is a far more serious version of the hostage problem than anything in this licensing design, and it exists already, without anybody having decided it.

This document does not resolve it, because it is partly a legal question. It flags it as **the single most important thing to settle alongside the licence agreement**, and notes the obvious shape of a fix: issue the customer his own `age` recipient key at install, encrypt to both recipients, and hand him his private half on paper in a sealed envelope with the hardware. That preserves the theft protection — the key is not on the box — while removing the situation where a business's entire financial history is legible only to a third party.

## 6. States and transitions

### 6.1 The states

| State | Condition | Writes | What the owner sees |
|---|---|---|---|
| **Valid** | `effectiveNow < exp − 30d` | Yes | Nothing, except the licence screen when he goes looking |
| **Expiring** | `exp − 30d ≤ effectiveNow < exp` | Yes | A dismissible banner, with the date and the days remaining. Dismissal is per version of the licence and lasts seven days, then it comes back |
| **Grace** | `exp ≤ effectiveNow < exp + grace_days` | Yes | A persistent banner that cannot be dismissed. It says the licence has expired, gives the date the system becomes read-only, and says what read-only means |
| **Lapsed** | `effectiveNow ≥ exp + grace_days` | **No** | A persistent banner, and every refused write returns a sentence explaining why |
| **Unlicensed** | No licence installed | Yes for 30 days from first boot, then as Lapsed | A persistent banner from the first day. See below |
| **Unreadable** | A licence exists but does not verify, or could not be read | **Yes** — fails open, section 7.3 | A persistent banner saying the licence could not be read and to contact support |

**Unlicensed is a distinct state and not a free pass.** A fresh box has a window — proposed at 30 days from `licence.first_seen_at`, which is written at first boot and is subject to the same high-water logic — in which it works fully with a visible banner. This exists so that an installer can stand a machine up before the paperwork lands, and it is bounded so that "just don't install a licence" is not the trivial bypass it would otherwise be. Whether the window is wanted at all, and whether 30 days is right, is open (section 9): the maintainer supplies the hardware with the software already on it, so an install that has never seen a licence may not be a real scenario.

### 6.2 The transitions

Forward transitions happen by time alone, are evaluated on every guarded request, and need no restart.

**Every state returns to Valid the instant a licence with a later `exp` is saved**, including from Lapsed, including with no internet, including without a restart. The in-process cache is invalidated synchronously by the same call that writes the row — the pattern `revokeAllSessions` already uses, and for the same reason: a renewal that takes five minutes to be believed generates a support call.

There is no transition that deletes anything, and none that is irreversible.

### 6.3 Where it surfaces

- **`Settings → Licence`**, a new screen: current state, expiry date, days remaining or days lapsed, `issued_to`, tier, the licence id, the install id, the clock warning if there is one, and a field to paste a new licence. Readable by `owner` and `admin`; only `owner` may paste. The paste is not a new capability — it is `organization:edit`, because it is tenant-level configuration and inventing a fifteenth capability for one field makes the matrix harder to hold in one's head for no gain.
- **A banner in `AppShell`**, in the same slot the update notice occupies. One banner, never two: if an update notice and a licence notice both apply, the licence wins, because it is the one with a deadline attached.
- **The setup wizard's environment step** gains a licence row in the existing `EnvironmentCheck` shape — `pass` when a valid licence is present, `fail` when one is present and unreadable, `off` when none is installed. `off` rather than `fail` for a missing licence, following the rule that step already applies to the SharePoint mirror: a red cross beside a thing the installer has deliberately not done yet teaches him to ignore red.
- **Refused writes** come back through the existing `GuardResult` `{ ok: false, error }` channel, as a sentence a person can read and relay. No new error type, no blank screen, no stack trace.
- **`/api/health` does not report licence state.** Health is container liveness for a probe that holds no credential, and a lapsed install is a healthy container. Conflating them would make an unpaid invoice look like an outage to the restart logic.

### 6.4 What is never blocked, in any state

Sign-in. Viewing any record. The worksheet. Printing and PDF generation. The accountant export. Backups and restores. The licence screen itself. The setup wizard. `/api/health`.

If a future change would block any of these in any licence state, it is a change to section 5.4 of the agreement first and a code change second.

## 7. Where the check lives

### 7.1 In the guard, not the proxy

The check belongs in `guard()` in `src/lib/auth/guard.ts`, which every server action already opens with.

**Not in `src/proxy.ts`.** The proxy establishes *who is asking* and writes `x-identity-email`; it does not decide what they may do. That separation is stated as a rule the implementation must not break (SSO design, section 10.1), and licensing is a `what may they do` question. Putting it in the proxy would also mean a path-based allowlist of read versus write URLs — precisely the fragile hand-maintained list that the capability matrix exists to replace, and one that a new route would silently escape.

Enforcement in `guard()` inherits the property that matters: **an action that does not call `guard()` is already a bug**, so there is no way for a new write to quietly escape the licence check that is not also a way for it to escape authorization.

A new module, `src/lib/licence/`, mirrors `src/lib/auth/`. Evaluation is a pure function of (token, `effectiveNow`, high-water observations) returning a state, so the whole state machine is testable without a clock, a database, or a signing key — the tests mint their own key pair per run, the way the SSO mock provider does.

### 7.2 Order of the two checks

**Capability first, licence second.** A bookkeeper attempting a write he does not have the role for should be told his role does not permit it. Telling him instead that the licence has lapsed is noise, and it leaks the licence state to a role that has no business acting on it. Only a request that *would have succeeded* is refused for licensing reasons.

### 7.3 Fail open or fail closed

`readSetupGate` fails **closed** on an unreadable database, and the comment says why: a database that does not answer must not read as "no company yet", because that would offer a first-run form to a live tenant whose database was merely down, and the form overwrites.

**The licence check fails open, and the asymmetry is the entire reason.**

The setup gate guards a destructive action. Getting it wrong in the open direction destroys a company's configuration. The licence gate guards a *removal of capability*: getting it wrong in the open direction means an unlicensed install can write for as long as the read keeps failing. Getting it wrong in the closed direction means a paying customer cannot enter a change order on a Friday afternoon because a settings row was briefly unreadable during a restore or a migration.

Those are not comparable harms, and they are not comparable in likelihood either. The failure being guarded against — non-payment — is slow, recoverable, already addressed contractually, and already addressed more effectively by the install token. The failure caused by failing closed is immediate, lands on somebody who has done nothing wrong, and is exactly the story section 5.3 is trying not to become.

Two further reasons:

- **Failing open is never silent.** Every open-failed state carries a persistent banner and a line on the licence screen. An install running open is running visibly open, and the maintainer hears about it.
- **Failing open concedes nothing that root did not already concede.** Section 2.5 accepts that the check can be removed entirely. A check that fails open on an unreadable file is, at worst, an occasional accidental instance of a bypass the design has already priced in.

### 7.4 The three ways a licence can be unavailable, which are not the same

| Case | Cause | Behaviour |
|---|---|---|
| **No licence at all** | Fresh install before provisioning; a self-built development instance | The `unlicensed` state: full function for the first-run window, banner from day one, then read-only (section 6.1) |
| **A licence that does not verify** | Key rotation gone wrong; a corrupted row; a restore from a dump signed under a key this image no longer trusts | **Fail open**, banner, and it is a maintainer problem. A bad paste cannot cause this, because verification happens before the write (section 2.4). Degrading a customer to read-only over the maintainer's own key management would be indefensible |
| **The database did not answer** | Restore in progress, migration mid-flight, PostgreSQL down | **Fail open** trivially. The app has no quotes, no users and no records in this state anyway, so the licence is the least of anyone's problems, and unlike the setup gate this direction cannot cause damage |

### 7.5 Caching

Evaluated state is cached in process for five minutes, following the session cache in `src/lib/auth/session.ts` — and carrying the same caveat verbatim: **this is a latency optimisation, never a correctness mechanism.** It is coherent because the standalone server is one Node process; run more than one and the cache must be dropped, at which cost every guarded request pays one indexed read and is still correct.

The cache is cleared synchronously by the call that writes a new licence, so a renewal takes effect on save.

### 7.6 State in `settings`

**No new table, no new column, no migration** — the same rule distribution section 3.6 set for update state, for the same reason: no defaulted column can switch something on for a deployment that never asked, because **absence is the off state**.

Keys, all under the `licence.` prefix and owned by one module:

`licence.token`, `licence.install_id`, `licence.installed_at`, `licence.first_seen_at`, `licence.seen_max_at`, `licence.boot_advanced_at`, `licence.clock_warning_at`, `licence.clock_warning_delta_days`, `licence.last_state`, `licence.dismissed_notice_for`.

`licence.last_state` exists so that a transition — Valid to Grace, Grace to Lapsed, anything to Valid — is written to the audit log once, when it happens, rather than being inferred later from timestamps.

## 8. What is explicitly not worth doing

So that the next person does not spend a week on it.

| Refused | Reason |
|---|---|
| JavaScript obfuscation, bytecode, single-executable packaging | Settled in distribution section 2. Destroys stack traces, breaks on a Next.js server bundle, decompiles anyway, and buys delay rather than protection |
| Hardware fingerprinting or node-locking the licence | The documented disaster path is *restore onto new hardware* (main design 8.3). A licence bound to a machine turns a fire into a lockout. This one is not a close call |
| Online activation, heartbeats, a licence server | Contradicts the offline premise (section 4). The server's downtime becomes the customer's downtime, and a customer with no internet has permanent downtime |
| A self-integrity check over the app's own bundle | Breaks on every legitimate rebuild, and is removed by the same edit that removes the licence check. Support cost with no adversary |
| Encrypting the database with a licence-derived key | Makes the customer's books hostage to the maintainer's signing key, destroys every restore path in main design 8.3, and is the exact scenario section 5.3 exists to avoid. Refused on legal grounds as much as technical ones |
| A remote kill switch, a time-bombed image, or anything that refuses to boot | A container that will not start also cannot export. Section 5 |
| Seat counting | The product is priced per install on hardware the maintainer supplies, so seats have no revenue link. It would generate support calls ("we hired a labourer and now nobody can log in") in exchange for nothing |
| Licence revocation lists | Undeliverable to an offline box (section 4). The term is the bound |
| Deleting or hiding data in any state | Section 5.1 |
| Source watermarking, canary tokens, anti-debug, packing | Aimed at an adversary who does not exist in this market, at the cost of an application that cannot be debugged for the customers who do |
| Enforcing the install id | Section 2.2. It cannot be proved without fingerprinting, and fingerprinting is refused above |

## 9. What is uncertain, and should be decided rather than assumed

Named rather than hidden, because a spec that hides its uncertainty is worse than one that admits it.

1. **Whether an unlicensed first-run window should exist at all, and whether 30 days is right.** The maintainer supplies hardware with the software already on it, so an install that has never seen a licence may simply never happen — in which case the window is a safety margin for the installer rather than a trial, and it could be much shorter.
2. **Fourteen days of grace is a guess.** It should follow the payment terms in the agreement, which do not exist yet. Grace shorter than the customer's own payment cycle guarantees false lapses.
3. **Thirty days of "expiring" notice is a guess**, chosen to be long enough for an invoice to be raised, sent, and paid.
4. **Forty-eight hours of clock tolerance is a guess.** Somebody should check what a dead CMOS battery actually does on the specific hardware being shipped, because that is the failure this number exists to absorb.
5. **The 400-day per-boot advance cap** (section 3.4) is a number picked to be comfortably over a year. It is untested against a real scenario, and no real scenario has been observed.
6. **Whether `document:generate` should be available when lapsed.** The argument for is that a contractor must be able to reprint what he already sent. The argument against is that it writes a `files` row and could be used to produce new documents from a system that is meant to be frozen. It is currently permitted, and the discomfort is real.
7. **Recording a payment received, when lapsed.** Not yet a named capability, but it will be. It is a write, so this design blocks it — and blocking it means the customer's books are wrong about money that actually arrived. That is a bad outcome from a subsystem whose whole justification is not making the customer's records worse. **This should be settled with whoever does the year end before invoicing capabilities land**, and it may well be the exception that proves the rule.
8. **Whether `admin` should see the licence screen at all**, or only `owner`. Currently readable by both, editable by owner.
9. **`EdDSA` availability** on the exact `jose` and Node versions the image ships (section 2.1). Verify at implementation; `ES256` is the fallback.
10. **Whether to index `audit_log.changed_at`** and read the corroborator more often than once per boot (section 3.2). It depends on how big that table actually gets, which nobody knows yet.
11. **Whether the signed timestamp in the manifest** (section 3.5) is worth the complication for the small number of installs that have internet and would also be inclined to roll a clock back.

## 10. The legal questions, which this document does not answer

Flagged for a lawyer, not answered here. Each of these is a question about law and jurisdiction, and an engineering document that guessed at them would be worse than one that names them.

1. **Whether a remote or automatic degradation of software function is lawful**, in the jurisdictions the product is sold into, and under what disclosure. There are statutes and case law in this area in several places, they differ, and the differences matter. The design has deliberately chosen the mildest available mechanism, which should make the question easier — but it does not answer it.
2. **What the agreement must disclose, and how prominently**, for the degradation in section 5 to be an agreed term rather than an imposed one.
3. **Whether the degradation is proportionate** as a contractual remedy for non-payment, and whether it needs to be paired with notice periods beyond the in-app banners.
4. **Who owns the data, and what the customer's guaranteed route to it is** if the relationship ends — including the `age` key question in section 5.5, which is the sharpest version of this and which currently has an unsatisfactory answer.
5. **Whether the backup encryption arrangement in main design 8.2/8.4 is defensible as it stands**, with the private key held only by the maintainer. This is the item most likely to matter and least likely to have been considered.
6. **Whether personal information in the backups** — customer names, addresses, subcontractor business numbers or SINs for T5018 — creates obligations on the maintainer as a party who can decrypt them, separate from anything about licensing.
7. **What happens to a licence on a change of control** of the customer's business, or on insolvency, when the hardware is sold with the data on it.

Items 4, 5 and 6 are not licensing questions and are more urgent than the licensing is.

## 11. Phasing

**LIC-1, and it is small.** Token verification with the embedded public key, the claims in section 2.2, the `settings` keys, the state machine in section 6.1, the licence screen with paste, the banner, the guard integration, the environment-check row, and the tests. Everything in this phase is offline and needs no signing infrastructure beyond a script and a key in a password manager.

**LIC-2.** The high-water mark and clock-warning display (section 3), which are worth having and are worth having *after* the states are known to work, because a clock mechanism debugged at the same time as a state machine is two unknowns in one bug.

**LIC-3, if ever.** The signed timestamp in the manifest (section 3.5). It is genuinely cheap and genuinely optional, and it should not be built until an install exists that would benefit.

**Not phased, and it comes first: the licence agreement.** The code in LIC-1 should be written against a document that says what it does, not the other way around, because writing the agreement second means writing it to match whatever the code happened to do.

## 12. Decisions made on the maintainer's behalf

1. **Repository secrecy is the achievable part and is already achieved. Image readability and runtime access are not fixable, and no further money is spent on them.** Carried forward unchanged from distribution section 2.
2. **The licence is an Ed25519-signed JWS verified with `jose`; the private key never leaves the maintainer's machine.** Forgery is the one attack that would scale, and it is cheap to close.
3. **The check can be patched out by anyone with root, and that is accepted rather than fought.** Every countermeasure costs support or breaks the offline premise, and the population does not contain the adversary.
4. **The install token remains the primary lever**, because it acts on the maintainer's side of the wire and withholds future value rather than confiscating paid-for value.
5. **The install id is bookkeeping, never enforcement.** Hardware binding is refused because restore-onto-new-hardware is the documented disaster path.
6. **The licence goes in `settings` and may be pasted into a form**, breaking the never-collect rule, because it is not a credential and because annual renewal by a non-technical owner must not require editing a Compose file.
7. **Clock rollback, not forgery, is the real attack**, and it is met with a monotonic high-water mark corroborated by `settings.updated_at` and the audit log.
8. **The rollback response is a visible notice, not a punishment**, because the mechanism cannot distinguish fraud from a dead CMOS battery — and one of those is much commoner than the other.
9. **A forward-poisoned clock cannot brick an install**, because the worst state in this whole design is read-only.
10. **There is no activation, no heartbeat, no licence server, and no revocation.** The product runs on a box that may have no internet, and a scheme that assumes connectivity contradicts what is being sold.
11. **A lapsed licence degrades to read-only. It never hard-stops, never deletes, never encrypts, and never blocks export, printing, backup, or sign-in.** Commercially, legally, and contractually, this is not a close call.
12. **The backup job runs outside the application**, so nothing in this subsystem can stop a customer's data being protected, even by accident.
13. **Four states plus two failure states, with one banner and one screen**, and every state returns to Valid the moment a newer licence is saved, offline, without a restart.
14. **The check lives in `guard()`, never in the proxy**, because the proxy establishes identity and does not decide entitlement, and because a path-based read/write allowlist is the fragile thing the capability matrix already replaced.
15. **Capability is checked before licence**, so only a request that would otherwise have succeeded is refused for licensing reasons.
16. **The licence check fails OPEN, where the setup gate fails CLOSED, and the asymmetry is deliberate.** The setup gate guards a destructive write; this gate only removes capability. Failing closed here would lock a paying customer out of his own books because a row was briefly unreadable, and it would concede nothing that section 2.5 has not already conceded.
17. **Failing open is always visible**, on the banner and on the licence screen, so an install running open is never running silently.
18. **No new table, no new column, no migration.** `settings` under a `licence.` prefix, where absence is the off state.
19. **Obfuscation, bytecode, fingerprinting, activation servers, self-integrity checks, licence-derived database encryption, kill switches, seat counting, and revocation lists are all refused**, each for a stated reason, in section 8.
20. **Whatever is built is written into the licence agreement in plain words, and the agreement never describes more than the code does.** The agreement is written first.
21. **The `age` backup key arrangement is flagged as a larger problem than the licensing**, and escrowing the customer's own recipient key is proposed but not decided, because part of it is a legal question.

## 13. Consequent changes elsewhere

- **`src/lib/licence/`** — new: verification, evaluation, the high-water mark, and the `settings` accessors. One module owns the `licence.` prefix.
- **`src/lib/auth/guard.ts`** — the licence check after the capability check, and a refusal sentence.
- **`src/lib/auth/permissions.ts`** — a second `satisfies`-checked record classifying every capability as record-changing or not, so a future capability cannot be added without a decision here.
- **`Settings → Licence`** — new screen: state, dates, identifiers, clock warning, and the paste field.
- **`src/components/ui/AppShell.tsx`** — the banner slot, with the licence notice taking precedence over the update notice.
- **`src/app/setup/environment.ts`** — one more `EnvironmentCheck` row, `off` rather than `fail` when no licence is installed.
- **The image** — the current and next public keys as product constants, exempt from the white-label guard with a comment saying why, per distribution section 5.3.
- **CI** — no change. The signing key does not go near it.
- **A signing script** — offline, in the maintainer's hands, not in this repository's runtime path.
- **`INSTALL.md`** — where the licence comes from and how to install it before first boot.
- **The runbook** — renewal, what each state looks like, what to tell an owner who reports a clock warning, and the fact that a box off for years takes a few restarts to catch its high-water mark up.
- **The licence agreement** — a deliverable, not a code artifact, and per distribution section 6 it remains the actual protection for the work.
