# Multi-Provider SSO — Contractor Quote & Project Management System

**Companion to** `2026-08-30-jobbook-design.md` (sections 2.1, 3.3, 4, 7, 8.6) and `2026-08-30-distribution-and-updates.md`
Date: 2026-09-04
Status: Awaiting review

The requirement, in the owner's words: "integrate SSO with Google, Apple and Microsoft — this would be under users where admin selects what type of login the user has."

So: a per-user sign-in method, chosen by the person administering the system, on the users screen. This document decides where that sign-in happens, what it stores, what the administrator sees, and what breaks when a provider does. It is written as a set of decisions with their reasons, in the same form as the documents it accompanies, and it overrules three lines of the main design where it has to; each overrule names the line.

**Why this exists.** The main design assumes one company with Microsoft 365 behind Cloudflare Access. The product is sold to more than one company. The second company may run on Google Workspace, the third may have staff whose only account is an Apple ID, and the fourth may have no Cloudflare account and no intention of getting one. Authentication is the one subsystem where "we will add it later" produces a migration of every user, so the shape is decided now even though the first deployment does not need it.

---

## 1. Where sign-in happens

### 1.1 Three modes, exactly one active

Today `src/lib/auth/access.ts` knows two modes: Cloudflare Access, and `AUTH_MODE=local` for a LAN or a laptop under test. It refuses to run both at once, on the grounds that a half-configured tunnel silently falling back to "everyone is the owner" is the failure it exists to prevent. That discipline is kept and extended.

This design adds a third mode. `AUTH_MODE` takes exactly one of three values:

| `AUTH_MODE` | Who proves identity | Who chooses the sign-in method |
|---|---|---|
| `access` | Cloudflare Access, at the edge, before a request reaches the container. The app verifies the Access JWT exactly as it does today | The Access application's policy in the Cloudflare dashboard. The app's per-user picker is hidden |
| `sso` | The app itself, through OpenID Connect against Google, Microsoft, or Apple. The app issues its own session cookie | The owner, per user, on the users screen. This is the mode the requirement describes |
| `local` | Nobody. A named user from the environment, unchanged from today | Nobody. There is no sign-in |

