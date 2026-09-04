import { randomBytes } from 'node:crypto';
import {
  type AuthConfigEntries,
  type ManagedKey,
  REFUSED_AUTH_MODE,
} from '@/lib/deploy/auth-config';

/**
 * The three deployment postures, and what each one has to be given.
 *
 * ---------------------------------------------------------------------------
 * A POSTURE IS "WHO CAN REACH THIS BOX", NOT "WHICH LOGIN SCREEN APPEARS".
 *
 * The product is a set of containers on a mini PC in an office, sold to more
 * than one company. Where that box sits on the network is the decision every
 * other authentication decision follows from, and it is the one thing the
 * software cannot detect: a machine on an office LAN and a machine published
 * to the internet through a tunnel look identical from inside the container.
 * So it is asked, once, in words about reachability rather than about
 * protocols.
 *
 * The three map onto the three values of `AUTH_MODE` (SSO design section 1.1),
 * which are mutually exclusive and enforced at boot by `assertModeIsCoherent`.
 * They are named for the deployment rather than the mechanism because the
 * person answering knows where his mini PC is and does not necessarily know
 * what OpenID Connect is.
 * ---------------------------------------------------------------------------
 */
export type Posture = 'lan' | 'tunnel' | 'sso';

export const POSTURES: readonly Posture[] = ['lan', 'tunnel', 'sso'];

export function isPosture(value: string): value is Posture {
  return (POSTURES as readonly string[]).includes(value);
}

/**
 * Which keys each posture writes, which is also the set the environment report
 * expects to find and the set the step shows back.
 *
 * `lan` writes ONE key, and not the one that would make it work. That is the
 * whole shape of the interlock: see `entriesForPosture`.
 */
export const POSTURE_KEYS: Record<Posture, readonly ManagedKey[]> = {
  lan: ['LOCAL_USER_EMAIL'],
  tunnel: ['AUTH_MODE', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'TUNNEL_TOKEN'],
  sso: [
    'AUTH_MODE',
    'APP_PUBLIC_URL',
    'SSO_COOKIE_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'MICROSOFT_TENANT_ID',
  ],
};

/**
 * The providers this posture can offer.
 *
 * Apple is deliberately absent. `providerConfig('apple')` throws
 * `ProviderNotConfigured` today -- its client secret is not a string but an
 * ES256 JWT minted per request from a mounted key, and its callback is a
 * cross-site form POST -- so collecting its credentials would produce a
 * deployment offering a sign-in button that cannot work. The existing rule for
 * the users screen is the same one: a method that cannot work is a support
 * call, so it is simply not offered.
 */
export type ProviderName = 'google' | 'microsoft';

export const OFFERED_PROVIDERS: readonly ProviderName[] = ['google', 'microsoft'];

/**
 * The two Microsoft endpoints the runtime refuses, and the reason repeating
 * itself in the interface is worth the words.
 *
 * On `common` or `organizations`, ANY Entra directory in the world can issue a
 * token this application would accept, and the `email` claim is then
 * attacker-controlled: somebody creates a tenant, sets a user's mail to the
 * owner's address, and the first-link match hands them the owner's account.
 * `providers.ts` refuses both at boot. It is repeated on the form because by
 * the time the boot refusal is read the installer has already pasted the value
 * he found in a tutorial, and "it did not work" is where support time goes.
 */
export const MULTI_TENANT_ENDPOINTS: readonly string[] = ['common', 'organizations'];

