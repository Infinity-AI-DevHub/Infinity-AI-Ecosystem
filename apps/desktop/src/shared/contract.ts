/**
 * The contract between the main process and the renderer.
 *
 * Shared by both sides so a channel cannot be renamed on one side alone, and so the
 * renderer sees a typed surface rather than a raw `ipcRenderer`. Everything the renderer
 * is allowed to ask for is named here; there is deliberately no generic "invoke anything"
 * escape hatch, because that is the door through which a renderer compromise becomes a
 * host compromise.
 */

/** Where the API lives. Baked at build time, overridable for development only. */
export type AppConfig = {
  apiUrl: string;
  appVersion: string;
  platform: NodeJS.Platform;
  /** Unsigned macOS builds cannot self-update; the renderer adjusts its prompt. */
  canSelfUpdate: boolean;
};

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; downloadUrl: string; canInstall: boolean }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

/** Channel names in one place so main and preload cannot drift apart. */
export const CHANNELS = {
  config: 'app:config',
  sessionGet: 'session:get',
  sessionSet: 'session:set',
  sessionClear: 'session:clear',
  openExternal: 'shell:open-external',
  saveFile: 'dialog:save-file',
  pickFiles: 'dialog:pick-files',
  notify: 'os:notify',
  badgeSet: 'os:badge',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateStatus: 'update:status',
} as const;

/** The surface exposed on `window.infinity` by the preload bridge. */
export type DesktopBridge = {
  config: () => Promise<AppConfig>;
  session: {
    get: () => Promise<StoredSession | null>;
    set: (session: StoredSession) => Promise<void>;
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
    check: () => Promise<UpdateStatus>;
    install: () => Promise<void>;
    onStatus: (handler: (status: UpdateStatus) => void) => () => void;
  };
};