**The three are mutually exclusive, enforced at boot.** `access` refuses to start if any `SSO_*` variable or `LOCAL_USER_EMAIL` is set. `sso` refuses if `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, or `LOCAL_USER_EMAIL` is set. `local` refuses if any `CF_ACCESS_*` or `SSO_*` variable is set. Each refusal names the offending variable, as `localIdentity()` does now. A deployment that has been half-migrated from one mode to another does not come up; it says why.

**"Both, in a defined order" is rejected.** The obvious middle path is to let Access handle identity when present and fall through to in-app SSO when the Access header is absent. That is exactly the shape access.ts was written to refuse: a request with no Access header is either a misconfigured tunnel or an attacker who has reached the container by another route, and neither should be offered a second door. Running both also doubles the unauthenticated surface — the app's `/auth/*` routes would be reachable behind Access for no reason — and gives every future auth bug two code paths to be present in. One mode, chosen by the installer, is the design.

### 1.2 `AUTH_MODE` becomes required

Today an unset `AUTH_MODE` means Access. With three modes that default is a guess, and a guess in authentication configuration is precisely what the interlock exists to prevent. **An unset or unrecognised `AUTH_MODE` refuses to boot**, with the message naming the three accepted values. `docker-compose.app.yml` currently writes `AUTH_MODE: ${AUTH_MODE:-local}`; the default there is removed so the value has to be stated in `.env`. The test in `tests/unit/auth.test.ts` that refuses an unrecognised mode already exists and extends naturally.

This is a behavioural change to a shipped file, recorded here so nobody treats the refusal as a regression.

### 1.3 Which deployments get which mode

Cloudflare Access can itself federate Google, Microsoft, and Apple, and it does so with MFA policy, device posture, session logging, and a WAF in front of the container. Where it is available it is the better answer, and the owner's requirement is met there too — the sign-in methods a person may use are chosen in the Access policy rather than in the app.

| Deployment | Mode | Reason |
|---|---|---|
| A company with a Cloudflare account, on Microsoft 365 — the first deployment | `access` | Already built, already tested, and the container never sees a credential |
| A company with a Cloudflare account whose staff are split across Google, Microsoft, and Apple accounts | `access`, with those identity providers added to the Access application | Access supports all three. Adding them is dashboard configuration, not code, and the per-user restriction is an Access policy rule keyed on email |
| A company with no Cloudflare in front: a VPS behind its own reverse proxy, a different tunnel product, or an IT policy that refuses to put identity in Cloudflare | `sso` | There is nothing at the edge to do the job, so the app does it |
| Development, or a mini PC tested on the office LAN before the tunnel exists | `local` | Unchanged |

Two things worth being honest about. Cloudflare's Zero Trust plan is free for the first fifty users, so cost is not the reason a company ends up in `sso` mode; the absence of Cloudflare is. And **`sso` mode makes the Next.js application the internet-facing authentication surface**, which `access` mode never was. Its `/auth/*` routes are the only unauthenticated routes besides `/api/health`, they are rate-limited (section 5.6), and the cost is accepted knowingly rather than hidden.

### 1.4 How the app knows its mode, and where the seam is

`AUTH_MODE` is read once, at boot, into a frozen module-level value; nothing re-reads the environment per request. `src/lib/auth/access.ts` keeps its current name and contents for the Access and local paths. The OIDC path lives in a new directory, `src/lib/auth/oidc/`, and a small `src/lib/auth/mode.ts` selects between them. `proxy.ts` calls one function, `identify(request)`, as it does now; the mode decides what that function does.

The seam is deliberate: everything provider-specific sits in one directory so that the library decision in section 6.5 can be reversed by replacing that directory and nothing else.

### 1.5 What the picker does in each mode

In `sso` mode the users screen carries a **Sign-in method** field per user, with the providers the deployment has configured (section 7). In `access` mode the field is replaced by a single read-only line, "Sign-in is managed by Cloudflare Access", with the team domain, so the owner is not hunting for a dropdown that is not there. In `local` mode the users screen shows a notice that no sign-in is enforced.

**Per-user method enforcement in `access` mode is refused.** It is possible — Cloudflare exposes `/cdn-cgi/access/get-identity`, which reports which identity provider a session used — but it would make the app second-guess a decision Access already owns, with a second network call per session and a second place for the two to disagree. If a company in `access` mode wants a person restricted to one provider, that is one rule in the Access policy.

### 1.6 What this document overrules

Three lines of the main design change. Everything else it says about authentication stands.

| Where | It says | It becomes | Why |
|---|---|---|---|
| Section 3.2, stack table, `Auth` row | "Cloudflare Access JWT + Entra ID" | "Cloudflare Access with any identity provider it federates; or in-app OpenID Connect against Google, Microsoft, or Apple when no Access is present" | The product is sold to companies that are not on Microsoft 365 and companies that are not on Cloudflare |
| Section 3.3, "Role resolution happens in route handlers against a cached lookup, not as a database query per request inside the proxy" | The proxy never touches the database | In `sso` mode the proxy consults the session store, through an in-process cache that keeps it from being a query per request | Stateful sessions are the price of revocation, and revocation is what the owner's picker is for (section 5.1) |
| Section 8.6, step 6, "the signed-in identity becomes `owner`" | First to sign in owns the deployment | In `sso` mode, only the identity named by `SSO_BOOTSTRAP_OWNER_EMAIL` becomes owner | Behind Access the first arrival is already vetted; on a public URL it is a stranger (section 7.3) |

One line is refined rather than overruled: section 3.3's "Users are keyed on email" remains true of the row and stops being true of authentication after the first sign-in (section 4.1). And one shipped behaviour changes: `access.ts` treating an unset `AUTH_MODE` as Access becomes a refusal to boot (section 1.2).

## 2. Schema

Everything here follows section 4 of the main design: UUID keys, the audit columns on every mirrored table, no DELETE anywhere, and no secret in any table. The generated SharePoint template (section 7.4 there) picks these tables up automatically, so what is mirrored is stated explicitly.

### 2.1 What must not be stored

Stated first, because it is the constraint everything else bends around.

| Never stored | Why |
|---|---|
| Client IDs, client secrets, the Apple private key, the Apple team and key IDs | Configuration that gates credentials lives beside the credentials, in the container environment (main design, section 7.0). A database row is mirrored to SharePoint and lands in every backup |
| Access tokens and refresh tokens from any provider | The app never calls a provider API after sign-in. It has no use for a token and no `offline_access` scope is ever requested, so there is nothing to store |
| The raw `id_token` | It is verified, its claims are read, and it is discarded. Storing it would keep a bearer credential in a mirrored table |
| The plaintext session token | Only its SHA-256 lands in `sessions`. A dump of the database yields no cookie anyone can present |
| OAuth `state`, `nonce`, and the PKCE verifier | They live in a short-lived encrypted cookie for the duration of one sign-in attempt (section 5.3). Rows per button click would fill a table with bot traffic |
| The provider-supplied display name | The owner enters `display_name` when creating the user, and the provider's version is ignored. This is also what makes Apple's once-only name (section 6.3) a non-issue |

### 2.2 `users` gains one column

```
users
  ... existing columns ...
  login_method ENUM('google','microsoft','apple')   -- nullable
  -- The owner's CHOICE of how this person signs in. NULL means no method has
  -- been chosen, and in sso mode a user with NULL cannot sign in. In access
  -- and local mode the column is ignored: Access or the environment decides.
  -- Which account actually linked is recorded in user_identities, not here.
```

A new enum `login_method` with those three members mirrors to SharePoint as Text, like every other enum. `user_identities.provider` uses the same enum, and the sign-in code refuses a link whose provider differs from the user's `login_method`.

The existing comment on `users` in `src/db/schema/organization.ts` ("Keyed on email... email suffices here") stays true for the row's identity — email remains the field the owner types and the field that is UNIQUE — and is refined rather than overruled: after a first successful sign-in, **authentication keys on the provider's stable subject, not on email**. Section 4 explains why. The comment is updated at implementation to say so.

Emails are normalised to lowercase and trimmed at every write boundary, and the first-link comparison lowercases both sides. A one-line migration lowercases existing rows. No functional index is added; the existing unique index on `email` is sufficient once the value is normalised on the way in.

### 2.3 New table: `user_identities` — mirrored

```
user_identities
  id,
  user_id FK users,
  provider ENUM('google','microsoft','apple'),
  subject text,               -- Google sub; Microsoft oid; Apple sub
  tenant_id text,             -- Microsoft tid; NULL for Google and Apple
  email_at_link text,         -- what the provider reported when the link was made
  email_verified_at_link bool,
  last_seen_email text,       -- what the provider reported most recently
  is_private_email bool,      -- Apple relay address
  linked_at timestamptz,
  last_sign_in_at timestamptz,
  ...audit columns
  UNIQUE (provider, tenant_id, subject) NULLS NOT DISTINCT
  PARTIAL UNIQUE (user_id) WHERE record_status = 'active'
  -- One ACTIVE identity per user. Changing a user's login method voids the
  -- current row and a new one is created on the next sign-in; the history of
  -- which account was linked when is kept, like tax_rates.
```

Why a table and not columns on `users`: a person's link changes over time — the owner switches them from Google to Microsoft, or their Google Workspace account is deleted and recreated with a new `sub` — and every one of those changes is an event worth keeping. Columns on `users` would overwrite; rows in `user_identities` are voided with a reason and replaced. That is the same pattern `tax_rates` uses for the same reason.

`NULLS NOT DISTINCT` is PostgreSQL 15+ and Drizzle 0.45 exposes it as `.nullsNotDistinct()` on `uniqueIndex`. Without it the NULL `tenant_id` on every Google and Apple row would make the unique constraint a no-op for two of the three providers.

Nothing in this table is a secret. A Google `sub` is a 21-digit number that means nothing outside Google; an Entra `oid` is a directory GUID. They mirror to SharePoint as Text like every other identifier, and the list's `Title` is set to `email_at_link`.

### 2.4 New table: `sessions` — local only, not mirrored

```
sessions
  id uuid primary key,
  user_id FK users,
  token_hash text unique,     -- SHA-256 of the cookie value; the value itself is never stored
  created_at timestamptz,
  last_seen_at timestamptz,   -- advanced at most once per hour, see 5.2
  expires_at timestamptz,     -- absolute expiry, fixed at creation
  revoked_at timestamptz,     -- set by sign-out, deactivation, or a method change
  revoke_reason text,
  user_agent text, ip text    -- for the "where am I signed in" list; bounded to 255
```

Listed alongside `settings`, `sync_state`, and `sp_item_map` as **not mirrored**, and like them it carries no audit columns: machine state has no business in SharePoint, and a session row is as far from a tax record as a table gets. Section 7.4's "Not mirrored" list in the main design gains `sessions`; its "Lists created" list gains `user_identities`.

**No DELETE, and no pruning job either.** A row is a sign-in; three users signing in twice a day produce about two thousand rows a year, each a few hundred bytes. A decade of that is smaller than one uploaded receipt photo. Rows expire by `expires_at` and are ignored; nothing removes them. A `SECURITY DEFINER` prune function owned by the migration role was considered, so that the application role could stay without the DELETE privilege while still bounding the table, and dropped as machinery for a problem that does not exist at this scale. It is the right answer if a deployment ever has hundreds of users, and it is noted here so it is not re-derived.

### 2.5 What changes elsewhere

The main design's section 7.4 lists change as stated above. Section 8.4 ("What backups do not hold") gains the SSO client secrets, the Apple private key, and `SSO_COOKIE_SECRET`. The white-label grep in section 11 gains nothing — provider hostnames are product constants like the manifest URL (distribution spec, section 5.3) and are exempt with a comment, while tenant GUIDs, client IDs, and workspace domains are environment values and never appear in code.

## 3. The administrator's experience

### 3.1 Who the administrator is

**Revised 2026-09-04 on the owner's instruction**, which was: "as long as admin controls the permission for user I don't care how user logs in, SSO or local account." An earlier draft of this section reserved user management to the `owner` role. That is overruled. **The `admin` role manages users, their roles, and their sign-in method**, and section 10 is the authority on exactly what each role may do.

The instruction settles a larger question too, and it is worth stating plainly because it reorders the priorities of this whole document: **the sign-in method is a deployment detail; the permission model is the requirement.** Which provider a person presses is interchangeable, and may differ per user, per deployment and per mode. What may never vary is that permission is decided by the application, per request, against `users.role` -- never by the identity provider, and never inferred from the fact that somebody managed to sign in at all. Sections 1 through 9 describe three ways of establishing *who* a person is. Section 10 describes *what they may do*, and it reads identically in all three.

Four guardrails survive the revision, because handing `admin` the users screen without them turns a lockout into a takeover, which was the original objection and remains a real one:

1. An `admin` may not create, edit, deactivate, or change the sign-in method of a user whose role is `owner`. Owner rows are visible to an `admin` and read-only.
2. An `admin` may not grant the `owner` role to anyone, themselves included. Only an `owner` promotes an `owner`.
3. Nobody, at any role, changes their own role. Self-elevation is refused even for an `owner`; a second owner or the recovery script in section 3.5 does it.
4. The last active `owner` cannot be deactivated or demoted, by anyone. This one is enforced in the database as well as the application, because it is the only rule whose failure leaves no route back in through the interface.

### 3.2 What the owner sees

`Settings → Users` lists every user, active by default with a toggle for inactive ones, in the same table primitive as every other list. Per row:

| Column | Source | In `access` mode |
|---|---|---|
| Name | `users.display_name` | Same |
| Email | `users.email` | Same |
| Role | `users.role` | Same |
| Sign-in method | `users.login_method` — Google, Microsoft, Apple, or "Not set" | Replaced by "Managed by Cloudflare Access" |
| Link | Derived from the active `user_identities` row: "Not yet signed in", or "Linked", with the date | Hidden |
| Last sign-in | `user_identities.last_sign_in_at` | Hidden |
| Status | `users.is_active` | Same |

The sign-in method picker offers only the providers this deployment has configured. A deployment with Google and Microsoft credentials in its environment offers two options, not three, and the picker says why the third is absent ("Apple is not configured on this installation"). Offering a method that cannot work is a support call.

**Adding a user** takes name, email, role, and sign-in method, and nothing else. There is no invitation, because the application sends no email (distribution spec, section 4, item 2). The owner tells the person the address; the person opens it, presses the provider button, and if the provider's verified email matches, they are in. The owner sees the row change from "Not yet signed in" to "Linked".

### 3.3 Changing a user's sign-in method

The owner picks a different method and confirms a dialog that states the consequences plainly: "Jane will be signed out of every device now, and must next sign in with Microsoft using an account whose email is jane@example.com." On confirmation, in one transaction:

1. The active `user_identities` row is voided, `void_reason` set to `method changed by owner`.
2. `users.login_method` is set to the new value.
3. Every active session for the user is revoked, `revoke_reason` set to `method changed`.
4. The in-process session cache drops the user's entries (section 5.1).

The user's next visit lands on the sign-in page, and the next sign-in goes through first-link matching (section 4.2) against the new provider. Nothing about the old link is lost; the voided row is the record of it.

Two adjacent actions live on the same row. **Reset link** voids the identity and revokes sessions without changing the method — for the person whose Google account was deleted and recreated under the same address, and so has a new `sub` that will otherwise be refused (section 4.3). **Sign out everywhere** revokes sessions and touches nothing else.

### 3.4 A user who cannot sign in

The sign-in page cannot know who is about to sign in, so it shows every configured provider. Enforcement happens after the provider has spoken. The possible outcomes, and what the person sees:

| Situation | What the person sees | What the owner sees |
|---|---|---|
| No `users` row with that verified email | "There is no account for this email address. Ask the owner to add you." | Nothing. There is no row to annotate |
| Row exists, `is_active = false` | "This account has been deactivated." | The row, marked inactive |
| Row exists, `login_method` NULL | "The owner has not chosen a sign-in method for this account yet." | "Not set" in the method column |
| Row exists, provider used differs from `login_method` | "This account signs in with Microsoft." — naming the correct one | Nothing new |
| Provider returned an unverified email, or Apple hid it | Section 4.4 | Nothing new |
| Provider refused, or its configuration is broken | "Sign-in with Google is not working right now. Reference 7f3a…" | The reference in the container log beside the provider's actual error |

The messages after a successful provider round-trip are specific because by then the person has proved control of the email address they are being told about. Before that point — on the sign-in page itself — nothing is said about which emails exist. An email-first flow, where the person types their address and is shown one button, was considered and rejected: it makes the sign-in page an account-enumeration oracle, adds a step, and gains nothing the post-callback check does not.

### 3.5 Lockout: the last owner's provider stops working

Three real ways this happens. The Apple developer account lapses and Apple stops honouring the Services ID. The Microsoft tenant administrator revokes the enterprise application or turns on a Conditional Access rule the app cannot satisfy. The Google Cloud project is deleted by someone tidying up. In each case every user on that provider is locked out, and if the only owner is among them, nobody can change anyone's method.

**Recovery is a command run on the box, not a web route.** `scripts/auth-recover.ts`, run through `docker compose exec app`, can do exactly three things: set a user's `login_method`, set `is_active`, and set `role`. Each writes an `audit_log` row with `changed_by` NULL and the operator's stated reason. It has no HTTP surface and no credential of its own; possessing a shell on the box is the credential, which is already true of the database password and every other secret in section 8.4 of the main design.

The existing `AUTH_MODE=local` LAN mode was considered as the recovery path, since it already exists and is already tested. It is rejected for this purpose: in `sso` mode the tunnel is running with no Access in front of it, and switching to `local` while it runs means every request from the internet resolves to the owner until someone remembers to stop the tunnel container. A script that changes one row has no such window.

The runbook records the script, its three operations, and the instruction that the fix for the provider itself — a lapsed Apple account, a revoked Entra consent — happens in the provider's console and then in the container environment, not in the database.

## 4. Account linking and identity matching

### 4.1 Two keys, used at two different times

Email is what the owner types and what makes a `users` row unique. It is also the only thing the app knows about a person before they have ever signed in. So the **first** sign-in must match on email; there is no alternative.

Email is also mutable at the provider, occasionally unverified, and for Apple sometimes a relay address. It is therefore the wrong thing to authenticate on **after** the first sign-in. Every provider issues a stable subject — Google `sub`, Microsoft `oid` within `tid`, Apple `sub` — that does not change when the address does. Once `user_identities` holds that subject, it is the key, and the email the provider reports is information the owner may want, not a credential.

This is the refinement of section 3.3's "Users are keyed on email" promised in section 2.2. The row is keyed on email. Authentication, after the first time, is not.

### 4.2 First sign-in: the link

A verified `id_token` arrives with claims `(provider, subject, tenant_id, email, email_verified)`. No active `user_identities` row matches `(provider, tenant_id, subject)`. The app then:

1. Refuses unless the provider's email is verified, by that provider's rule (section 6).
2. Lowercases and trims the email and looks up `users` by it.
3. Refuses if there is no row, the row is inactive, `login_method` is NULL, or `login_method` differs from the provider.
4. Refuses if the row already has an active identity — a different account with the same email is trying to take over an account that is already linked. The owner resolves this with Reset link.
5. Inserts the `user_identities` row, `email_at_link` and `email_verified_at_link` filled from the claims, and opens a session.

Steps 1 through 4 are refusals, and every one of them is closed: no fuzzy match, no alias resolution, no "close enough". Gmail treats `j.doe@` and `jdoe@` as one inbox; this app does not, because the owner enters whatever address Google reports, and a normalisation rule that is right for Gmail is wrong for every other provider.

**Users are never created by sign-in.** Just-in-time provisioning — "anyone from our domain who signs in gets an account" — is refused. The owner adds people; the provider only proves who they are. A contractor's quoting system with margins on every line is not something a new hire should reach before the owner has decided their role.

### 4.3 Subsequent sign-ins: the match

The active identity for `(provider, tenant_id, subject)` is found; the user it points at is active and its `login_method` still equals the provider. A session opens. `last_sign_in_at` is stamped; `last_seen_email` is updated if it differs.

The four things that can go wrong after a link exists, and the decision for each:

| Provider now reports | Decision | Reason |
|---|---|---|
| A different email for the same subject | Sign-in succeeds. `last_seen_email` records it. `Settings → Users` shows "Google now reports jane.smith@ for this account" until the owner edits `users.email` or dismisses it | The subject proves it is the same person. `users.email` is the UNIQUE key and is never rewritten automatically — a deactivated user could already hold the new address, and an automatic rename that collides is worse than a notice |
| The same email from a different subject | Sign-in refused: "This email is linked to a different account. Ask the owner to reset the link." | It is either a recreated provider account, which the owner fixes with Reset link in ten seconds, or someone who has obtained an account with a colleague's address, which the owner should hear about |
| A subject that matches but `login_method` has changed | Refused, with the message naming the new method | The identity was voided when the method changed (section 3.3); this row is void and does not match |
| A subject that matches but the user is inactive | Refused | `is_active` is checked on every session lookup, not only at sign-in |

### 4.4 Apple, and emails that are not there

Apple is the provider that stresses this design, and each of its behaviours has a decision.

**Hide My Email.** A person can authorise with a relay address of the form `xxxxx@privaterelay.appleid.com`, and Apple forwards mail sent to it. It is a verified email, and `is_private_email` is `true` in the token. On a first sign-in it will not match the address the owner entered, so the link is refused — with a message that says what happened: "Your Apple ID hid your email address. Sign in again and choose Share My Email, or ask the owner to enter your relay address." The second option is allowed on purpose: a person who wants their real address kept from their employer's quoting system may say so, the owner may enter the relay address as `users.email`, and the link then succeeds. The app never sends mail, so a relay address costs it nothing. The sign-in page states above the Apple button that sharing the email is required for the first sign-in, because the failure is otherwise mysterious.

**The once-only name.** Apple delivers the person's name in the `user` form field alongside `code` on the first authorisation only. Every later token carries no name. This design ignores the name entirely: `display_name` is the owner's field, set when the row was created. Nothing needs to be caught on the first pass, so nothing is lost when it is absent.

**Stop Using Apple ID.** When a person revokes the app in their Apple ID settings, the next authorisation behaves like a first one — the name is sent again and a new relay address may be issued — but `sub` is unchanged. Because the match keys on `sub`, this is an ordinary subsequent sign-in with a possibly different `last_seen_email`, handled by the first row of the table above.

**`email_verified` arrives as a string.** Apple sends `"true"` as a string in some tokens and a boolean in others. The claim reader accepts either and treats anything else as false. This is noted here because it has been a production outage for other people.

**No email at all.** Google and Microsoft can, in principle, return a token without an `email` claim — a Microsoft account with no mail attribute, a Google account with the `email` scope omitted. The app requests the `email` scope from every provider and refuses a first link whose token lacks the claim, with a generic message. There is nothing to match on and the app does not guess.

## 5. Sessions

### 5.1 Where session state lives, and why it is stateful

Sessions are rows in PostgreSQL, looked up through an in-process cache. Not a signed stateless cookie, and not Redis.

**Stateful, because the whole administrative story in section 3 is revocation.** The owner changes a method, deactivates a person, or presses Sign out everywhere, and the effect must be immediate. A signed cookie cannot be revoked; it can only expire, and "your access ends in up to seven days" is not what the owner pressed the button for.

**PostgreSQL, because it is already there and survives a restart.** The alternative that would normally be reached for is Redis, and it would be a fourth container on a mini PC for a table of two thousand rows a year. Postgres is durable across the reboots section 3.1 of the main design accepts as routine, and a session that survives an unattended 3am update is one fewer thing the owner notices.

**An in-process cache, because there is one process.** The standalone Next.js server is a single Node process, so a `Map` from `token_hash` to `{ userId, role, expiresAt }` with a sixty-second TTL is coherent by construction: revocation deletes the entry synchronously and hits the database in the same transaction, and there is no second process holding a stale copy. Section 3.3 of the main design says "role resolution happens in route handlers against a cached lookup, not as a database query per request inside the proxy"; in `sso` mode the proxy does consult the session store, and this cache is what keeps that from being a query per request. If the app is ever run as more than one process, the cache is dropped and every request pays one indexed read — slower, still correct. That is stated so the cache is never mistaken for a correctness mechanism.

### 5.2 The cookie

| Attribute | Value | Reason |
|---|---|---|
| Name | `__Host-session` | The `__Host-` prefix makes the browser refuse the cookie unless it is `Secure`, has `Path=/`, and carries no `Domain`. A cookie set by any other host, or over plain HTTP, is rejected by the browser before the app sees it |
| Value | 32 random bytes, base64url | Opaque. Carries no claim; the row does |
| `HttpOnly` | Yes | Script never reads it |
| `Secure` | Yes | Required by the prefix. Chrome and Firefox treat `http://localhost` as a secure context, so development works; a LAN address over plain HTTP does not, and `sso` mode needs HTTPS for the provider redirect URIs anyway |
| `SameSite` | `Lax` | `Strict` would drop the cookie when someone follows a quote link from a Teams message or an email, and they would be sent to sign in while already signed in. `Lax` still withholds the cookie from cross-site POSTs, which is what matters for CSRF |
| `Path` | `/` | Required by the prefix |
| `Max-Age` | Not set — a session cookie | The browser discards it on close; the server-side row still governs |

Lifetimes are on the row, not the cookie. **Idle: 7 days. Absolute: 30 days.** A contractor on a phone in a truck signs in perhaps weekly, and the provider itself keeps its own session for far longer; forcing a re-authentication every workday buys nothing, because the owner can revoke server-side at any moment. `last_seen_at` advances at most once per hour, so a busy afternoon on the worksheet costs one write rather than one per request. When the idle window is crossed the row is treated as expired and the person signs in again; there is no silent renewal past the absolute limit.

The cookie is issued once, at the end of a successful callback, and is not rotated on each request. Rotation would cost a write per request for a threat — cookie theft — that `HttpOnly` plus `Secure` already addresses at the browser and that rotation would not fully close.

### 5.3 The transient sign-in cookie, and why Apple forces its shape

Between "press the Google button" and "the callback arrives" the app must hold `state`, `nonce`, the PKCE verifier, the provider name, and the URL to return to. They live in a second cookie, `__Host-auth_state`, encrypted with `jose` A256GCM under `SSO_COOKIE_SECRET`, `HttpOnly`, `Secure`, ten-minute expiry, cleared when consumed.

**Its `SameSite` is `None`, not `Lax`, and this is Apple's doing.** Apple returns the authorisation as a cross-site `POST` from `appleid.apple.com` (`response_mode=form_post`, mandatory when the `name` or `email` scope is requested). A `Lax` cookie is not sent on a cross-site POST, so a `Lax` state cookie is invisible to the Apple callback and every Apple sign-in fails with "state mismatch". Google and Microsoft return by GET redirect, where `Lax` would suffice. One cookie, one attribute, set for the strictest provider; the encryption and the ten-minute life bound what `None` gives up.

Encrypted rather than signed, because a signed cookie is readable and the PKCE verifier is in it. Stored in a cookie rather than a table, because every bot that hits the sign-in page would otherwise create a row.

### 5.4 Sign-out

`POST /auth/sign-out` revokes the row, drops the cache entry, clears the cookie, and redirects to the sign-in page. It is a POST, not a link, so an `<img src>` on another site cannot sign the person out. **Sign out everywhere**, in the user menu and on the owner's users screen, revokes every active row for the user.

**There is no provider-side sign-out.** Signing out of the quoting application does not sign the person out of Google, Microsoft, or Apple. RP-initiated logout is technically available for two of the three and would sign the person out of their whole Microsoft 365 or Google Workspace session to leave a quoting tool. Refused.

### 5.5 CSRF

Two layers, and no synchroniser token.

The session cookie's `SameSite=Lax` means a cross-site form post arrives without it and is anonymous. On top of that the proxy checks every request whose method is not `GET`, `HEAD`, or `OPTIONS`: `Sec-Fetch-Site` must be `same-origin` or `none`, and if an `Origin` header is present its origin must equal `APP_PUBLIC_URL`. Next.js server actions already perform an equivalent origin check; the proxy extends it to route handlers so no handler can forget it. The one exemption is `POST /auth/callback/apple`, which is cross-site by design and is protected by `state` instead.

Comparing against `APP_PUBLIC_URL` rather than the `Host` header is deliberate: the redirect URI sent to each provider is also built from `APP_PUBLIC_URL`, never from the request. A redirect URI derived from `Host` is the classic path to an open redirect through host-header injection, and the tunnel does not protect against it.

### 5.6 Rate limits

`/auth/start/*` and `/auth/callback/*` are limited to 20 requests per 10 minutes per client address, in memory, on the same token-bucket shape the update module uses. Behind the tunnel the address is `CF-Connecting-IP`; without it, the socket address. The limit is not a security boundary — the provider does the real work of resisting credential attacks — it bounds a stuck form and a scanner.

### 5.7 The print route is unchanged

`/print/*` still authenticates on `INTERNAL_RENDER_SECRET` and nothing else, in every mode. Headless Chromium reaches it over localhost inside the container, so it carries no session cookie and never will; a session-based fallback there would be the hole section 6.1 of the main design closed. `/auth/*` joins `PUBLIC_PREFIXES` in `proxy.ts` **only when the mode is `sso`**; in `access` and `local` mode those paths return 404, so a deployment behind Access exposes no sign-in surface it does not use.

## 6. Provider specifics

The three providers all speak OpenID Connect and all differ in the places that cause outages. Each is treated as its own small adapter in `src/lib/auth/oidc/providers/`, with the shared flow — build the authorisation URL, exchange the code, verify the token, read the claims — in one place.

### 6.1 Microsoft (Entra ID)

**Single tenant, or consumers. Never `common` or `organizations`.** `MICROSOFT_TENANT_ID` is either a tenant GUID or the literal `consumers`. The authority is `https://login.microsoftonline.com/{that}/v2.0` and discovery is read from its `.well-known/openid-configuration`.

The reason is what it does to the `email` claim. In a single tenant the email of a member account is set by that tenant's administrator, so an owner who enters `jane@company.com` can trust that the account arriving with that claim is the one the administrator gave Jane. Under `common` any tenant in the world can present a token, `email` on a work account is not guaranteed to be verified, and the app would need a maintained allowlist of `tid` values that nobody will maintain. Under `consumers` every account is a personal Microsoft account, `tid` is the fixed MSA tenant `9188040d-6c67-4c5b-b112-36a304b66dad`, and the email is the verified login of the account. Two configurations that make email trustworthy; two that do not; the two that do not are refused at boot.

Claims, and what each is for:

| Claim | Use |
|---|---|
| `tid` | Must equal the configured tenant (or the MSA tenant GUID under `consumers`). Checked explicitly, not only through `iss`, because a future authority change must not silently widen who is accepted |
| `oid` | The subject stored in `user_identities.subject`. It is the directory object id: stable across applications in the tenant, and unlike `sub` it is not pairwise per application, so a second registration of the app in the same tenant would still recognise the same people |
| `sub` | Not used. Pairwise per application; would break on re-registration |
| `email` | Requested through the `email` scope. Used only for the first link |
| `preferred_username` | Not used for anything. It is a display hint and is mutable |
| `iss` | `https://login.microsoftonline.com/{tid}/v2.0`, verified by the library against discovery |

The app registration needs: a web platform redirect URI of `{APP_PUBLIC_URL}/auth/callback/microsoft`, ID tokens enabled, the `openid`, `profile`, and `email` delegated permissions, and a client secret. Secrets in Entra expire — the maximum is 24 months — and the expiry date belongs in the runbook's rotation calendar beside the Graph certificate.

### 6.2 Google

Discovery from `https://accounts.google.com/.well-known/openid-configuration`; issuer `https://accounts.google.com`. `sub` is the subject. PKCE with `S256` is used.

**`email_verified` must be `true`, or the link is refused.** Google accounts created with a non-Gmail address can carry an unverified email; the claim says so and the app believes it.

**`hd` is checked server-side, if configured, and the request parameter is never relied upon.** `GOOGLE_HD`, optional, names a Google Workspace domain. When set, the token's `hd` claim must equal it; a personal Gmail account carries no `hd` claim at all and is refused. Sending `hd` as a request parameter only pre-selects an account in Google's chooser and enforces nothing, so it is sent as a courtesy and ignored on the way back. A deployment without Workspace leaves the variable unset and any verified Google account whose email the owner entered can link — which is the correct behaviour for a company whose staff use Gmail.

The OAuth client in Google Cloud Console needs the redirect URI `{APP_PUBLIC_URL}/auth/callback/google`, and the consent screen must be published for external users or every sign-in shows a warning. Google client secrets do not expire.

### 6.3 Apple

Apple is the provider with the most moving parts, and three of them are decided here.

**The client secret is generated at runtime, never stored as a value.** Apple does not issue a client secret. The client authenticates with a JWT that the app signs itself: ES256, `iss` the ten-character Team ID, `sub` the Services ID, `aud` `https://appleid.apple.com`, `iat` now, `exp` at most six months later, `kid` the Key ID. The signing key is a `.p8` file downloaded once from the developer portal. Most integrations generate this JWT by hand, paste it into configuration with a six-month expiry, and go down six months later. This app mounts the `.p8` as a Docker secret at the path in `APPLE_PRIVATE_KEY_FILE` and mints a fresh JWT with a five-minute expiry on every token exchange, using `jose`. It cannot expire in operation, and the only thing that can lapse is the Apple developer membership itself, which is the runbook's problem.

**`response_mode=form_post` is mandatory, and it dictates the state cookie.** Apple requires it whenever `name` or `email` is in scope. The callback is therefore a cross-site POST, which is why `__Host-auth_state` is `SameSite=None` (section 5.3) and why `POST /auth/callback/apple` is the one exemption from the CSRF origin check (section 5.5).

**The name is ignored.** Section 4.4. It arrives once, in the `user` form field as JSON, and never again. `display_name` is the owner's field, so nothing depends on catching it.

Other specifics: discovery from `https://appleid.apple.com/.well-known/openid-configuration`, issuer `https://appleid.apple.com`, JWKS at `/auth/keys`. `sub` is the subject, stable for the Team. `email_verified` may be a string. `is_private_email` indicates a relay address and is stored. Apple's documentation lists no PKCE parameters on its authorisation endpoint; the flow relies on `state`, `nonce`, and the client-secret JWT, and if Apple accepts `code_challenge` at implementation time it is sent. The Services ID needs the domain of `APP_PUBLIC_URL` and the return URL `{APP_PUBLIC_URL}/auth/callback/apple`, and Apple will not register an `http://` return URL or a bare IP, so Apple is unusable on a LAN address under any circumstances.

Apple requires a paid developer membership, which is a reason Apple ships second (section 9).

### 6.4 What is common to all three

The `id_token` is verified for signature against the provider's JWKS, `iss`, `aud` equal to the client id, `exp`, `iat` within a five-minute skew, and `nonce` equal to the value in the state cookie. A token that fails any check is refused before a single claim is read, which is the same rule `verifyAccessJwt` applies to the Access assertion. The `access_token` returned alongside is discarded unread; the app calls no userinfo endpoint, because every claim it needs is in the `id_token` and a second call is a second thing to fail. Discovery documents and JWKS are cached in process with the library's defaults and refreshed on a signature miss.

### 6.5 Library

**`openid-client` 6.x, pinned exact.** It is a certified OpenID Connect relying-party implementation by the maintainer of `jose`, which the app already depends on for the Access JWT; its only runtime dependencies are `oauth4webapi` and `jose`, both by the same author, both built on the Web Crypto and `fetch` APIs Node 22 provides. It handles discovery, PKCE, nonce, the code exchange, and `id_token` validation for all three providers without provider-specific plugins, and its `form_post` handling covers Apple.

Pinned exact, as `drizzle-orm` and `postgres` already are, because an authentication library is the one dependency where "behaves slightly differently after `npm update`" reads as "nobody can sign in". Bumps are deliberate and are followed by the manual provider checks in section 8.3.

What was not chosen, and why:

| Rejected | Reason |
|---|---|
| Auth.js / NextAuth v5 | Owns the session model and the database adapter, and this design's per-user method enforcement, stateful sessions in a no-DELETE schema, and Apple client-secret generation would all be fought against rather than used. Its v4 to v5 migration also broke nearly every consumer, which is the wrong record for a dependency in the sign-in path |
| `arctic` | Sound, small, and well maintained, but it stops at the token response and leaves `id_token` validation to the caller. Doing that by hand three times is the part most likely to be done wrong |
| `better-auth` | Large surface, young, opinionated about schema. The same objection as Auth.js with less history |
| Hand-rolled on `jose` | Viable — the code flow is perhaps four hundred lines — and it is the fallback below. Not the first choice, because discovery, PKCE, and the provider quirks are already correct in a library that exists for exactly this |

**If it is unmaintained in three years.** The OpenID Connect code flow is a finished specification and the three providers are not going to stop speaking it. The pinned version keeps working; what would stop is CVE response. The exit is one of two things, both confined to `src/lib/auth/oidc/` by the seam in section 1.4: vendor `oauth4webapi`, which is a single file with no dependencies and a permissive licence, or replace the flow with the hand-rolled `jose` implementation. Neither touches the schema, the sessions, the users screen, or the proxy, and the mock-provider suite in section 8 is what proves the replacement behaves identically.

## 7. First-run setup

**Naming corrected at implementation.** This section originally prefixed every
provider variable with `SSO_`. The implementation reads them unprefixed --
`GOOGLE_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `APPLE_PRIVATE_KEY_FILE` -- and the
document now matches, because the disagreement had already cost something: the
users screen followed this document while the runtime followed itself, so a
correctly configured deployment offered no sign-in method and reported "no
provider is configured" while sign-in worked. `SSO_COOKIE_SECRET` keeps its
prefix: it belongs to this application, not to a provider.

### 7.1 Who is doing this

Section 8.6 of the main design makes the setup wizard completable by the owner, and that stays true for everything it collects today. Creating an OAuth client in Google Cloud Console, an app registration in Entra, or a Services ID and key in the Apple developer portal is not owner work, and no wizard makes it so — each console changes its layout more often than this product will ship releases. **Provider registration is installer work, done from `INSTALL.md`, and the wizard validates the result.** That is the same rule the existing step 5 applies to the Graph certificate, for the same reason: credentials never pass through a form, because a form writes to the database and the database is mirrored and dumped.

### 7.2 Environment

| Variable | Purpose | Notes |
|---|---|---|
| `AUTH_MODE` | `access`, `sso`, or `local` | Now required (section 1.2) |
| `APP_PUBLIC_URL` | The origin users reach the app at | Builds every redirect URI and is the CSRF comparison origin. Never derived from `Host`. `INTERNAL_BASE_URL` already exists for Chromium and is a different thing |
| `SSO_COOKIE_SECRET` | Encrypts `__Host-auth_state` | At least 32 bytes. Rotating it invalidates in-flight sign-ins only, never sessions |
| `SSO_BOOTSTRAP_OWNER_EMAIL` | Names the first owner | Section 7.3. Removed after first use |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client | |
| `GOOGLE_HD` | Optional Workspace domain | Section 6.2 |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Entra app registration | |
| `MICROSOFT_TENANT_ID` | Tenant GUID or `consumers` | `common` and `organizations` refuse at boot (section 6.1) |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` | Services ID, Team ID, Key ID | |
| `APPLE_PRIVATE_KEY_FILE` | Path to the mounted `.p8` | A Docker secret, like the Graph certificate. Never an inline value |

Every `*_SECRET` accepts a `*_SECRET_FILE` companion pointing at a Docker secret, and the production compose file uses the file form. **A provider is configured when its client id is present, and a configured provider with any of its other variables missing refuses to boot**, naming the variable — the same fail-early rule `verifyAccessJwt` applies to a missing `CF_ACCESS_AUD`. At least one provider must be configured in `sso` mode or the mode is meaningless and boot refuses.

### 7.3 The first owner

Step 6 of the existing wizard reads "the signed-in identity becomes `owner`". That was written for `access` mode, where Access has already decided who can reach the wizard at all. In `sso` mode a fresh install is a public URL with a Google button on it, and the first stranger to press it would own the company's quoting system. **That line is overruled for `sso` mode.**

In `sso` mode the wizard accepts a first sign-in only from `SSO_BOOTSTRAP_OWNER_EMAIL`, set by the installer beside the provider credentials. The rule applies in two situations and no others: no `users` row exists, in which case the row is created as `owner` with `login_method` set to whichever provider was used; or the named user exists, is an active owner, and has `login_method` NULL, in which case the method is set. The second case is what makes a deployment switching from `access` to `sso` recoverable — every existing user has NULL `login_method` after the switch, including the owner, and without this rule nobody could sign in to set anyone's method. Once the owner has a method the variable is inert; the wizard says so and the runbook says to remove it.

### 7.4 What the environment-check step shows

The existing step 5 gains a block per configured provider, each row either green or red with a sentence a non-technical person can act on or relay:

| Check | Red means |
|---|---|
| Discovery document reachable | The box cannot reach the provider — DNS, firewall, or an outage |
| Client id present, secret or key present | A variable is missing; named |
| Apple key parses as an EC P-256 private key and the Key ID is ten characters | The wrong file was mounted, or a `.pem` was supplied instead of the `.p8` |
| Redirect URI, printed for copy | Not a check. It is shown because the installer has to paste it into three consoles exactly, and a trailing slash is the commonest reason a provider says `redirect_uri_mismatch` |
| `APP_PUBLIC_URL` is `https://` | Every provider refuses a plain `http://` redirect URI outside localhost |

Nothing on this step is a form field. The wizard reads; it does not write.

## 8. Testing

Nothing in CI reaches Google, Microsoft, or Apple. The three cannot be scripted in a pipeline, they rate-limit, and a test that depends on them fails when they change their sign-in pages, which is often.

### 8.1 A mock provider, in process

`tests/support/mock-oidc.ts` starts a tiny HTTP server on an ephemeral port that serves a discovery document, a JWKS with a test key pair generated per run, an authorisation endpoint that redirects straight back with a code, and a token endpoint that mints an `id_token` with whatever claims the test asks for. It has an Apple personality — `form_post` back to the callback, `email_verified` as a string, a relay address, a `user` field with a name — and a Microsoft personality that adds `tid` and `oid`. It is perhaps two hundred lines and it is the entire external world as far as the suite is concerned.

The application reaches it through `SSO_ISSUER_OVERRIDE_<PROVIDER>`, honoured **only when `NODE_ENV` is not `production`**, with a test that asserts a production build ignores the variable. An override that worked in production would let anyone with the environment point Microsoft sign-in at a server of their choosing, and the environment is exactly what section 2 of the distribution spec says the owner already controls — so the variable must not exist there.

### 8.2 What is covered

**Unit, `tests/unit/`.** Mode interlocks: `sso` with `CF_ACCESS_TEAM_DOMAIN` set refuses; `access` with `GOOGLE_CLIENT_ID` set refuses; unset `AUTH_MODE` refuses; a configured provider missing its secret refuses. Claim validation per provider: wrong `iss`, wrong `aud`, expired, `nonce` mismatch, Google `email_verified` false, Google `hd` absent when required, Microsoft `tid` mismatch, Microsoft `oid` absent, Apple `email_verified` as the string `"false"`. The Apple client-secret JWT: ES256, `iss`, `sub`, `aud`, `kid`, `exp` under six months. The state cookie: a tampered ciphertext is refused; an expired one is refused; one from a different `SSO_COOKIE_SECRET` is refused. The identity-matching table in section 4 as a table-driven test, one row per line of it.

**Database, `tests/db/`.** `NULLS NOT DISTINCT` actually rejects a second Google identity with the same `sub`. The partial unique index rejects a second active identity for one user and allows a void one. `sessions` stores a hash and a round-trip of the plaintext finds the row. The application role holds no DELETE on the two new tables, inside a transaction, as Task 9 of Plan 1 already does for the rest.

**Proxy, `tests/unit/proxy.test.ts`.** `/auth/*` is public in `sso` mode and 404 in `access` mode. `/print/*` accepts the render secret and nothing else in all three modes. A POST to a route handler without `Sec-Fetch-Site: same-origin` is refused; the Apple callback is not. A request carrying `x-identity-email` inbound has it stripped.

**Sessions.** Idle expiry, absolute expiry, `last_seen_at` advancing at most hourly, revocation on deactivate, on role change, on method change, and cache invalidation on each — the assertion being that the very next request after the owner's action is refused, not the one after the TTL.

**End to end, Playwright, against the mock.** Owner adds a user with method Google; user signs in through the mock and lands on Today; owner changes the method to Microsoft; the user's next request is refused and the sign-in page says "signs in with Microsoft"; the user signs in through the Microsoft personality and is linked again with the old identity void. A second scenario runs the Apple personality end to end, including the cross-site POST landing with the `SameSite=None` state cookie, because that is the one browser behaviour a unit test cannot exercise.

**White-label.** The existing grep gains the bootstrap email and any tenant GUID used in fixtures, so neither ends up in a built image.

### 8.3 What the mock cannot prove

The mock proves the app's side of the protocol. It cannot prove that Google still sets `hd` the way the adapter expects, that Microsoft still puts `oid` where it did, or that Apple still sends `email_verified` as a string. **Each provider is exercised by hand at implementation, after every `openid-client` bump, and quarterly**, against a real account in a throwaway tenant, from a checklist in the runbook: first link, subsequent sign-in, changed email, wrong provider, Hide My Email. This is manual by design; automating it would mean a real credential in CI, which is the thing this section exists to avoid.

## 9. Phased plan

### 9.1 SSO-1 — ships first

`AUTH_MODE` required with the three-way interlock. `src/lib/auth/oidc/` with the shared flow and the Google and Microsoft adapters. The `login_method` column, `user_identities`, and `sessions`, with their migration. The session cookie, the state cookie, the cache, CSRF, and rate limits. `Settings → Users` with the method picker, Reset link, and Sign out everywhere. The bootstrap owner rule and the environment-check rows. `scripts/auth-recover.ts`. The mock provider and every test in section 8 except the Apple scenario. `INSTALL.md` sections for Google and Microsoft, with screenshots that will be out of date within the year and exact strings that will not.

Google and Microsoft together, rather than one of them, because their adapters differ in fewer than fifty lines and the second one is what proves the shared flow is actually shared.

### 9.2 SSO-2 — follows

Apple: the adapter, the runtime client-secret JWT, `form_post`, the relay-address handling and its sign-in page notice, the Apple mock personality, the Apple E2E scenario, and the `INSTALL.md` section. Also the "provider now reports a different email" notice on the users screen, which is useful for all three providers but is not needed on day one.

Apple is second because it needs a paid developer membership the installing company may not hold, because it is the only provider that cannot be tested on a LAN address at all, and because its three quirks each deserve their own attention rather than being squeezed in beside two providers that behave. The first deployment is on Microsoft 365 behind Access and needs none of this; the owner can pull Apple forward if the second company turns out to be an iPhone shop.

### 9.3 Deliberately refused

| Refused | Reason |
|---|---|
| Passwords, in any form | The whole design exists so the application never holds a credential it has to protect. A password store is that credential |
| Magic-link or email-code sign-in | The application sends no email (distribution spec, section 4) and a mail job on an unplugged mini PC sends nothing |
| "Any provider" as a per-user method | It means whoever controls any of three accounts with that address gets in. The owner asked for one method per person, and one is the tighter model |
| Microsoft `common` or `organizations` authorities | Section 6.1. They make the `email` claim untrustworthy and require a tenant allowlist nobody will maintain |
| Running Access and in-app SSO together | Section 1.1 |
| Per-user method enforcement in `access` mode | Section 1.5. It is one rule in the Access policy |
| Just-in-time user creation | Section 4.2. The owner adds people; the provider only proves who they are |
| Automatic rewrite of `users.email` when the provider's email changes | Section 4.3. It is the UNIQUE key, and a colliding rename is worse than a notice |
| Refresh tokens, `offline_access`, any post-sign-in provider call | Section 2.1. Nothing to do with them, so nothing to protect |
| Provider-side sign-out | Section 5.4 |
| A second factor of the app's own | The providers do MFA, and Google, Microsoft, and Apple do it better than a TOTP table in a mirrored database would |
| SAML, or a generic "bring your own OIDC provider" option | Every generic option is a support surface for a provider the maintainer has never seen. The three named providers cover every small contractor this product will meet; a fourth is a future adapter, not a configuration screen |
| Storing the Apple-supplied name | Section 4.4. `display_name` is the owner's field |

## 10. Authorization: what a role may do

This section exists because of the owner's instruction recorded in section 3.1, and it is the part of this document the authentication implementation has to satisfy. Everything before it decides how the application learns who is asking. This decides what that answer entitles them to, and it is written so that no line of it depends on which provider -- or which of the three modes -- produced the identity.

### 10.1 The rule the implementation must not break

Authentication establishes an identity. **Authorization is a separate lookup against `users`, performed by the application, on every request that changes or reveals anything.** A valid session is never sufficient on its own.

Three consequences, each of them a way this gets built wrongly:

- **No permission is ever read from a token.** Not from a Google `hd`, not from a Microsoft group or role claim, not from an Access JWT's custom claims. A provider can be reconfigured by somebody who has never seen this application, and a claim-driven permission would change with it, silently. The provider says who; `users.role` says what.
- **Deny by default.** A route with no permission check must fail closed rather than fall through to allowed. The check belongs at the top of the server action or route handler, before any argument is read, so that adding a route without one is a visible omission instead of an open door.
- **A role change takes effect at once.** Changing `users.role` revokes that user's sessions and drops their entries from the in-process cache (section 5.1), exactly as changing the sign-in method does. A demoted user carrying a cached role for another seven days is the whole reason these sessions are stateful.

`AUTH_MODE=local` is not an exception to any of it. Local mode supplies one identity from `LOCAL_USER_EMAIL`, and that identity is then subject to the same lookup: if the `users` row says `bookkeeper`, the LAN session is a bookkeeper. A mode decides how identity arrives, never what it may do.

### 10.2 The matrix

Three roles, from the existing `role` enum. No new roles, and no per-user permission flags: in a company with three or four people, a matrix everybody can hold in their head beats a permission system nobody audits.

| Capability | `owner` | `admin` | `bookkeeper` |
|---|---|---|---|
| Create and edit customers, projects, quotes | Yes | Yes | No |
| Send, accept, decline, revise a quote | Yes | Yes | No |
| Void a quote, project, or customer | Yes | Yes | No |
| See cost and margin, read the worksheet | Yes | Yes | Yes, read-only |
| Generate and download documents | Yes | Yes | Yes |
| Manage users: add, deactivate, set role, set sign-in method | Yes | Yes, except `owner` rows and except granting `owner` | No |
| Reset a user's provider link, sign a user out everywhere | Yes | Yes, except `owner` rows | No |
| Edit rate items, cost codes, scope templates | Yes | Yes | No |
| Edit tax rates and their effective dates | Yes | No | No |
| Edit organization identity, branding, and document text | Yes | No | No |
| Turn the SharePoint mirror on or off, read its state | Yes | No | No |
| Read and configure backup, restore, and update settings | Yes | No | No |
| Read the audit log | Yes | Yes | Yes |
| Accountant export (Phase 3) | Yes | Yes | Yes |

`bookkeeper` sees cost and margin deliberately. The role exists for whoever prepares the year end, and a set of books carrying the revenue but not the cost is not a set of books. What the role cannot do is change a priced record.

The five capabilities reserved to `owner` are the ones whose blast radius is the whole deployment rather than one job: the tax rate every future quote inherits, the company's own identity on every document it sends, whether data leaves the box for SharePoint, and whether the backups exist at all. An `admin` running the office day to day needs none of them.

### 10.3 Where the check lives

One module, `src/lib/auth/permissions.ts`, exporting the capability names in the matrix above and a single `require(capability)` that every server action and route handler calls. Not scattered `role === 'owner'` comparisons: the matrix is a table, and a table belongs in one place where it can be read against this document and tested exhaustively.

The check reads the session's user row, never a role handed in from the client. A role in a form field or in a client component's props is a role the browser can edit.

`INTERNAL_RENDER_SECRET` on the print route (main design, section 6.1) stays outside this model. It authenticates a process rather than a person, and the document it renders was already authorized when the page that asked for it was.

### 10.4 What must be tested

The matrix is a table, so it takes a table-driven test: for every capability and every role, assert allowed or refused. That test is what turns adding a capability without wiring it into a failure instead of a silent omission.

Beyond it, five cases the guardrails in section 3.1 exist for, each asserted directly: an `admin` refused when editing an `owner` row; an `admin` refused when granting `owner`; any role refused when changing its own role; the last active `owner` refused deactivation, at both the application and the database; and a demoted user's next request refused while the old session cookie is still in hand.

## 11. Decisions made on the owner's behalf

1. **SSO lives in the app only when Cloudflare Access is absent (`AUTH_MODE=sso`); with Access present, Access does it.** Access already federates all three providers with a WAF in front, and two doors are worse than one.
2. **The three modes are mutually exclusive and `AUTH_MODE` becomes mandatory.** With three options, an unset default is a guess, and the existing interlock exists to refuse guesses.
3. **In `access` mode the per-user picker is hidden and per-user enforcement is refused.** It is one rule in the Access policy; duplicating it in the app is two places to disagree.
4. **User management, including roles and the sign-in method, belongs to the `admin` role -- the owner's own instruction, overruling an earlier draft of this document.** It carries four guardrails (section 3.1): owner rows are read-only to an `admin`, an `admin` cannot grant `owner`, nobody changes their own role, and the last active owner cannot be demoted or deactivated.
5. **Permission is decided by the application against `users.role`, never by a provider claim, and identically in all three modes (section 10).** The login method is interchangeable; the permission model is the requirement. A claim-driven permission changes whenever somebody reconfigures a provider console, silently.
6. **Three roles, no per-user permission flags.** A matrix three people can hold in their heads beats a permission system nobody audits.
7. **`bookkeeper` sees cost and margin and can change nothing priced.** A set of books with revenue and no cost is not a set of books.
8. **One method per user, no "any".** It is what was asked for, and it is the tighter model.
9. **Authentication keys on the provider subject after the first link; email is only the first-time match.** Email changes, goes unverified, and for Apple is sometimes a relay; the subject does none of those.
10. **Users are never created by sign-in.** A quoting system with margin on every line is not something a new hire should reach before the owner has chosen their role.
11. **Sessions are stateful rows in PostgreSQL with an in-process cache; no Redis, no stateless JWT.** Revocation is the whole administrative story, one box means the cache is coherent, and Postgres is already there.
12. **Idle 7 days, absolute 30.** The owner can revoke at any moment, so a daily re-login buys nothing and costs a person in a truck.
13. **No pruning of `sessions`.** Two thousand rows a year does not justify a carve-out from the no-DELETE rule.
14. **The Apple client secret is minted at runtime from the mounted key with a five-minute life.** A pasted six-month JWT is a scheduled outage.
15. **The state cookie is `SameSite=None`, encrypted, ten minutes.** Apple's mandatory `form_post` is a cross-site POST, and a `Lax` cookie is invisible to it.
16. **Microsoft is single-tenant or `consumers` only.** Those are the two configurations in which the `email` claim can be trusted for a first link.
17. **Google's `hd` is enforced server-side from the token, optionally, and never from the request parameter.** The parameter is a UI hint.
18. **The provider-supplied name is ignored.** `display_name` is the owner's field, which makes Apple's once-only delivery irrelevant.
19. **Hide My Email is allowed if the owner enters the relay address.** The app sends no mail, so a relay costs it nothing, and a person may reasonably not want their real address in their employer's system.
20. **In `sso` mode the first owner is named by `SSO_BOOTSTRAP_OWNER_EMAIL`, overruling "the signed-in identity becomes owner".** On a public URL, first-to-arrive is a stranger.
21. **Provider registration is installer work from `INSTALL.md`; the wizard validates and never collects.** Consoles change monthly, and credentials never pass through a form that writes to a mirrored database.
22. **Lockout recovery is a script on the box, not `AUTH_MODE=local`.** Switching to local mode under a live tunnel makes the internet the owner until someone stops the tunnel.
23. **`openid-client` 6.x, pinned exact, behind a one-directory seam.** Same author as the `jose` already in use, certified, small; if abandoned, vendor `oauth4webapi` or hand-roll on `jose` inside that directory and nothing else moves.
24. **No real provider in CI; a mock in process, plus a quarterly manual checklist.** The providers cannot be scripted in a pipeline, and a credential in CI is what the whole design avoids.
25. **Google and Microsoft ship first; Apple second.** Apple needs a paid membership the company may not hold, cannot be tested on a LAN, and has three quirks that deserve their own attention.
26. **Passwords, magic links, JIT provisioning, `common` tenants, refresh tokens, provider-side logout, an in-app second factor, and generic SAML/OIDC are refused.** Each is either a credential the app would then have to protect, or a support surface for something the product will not meet.