export function isMultiTenantEndpoint(value: string): boolean {
  return MULTI_TENANT_ENDPOINTS.includes(value.trim().toLowerCase());
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export type PostureInput =
  | { posture: 'lan'; localUserEmail: string }
  | { posture: 'tunnel'; teamDomain: string; accessAud: string; tunnelToken: string }
  | {
      posture: 'sso';
      publicUrl: string;
      google: ProviderCredentials | null;
      microsoft: (ProviderCredentials & { tenantId: string }) | null;
      /** Carried over from the file when there is one, so sign-ins in flight survive. */
      cookieSecret?: string | null;
    };

/**
 * A secret this application mints for itself.
 *
 * `SSO_COOKIE_SECRET` encrypts the transient sign-in state cookie. No console
 * issues it and no installer should have to invent it, and without it
 * `oidc/flow.ts` throws on the first sign-in attempt -- so an `sso` posture
 * written without one is a posture that cannot sign anybody in. It is the one
 * value on this step the box can legitimately produce itself, because it
 * authenticates nothing to anybody else.
 *
 * 48 bytes, base64url: comfortably past the 32-character minimum the flow
 * enforces, and URL-safe so nothing downstream has to quote it.
 */
export function newCookieSecret(): string {
  return randomBytes(48).toString('base64url');
}

/**
 * The keys a posture writes to the config file.
 *
 * ---------------------------------------------------------------------------
 * WHY `lan` DOES NOT WRITE `AUTH_MODE`.
 *
 * Local mode treats every visitor as one named user: no password, no provider,
 * no session. It is correct on an office network and catastrophic on anything
 * reachable from the internet, and it is the LOOSEST of the three by a wide
 * margin -- it is the only one under which reaching the box at all is the same
 * thing as being the owner.
 *
 * This file is written by the application. If the application could put
 * `AUTH_MODE=local` in it, then anybody who achieved a single file write
 * inside the application -- one path-traversal bug, one upload that lands
 * where it should not -- would promote themselves from an ordinary user to
 * owner by downgrading the mode, without touching the database, without a
 * password, and without anything in the audit log.
 *
 * So the posture writes the local user's address, which grants nothing on its
 * own, and the operator sets `AUTH_MODE=local` in the container environment
 * himself. That is a place the application cannot reach and the operator can.
 * The emitter refuses the value, the parser drops it, and the entrypoint
 * refuses it a third time at boot.
 * ---------------------------------------------------------------------------
 */
export function entriesForPosture(input: PostureInput): AuthConfigEntries {
  if (input.posture === 'lan') {
    return { LOCAL_USER_EMAIL: input.localUserEmail };
  }

  if (input.posture === 'tunnel') {
    return {
      AUTH_MODE: 'access',
      CF_ACCESS_TEAM_DOMAIN: input.teamDomain,
      CF_ACCESS_AUD: input.accessAud,
      TUNNEL_TOKEN: input.tunnelToken,
    };
  }

  const entries: AuthConfigEntries = {
    AUTH_MODE: 'sso',
    APP_PUBLIC_URL: input.publicUrl,
    // Preserved when the file already had one. Rotating it invalidates
    // in-flight sign-ins only and never sessions, so regenerating would be
    // survivable -- but an installer correcting a typo in a client id has no
    // reason to expect somebody mid-sign-in to be bounced.
    SSO_COOKIE_SECRET: input.cookieSecret?.trim() || newCookieSecret(),
  };
  if (input.google) {
    entries.GOOGLE_CLIENT_ID = input.google.clientId;
    entries.GOOGLE_CLIENT_SECRET = input.google.clientSecret;
  }
  if (input.microsoft) {
    entries.MICROSOFT_CLIENT_ID = input.microsoft.clientId;
    entries.MICROSOFT_CLIENT_SECRET = input.microsoft.clientSecret;
    entries.MICROSOFT_TENANT_ID = input.microsoft.tenantId;
  }
  return entries;
}

/**
 * Which posture a parsed file describes, or null when it describes none.
 *
 * Derived from the contents rather than remembered in a `settings` row. One
 * source of truth: a marker row saying `sso` beside a file carrying Access
 * keys is a screen that lies about a deployment, and the file is the thing the
 * boot actually reads.
 *
 * `AUTH_MODE=local` cannot appear here -- the parser has already dropped it --
 * so a file carrying only a local user's address reads as the `lan` posture,
 * which is exactly what it is: the wizard's half of that arrangement, waiting
 * on the operator's half.
 */
export function postureOfEntries(entries: ReadonlyMap<ManagedKey, string>): Posture | null {
  const mode = entries.get('AUTH_MODE');
  if (mode === 'access') return 'tunnel';
  if (mode === 'sso') return 'sso';
  if (mode === REFUSED_AUTH_MODE) return null; // Unreachable: the parser drops it.
  if (entries.has('LOCAL_USER_EMAIL')) return 'lan';
  return null;
}

/**
 * What the operator has to do that no container can do for itself.
 *
 * ---------------------------------------------------------------------------
 * THE APPLICATION CANNOT RESTART ITSELF, AND SHOULD NOT BE ABLE TO.
 *
 * A process's environment is fixed when it starts. The file this step writes
 * is read by `docker/entrypoint.sh` at boot, so every value in it takes effect
 * at the next start of the container and not a moment before -- which means
 * the step is only half of the change, every time, in every posture.
 *
 * It could be automated: mount the Docker socket and let the app restart its
 * own container. That is refused. A container holding the Docker socket is
 * root on the host, so the trade would be "the wizard saves the operator one
 * command" against "a bug in this application is a compromise of the whole
 * machine". The honest alternative is to say plainly what to run.
 * ---------------------------------------------------------------------------
 */
export interface RestartPlan {
  /** Compose service names, in the order they should come back. */
  services: readonly string[];
  command: string;
  /** Steps the operator must take by hand FIRST, or an empty list. */
  operatorMustFirst: readonly string[];
}

/** The compose file the deployment runs from. A product file, not a tenant's. */
const COMPOSE_FILE = 'docker-compose.app.yml';

export function restartPlan(posture: Posture): RestartPlan {
  const services = posture === 'tunnel' ? ['app', 'tunnel'] : ['app'];
  return {
    services,
    // `up -d`, not `restart`. A restart re-runs the entrypoint and so does pick
    // up this file, but it does NOT re-read the compose file -- and in the LAN
    // posture the operator has just edited the compose environment, which only
    // a recreate applies. One command that covers both beats two that differ
    // by a detail nobody remembers at eleven at night.
    command: `docker compose -f ${COMPOSE_FILE} up -d ${services.join(' ')}`,
    operatorMustFirst:
      posture === 'lan'
        ? [
            `Set AUTH_MODE=${REFUSED_AUTH_MODE} in the container environment — the AUTH_MODE line ` +
              `in ${COMPOSE_FILE}, or AUTH_MODE in the .env file beside it. This step cannot ` +
              'write it, and the reason is not a limitation: local mode makes every visitor ' +
              'the owner, so a mode chosen by a file the application itself can write would ' +
              'turn one file write inside the app into a promotion to owner.',
          ]
        : posture === 'tunnel'
          ? [
              'Put the same tunnel token in the .env file beside the compose file, as ' +
                'TUNNEL_TOKEN. The cloudflared container takes its environment from compose ' +
                'and does not mount the config volume, so it cannot read the file this step ' +
                'writes. Do it before leaving this page: the token is stored but never shown ' +
                'back, because a secret returned to a browser is a secret in a cache.',
              'Create the Access application in the Cloudflare dashboard and put a policy on ' +
                'it. A tunnel with no Access policy publishes this deployment to the internet ' +
                'with no sign-in at all.',
            ]
          : [
              'Register the OAuth client in each provider’s console and add the redirect URI ' +
                'shown on this step, character for character. A trailing slash is the ' +
                'commonest cause of redirect_uri_mismatch.',
            ],
  };
}
