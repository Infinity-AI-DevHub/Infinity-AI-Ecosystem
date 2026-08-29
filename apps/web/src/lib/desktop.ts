/**
 * Access to the desktop bridge, and the single flag that tells the rest of the app which
 * world it is running in.
 *
 * The same React code ships in two places: inside Electron for employees, and as a small
 * public web build for share links and activation. Rather than fork the codebase, the
 * handful of places that genuinely differ - how a request is authenticated, where a token
 * is kept, whether a file save uses a native dialog - ask this module.
 */

/** Mirrors the shape the preload exposes; kept structural so the renderer imports nothing from Electron. */
export type DesktopBridge = {
  config: () => Promise<{
    apiUrl: string;
    appVersion: string;
    platform: string;
    canSelfUpdate: boolean;
  }>;
  session: {
    get: () => Promise<{ accessToken: string; refreshToken: string; expiresAt: string } | null>;
    set: (session: { accessToken: string; refreshToken: string; expiresAt: string }) => Promise<void>;
    clear: () => Promise<void>;
  };
  openExternal: (url: string) => Promise<boolean>;
  saveFile: (input: { suggestedName: string; data: ArrayBuffer }) => Promise<string | null>;
  pickFiles: (input?: { accept?: string[]; multiple?: boolean }) => Promise<
    { name: string; path: string; size: number }[]
  >;
  notify: (input: { title: string; body: string; deepLink?: string }) => Promise<void>;
  setBadge: (count: number) => Promise<void>;
  update: {
    check: () => Promise<Record<string, unknown>>;
    install: () => Promise<void>;
    onStatus: (handler: (status: Record<string, unknown>) => void) => () => void;
  };
};

declare global {
  interface Window {
    infinity?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | null =
  typeof window !== 'undefined' && window.infinity ? window.infinity : null;

export const isDesktop = desktop !== null;

/**
 * Opens a link the way the current host should.
 *
 * In Electron an external link must leave the application window - navigating in place
 * would put somebody else's page inside the app frame - so it goes through the bridge,
 * which refuses anything that is not http or https.
 */
export async function openExternal(url: string): Promise<void> {
  if (desktop) {
    await desktop.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Saves a file the way the current host should.
 *
 * In a browser this is an anchor with a download attribute. On the desktop that would
 * drop the file into the downloads folder with no say in the matter, so it goes through
 * the OS save dialog instead - which is the behaviour people expect from an application
 * rather than a web page.
 *
 * The bytes are fetched here rather than in the main process so that the request carries
 * the renderer's own credentials, and so the main process never needs to know how this
 * application authenticates.
 */
export async function saveDownload(
  url: string,
  suggestedName: string,
): Promise<'saved' | 'cancelled' | 'browser'> {
  if (!desktop) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return 'browser';
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error('That file could not be downloaded');
  const data = await response.arrayBuffer();
  const saved = await desktop.saveFile({ suggestedName, data });
  return saved ? 'saved' : 'cancelled';
}
