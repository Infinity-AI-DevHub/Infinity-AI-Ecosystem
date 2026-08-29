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

export function appConfig(): AppConfig {
  return {
    apiUrl,
    appVersion: app.getVersion(),
    platform: process.platform,
    canSelfUpdate,
  };
}
