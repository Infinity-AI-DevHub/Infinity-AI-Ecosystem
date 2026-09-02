import { app } from 'electron';
import type { AppConfig } from '../shared/contract';

/**
 * Where this build points.
 *
 * The API origin is fixed at build time rather than being configurable at runtime. A
 * desktop client that can be pointed at an arbitrary server is a phishing tool: anyone
 * who can write the config file can redirect a colleague's credentials to a host they
 * control. The only override is an explicit development environment variable, which is
 * refused in a packaged build.
 */
const PRODUCTION_API = 'https://app-api.iinfinityai.com';
const PRODUCTION_UPDATES = 'https://updates.iinfinityai.com';

/** The dev server, honoured only when running unpackaged. */
export const devServer = app.isPackaged ? null : process.env.INFINITY_DEV_SERVER ?? null;

export const apiUrl = (() => {
  if (!app.isPackaged && process.env.INFINITY_API_URL) return process.env.INFINITY_API_URL;
  return PRODUCTION_API;
})();

export const updateFeedUrl = PRODUCTION_UPDATES;

/**
 * macOS cannot apply an update to an unsigned application - Squirrel requires a valid
 * signature - so these builds notify and hand off to the download page instead. Windows
 * updates normally even unsigned.
 */
export const canSelfUpdate = process.platform === 'win32';

/** Origins the renderer may talk to. Everything else is blocked at the navigation guard. */
export const allowedApiOrigins = new Set(
  [apiUrl, devServer].filter(Boolean).map((value) => new URL(value!).origin),
);

/**
 * The object storage origin, learned from the server at startup.
 *
 * Uploads go straight from the renderer to storage with a presigned URL, so that origin
 * has to be permitted by both the content security policy and the main-process request
 * filter. It cannot be baked in at build time - it is server configuration, and a client
 * that hardcoded it would break the moment the bucket moved.
 *
 * Learned from the server rather than accepted from the renderer: a renderer that could
 * nominate its own permitted origin could nominate an attacker's.
 */
export async function learnStorageOrigin(): Promise<void> {
  try {
    const response = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    const body = (await response.json()) as { storageOrigin?: string | null };
    if (!body.storageOrigin) return;
    const origin = new URL(body.storageOrigin).origin;
    // https only: a plaintext upload endpoint would send file contents in the clear.
    if (!origin.startsWith('https://')) return;
    allowedApiOrigins.add(origin);
    storageOrigin = origin;
  } catch {
    /**
     * The server being unreachable at startup is not fatal - the sign-in screen reports
     * it far better than a crash would. Uploads fail until the app is restarted with the
     * server up, which is the same state everything else is in.
     */
  }
}

let storageOrigin: string | null = null;

export function currentStorageOrigin(): string | null {
  return storageOrigin;
}

export function appConfig(): AppConfig {
  return {
    apiUrl,
    appVersion: app.getVersion(),
    platform: process.platform,
    canSelfUpdate,
  };
}
