/**
 * Provider adapters.
 *
 * Each provider speaks OpenID Connect and each differs in exactly the places
 * that cause outages, so the differences live here and the flow lives in
 * `flow.ts`. Everything a provider needs beyond its endpoints — client id,
 * secret, tenant, hosted domain — comes from the environment. None of it is
 * ever stored in the database, because a table is mirrored to SharePoint and
 * lands in every backup.
 */

export type ProviderName = 'google' | 'microsoft' | 'apple';

export interface ProviderConfig {
  name: ProviderName;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Apple returns the authorisation as a cross-site POST. */
  responseMode: 'query' | 'form_post';
  /** Google Workspace domain, enforced from the token rather than the request. */
  hostedDomain?: string;
  /** Microsoft directory the token must come from. */
  tenantId?: string;
}

export class ProviderNotConfigured extends Error {}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new ProviderNotConfigured(`${key} is not set`);
  return value;
}

/**
 * Provider hostnames are product constants, like the update manifest URL, and
 * are exempt from the white-label rule with this comment. What is tenant
 * specific — client ids, secrets, directory GUIDs, workspace domains — is
 * environment configuration and appears nowhere in source.
 */
const GOOGLE_ISSUER = 'https://accounts.google.com';
const MICROSOFT_HOST = 'https://login.microsoftonline.com';
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * A mock issuer, for tests only.
 *
 * Gated on VITEST so it cannot be reached in a running deployment: an
 * environment variable that redirects authentication to an arbitrary host is
 * the kind of override that ends up set in production by accident. Tests need
 * it because the real providers cannot be scripted, and a credential in CI is
 * exactly what this design avoids.
 */
function mockEndpoints(name: ProviderName): Partial<ProviderConfig> | null {
  const base = process.env.OIDC_MOCK_BASE;
  if (!process.env.VITEST || !base) return null;
  return {
    issuer: `${base}/${name}`,
    authorizationEndpoint: `${base}/${name}/authorize`,
    tokenEndpoint: `${base}/${name}/token`,
    jwksUri: `${base}/${name}/jwks`,
  };
}

function google(): ProviderConfig {
  return {
    name: 'google',
    issuer: GOOGLE_ISSUER,
    authorizationEndpoint: `${GOOGLE_ISSUER}/o/oauth2/v2/auth`,
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    scope: 'openid email',
    responseMode: 'query',
    // Optional. When set, a token from any other domain is refused.
    hostedDomain: process.env.GOOGLE_HOSTED_DOMAIN || undefined,
  };
}

/**
 * Microsoft, single-tenant or consumer only.
 *
 * `common` and `organizations` are deliberately refused. In those
 * configurations any Entra directory in the world can issue a token this app
 * would accept, and the `email` claim is then attacker-controlled — somebody
 * creates a tenant, sets a user's mail to the owner's address, and the
 * first-link match hands them the account. A single directory GUID, or
 * `consumers` for personal accounts, are the two shapes where the claim can
 * carry weight.
 */
function microsoft(): ProviderConfig {
  const tenant = required('MICROSOFT_TENANT_ID');
  if (tenant === 'common' || tenant === 'organizations') {
    throw new ProviderNotConfigured(
      `MICROSOFT_TENANT_ID must be a directory GUID or "consumers", not "${tenant}": ` +
        'a multi-tenant endpoint lets any directory issue a token this app would accept',
    );
  }
  return {
    name: 'microsoft',
    issuer: `${MICROSOFT_HOST}/${tenant}/v2.0`,
    authorizationEndpoint: `${MICROSOFT_HOST}/${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${MICROSOFT_HOST}/${tenant}/oauth2/v2.0/token`,
    jwksUri: `${MICROSOFT_HOST}/${tenant}/discovery/v2.0/keys`,
    clientId: required('MICROSOFT_CLIENT_ID'),
    clientSecret: required('MICROSOFT_CLIENT_SECRET'),
    scope: 'openid email profile',
    responseMode: 'query',
    tenantId: tenant,
  };
}

/**
 * Apple. Second in the phased plan, and present here only so the shape is
 * fixed: its client secret is not a string but an ES256 JWT that has to be
 * minted at request time from the mounted private key, and its callback is a
 * cross-site form POST.
 */
function apple(): ProviderConfig {
  throw new ProviderNotConfigured(
    'Apple sign-in is not implemented yet: it needs a paid developer membership, ' +
      'a runtime-minted client secret, and a form_post callback (see the SSO spec, section 6.3)',
  );
}

const BUILDERS: Record<ProviderName, () => ProviderConfig> = {
  google,
  microsoft,
  apple,
};

export function providerConfig(name: ProviderName): ProviderConfig {
  const config = BUILDERS[name]();
  const mock = mockEndpoints(name);
  return mock ? { ...config, ...mock } : config;
}

/** Which providers this deployment can actually offer. */
export function configuredProviders(): ProviderName[] {
  const available: ProviderName[] = [];
  for (const name of Object.keys(BUILDERS) as ProviderName[]) {
    try {
      providerConfig(name);
      available.push(name);
    } catch {
      // Not configured. Offering a method that cannot work is a support call,
      // so it is simply absent from the picker.
    }
  }
  return available;
}

export function isProviderName(value: string): value is ProviderName {
  return value === 'google' || value === 'microsoft' || value === 'apple';
}

/**
 * The public origin, used to build every redirect URI.
 *
 * Never derived from the request's Host header. A redirect URI built from Host
 * is the classic route to an open redirect through host-header injection, and
 * the tunnel in front does not protect against it.
 */
export function appOrigin(): string {
  return required('APP_PUBLIC_URL').replace(/\/+$/, '');
}

export function redirectUri(name: ProviderName): string {
  return `${appOrigin()}/auth/callback/${name}`;
}
