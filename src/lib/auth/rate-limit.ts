/**
 * A token bucket for the sign-in routes.
 *
 * Not a security boundary -- the provider does the real work of resisting
 * credential attacks, and this app never sees a password. It bounds a stuck
 * form and a scanner, which is worth doing because each attempt costs an
 * outbound request to a provider.
 *
 * In memory, which is correct for one process on one box and is stated so it
 * is not mistaken for something it survives: a restart resets every bucket.
 */

const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 20;

const buckets = new Map<string, { count: number; resetAt: number }>();

function clientAddress(request: Request): string {
  // Behind the tunnel the socket address is Cloudflare's, so the real client
  // comes from this header. Without a tunnel the header is absent and the
  // fallback keys everything together, which is the conservative direction.
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local';
}

/** Returns a 429 response when the caller is over the limit, or null. */
export function rateLimit(request: Request, scope: string): Response | null {
  const key = `${scope}:${clientAddress(request)}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  bucket.count += 1;
  if (bucket.count > LIMIT) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return new Response('Too many sign-in attempts. Try again shortly.', {
      status: 429,
      headers: { 'retry-after': String(retryAfter) },
    });
  }

  return null;
}

/** Testing seam. */
export function resetRateLimits(): void {
  buckets.clear();
}
