/**
 * The desktop session: an access token held in memory, and the refresh that renews it.
 *
 * On the web this module does nothing - the browser has a cookie and the server manages
 * it. On the desktop the client is responsible for its own credential, which brings one
 * hazard worth naming.
 *
 * Refresh tokens rotate, and the server treats a spent one as stolen: presenting it twice
 * revokes the whole chain. That is the right behaviour, and it means two refreshes racing
 * each other would log the person out. Several requests failing at once on an expired
 * token is not an edge case - it is what happens on every screen that loads three
 * queries - so refreshing is single-flight: the first caller performs it and everyone
 * else waits on the same promise.
 */
import { desktop } from './desktop';

export type Grant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  absoluteExpiresAt?: string;
};

let current: Grant | null = null;
let inFlight: Promise<Grant | null> | null = null;

/** Renews this many milliseconds before expiry, so a slow request does not race the clock. */
const REFRESH_MARGIN_MS = 60_000;

export function currentAccessToken(): string | null {
  return current?.accessToken ?? null;
}

/**
 * Records a grant in memory and in the keystore.
 *
 * Awaited rather than fire-and-forget: the write and the subsequent read are close enough
 * together at sign-in that an unawaited write loses the race, and the caller needs to know
 * the credential is durable before it navigates.
 */
export async function setGrant(grant: Grant | null): Promise<void> {
  current = grant;
  if (!desktop) return;
  if (grant) {
    await desktop.session.set({
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
    });
  } else {
    await desktop.session.clear();
  }
}

/** Loads whatever the OS keystore was holding, at startup. */
export async function restoreGrant(): Promise<Grant | null> {
  if (!desktop) return null;
  /**
   * A grant already in memory always wins.
   *
   * This runs on every session load, including the one immediately after signing in. What
   * is on disk at that moment may still be the previous grant, and adopting it would
   * replace a freshly issued token with a revoked one - which presents as signing in
   * successfully and landing back on the sign-in screen.
   */
  if (current) return current;
  const stored = await desktop.session.get();
  if (!stored) return null;
  current = stored;
  return stored;
}

function isExpiring(grant: Grant): boolean {
  return new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS;
}

/**
 * Returns a usable access token, refreshing first if the current one is close to expiry.
 *
 * Callers get the same promise while a refresh is in progress, which is what keeps the
 * rotation single-file.
 */
export async function accessTokenForRequest(baseUrl: string): Promise<string | null> {
  if (!desktop) return null;
  if (!current) return null;
  if (!isExpiring(current)) return current.accessToken;

  const refreshed = await refresh(baseUrl);
  return refreshed?.accessToken ?? null;
}

export function refresh(baseUrl: string): Promise<Grant | null> {
  if (!desktop || !current) return Promise.resolve(null);
  if (inFlight) return inFlight;

  const token = current.refreshToken;
  inFlight = (async () => {
    try {
      const response = await fetch(`${baseUrl}/auth/token/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!response.ok) {
        // The refresh token is spent, revoked or past the five-day ceiling. There is no
        // recovering from any of those in the client; the person signs in again.
        await setGrant(null);
        return null;
      }
      const grant = (await response.json()) as Grant;
      await setGrant(grant);
      return grant;
    } catch {
      // A network failure is not proof the token is bad, so the grant is kept and the
      // caller sees the request fail. Discarding it here would sign people out whenever
      // their connection dropped.
      return current;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function clearGrant(): void {
  void setGrant(null);
}
