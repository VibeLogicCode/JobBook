# Reaching Scopeline: HTTPS and sign-in

Three postures. The setup wizard's **Access** step writes the configuration; the
compose profiles here provide the containers. Choose one — they are mutually
exclusive by design, because a half-configured second door is worse than one
door.

| Posture | `AUTH_MODE` | Who can reach it | Certificate from |
|---|---|---|---|
| LAN only | `local` | Anyone on the network, as the one named user | Caddy's internal CA, or none |
| Tunnel + Access | `access` | Only identities the Access policy admits | Cloudflare's edge |
| In-app SSO | `sso` | Only users an administrator added | Let's Encrypt, via Caddy |

## What the wizard can and cannot do

It **writes** `/data/config/auth.env` on the `config` volume, mode `0600`, and
the boot reads it. That is why credentials do not go in the database: a database
row is mirrored to SharePoint and lands in every backup, and a mirror is
readable by everyone the accountant shares a site with.

It **cannot restart the containers**, because a process's environment is fixed
when it starts. After finishing the step, run `docker compose up -d` — the app
picks the file up on boot and the Access step's report then distinguishes
"configured on disk" from "in effect for this process".

It **cannot set `AUTH_MODE=local`**, and the boot refuses that key from the file
even if it appears there. Local mode treats every visitor as the owner, so a
file the application can write must never be able to select it: one file write
inside the app would otherwise be a promotion from ordinary user to owner. For
the LAN posture, put `AUTH_MODE=local` in the compose environment yourself.

## LAN only

```sh
# .env
AUTH_MODE=local
LOCAL_USER_EMAIL=owner@example.invalid   # must match a users row
CADDY_SITE=https://192.168.1.50          # this machine's LAN address
docker compose -f docker-compose.app.yml --profile https up -d
```

Caddy issues a certificate from its own authority. Every browser will warn once
until that authority is trusted:

```sh
docker compose -f docker-compose.app.yml cp proxy:/data/caddy/pki/authorities/local/root.crt ./scopeline-root.crt
```

Install `scopeline-root.crt` as a trusted root on each device — Windows:
*Manage user certificates → Trusted Root Certification Authorities*; macOS:
Keychain Access, then set it to *Always Trust*; Android and iOS: install the
profile and enable full trust.

Skipping HTTPS entirely is possible — `APP_BIND=0.0.0.0` and no proxy — and it
means every quote, cost figure and margin crosses the office network in
plaintext, readable by anything on the same wifi. It is a defensible choice for
a wired office of two and a bad one for a shared building.

**Nothing about local mode authenticates anybody.** It is correct on a network
you control and wrong on anything reachable from the internet. Do not combine it
with the tunnel; the code refuses to run two modes at once for this reason.

## Tunnel + Access

The strongest posture, and the cheapest: no inbound port, no certificate to
renew, no router to configure, and an identity provider in front.

1. In Cloudflare Zero Trust, create a tunnel, copy its token.
2. Route a hostname to `http://app:3000`.
3. Create an Access application on that hostname, with the policies and the
   identity providers you want. Google, Microsoft and Apple all federate here,
   which is why in-app SSO exists only for deployments *without* Cloudflare.
4. Copy the application audience tag.

```sh
# .env
AUTH_MODE=access
TUNNEL_TOKEN=...
CF_ACCESS_TEAM_DOMAIN=https://yourteam.cloudflareaccess.com
CF_ACCESS_AUD=...
APP_BIND=127.0.0.1            # publish nothing to the network
docker compose -f docker-compose.app.yml --profile tunnel up -d
```

The app verifies every request's Access JWT against Cloudflare's JWKS, including
issuer, audience and expiry, and refuses a service token because it carries no
email. The tunnel is defence in depth, **not** what makes the header
trustworthy — a forged header fails signature verification either way, and
believing otherwise is how the verification gets skipped.

## In-app SSO

For a deployment with no Cloudflare account. Needs a real domain pointing at the
machine and ports 80 and 443 reachable.

```sh
# .env
AUTH_MODE=sso
APP_PUBLIC_URL=https://quotes.example.com
CADDY_SITE=https://quotes.example.com
CADDY_EMAIL=you@example.com
CADDY_HSTS=max-age=31536000
SSO_COOKIE_SECRET=<48+ random characters>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
docker compose -f docker-compose.app.yml --profile https up -d
```

Redirect URI for each provider: `https://quotes.example.com/auth/callback/google`
and so on. Every redirect URI is built from `APP_PUBLIC_URL`, never from the
request's `Host` header, because a URL derived from `Host` is the classic route
to an open redirect through host-header injection.

Microsoft must be a single directory GUID or `consumers`. `common` and
`organizations` are refused at boot: on those endpoints any Entra directory in
the world can mint a token this app would accept, and the `email` claim is then
attacker-controlled — create a tenant, set a user's mail to the owner's address,
and first-link matching hands over the account.

## Switching posture later

Change `.env`, then `docker compose up -d`. The modes are mutually exclusive and
the app refuses to start with two configured, so a half-finished switch fails
loudly rather than leaving both doors ajar.

Going from `access` to `sso` needs `SSO_BOOTSTRAP_OWNER_EMAIL`, because on a
public URL the first identity to arrive is a stranger rather than somebody
Access has already vetted.
