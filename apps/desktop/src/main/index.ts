/**
 * Infinity Workspace desktop client - main process.
 *
 * The main process owns everything the renderer is not trusted with: the session tokens,
 * the filesystem, the network allow list and the window's security posture. It exposes a
 * small, named surface over IPC and nothing else.
 */
import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { devServer } from './config';
import { registerIpc } from './ipc';
import { APP_SCHEME, registerSchemePrivileges, serveRenderer } from './protocol';
import { createWindow } from './window';

registerSchemePrivileges();

let mainWindow: BrowserWindow | null = null;

/**
 * One instance only. A second launch focuses the running window instead of starting a
 * second process that would race the first for the same token vault.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    /**
     * Strip the Electron and Chrome version strings from the user agent.
     *
     * They tell an attacker exactly which browser engine vulnerabilities apply to every
     * employee's machine, and the API has no use for them.
     */
    session.defaultSession.setUserAgent(`InfinityWorkspace/${app.getVersion()}`);

    /**
     * A second, independent check on where the renderer may connect.
     *
     * The content security policy already restricts this, but a CSP is enforced inside
     * the renderer - the process we are treating as untrusted. This runs in the main
     * process, so a compromised renderer cannot lift it.
     */
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      /**
       * A WebSocket to the API has origin `ws://host`, which never string-matches the
       * `http://host` the allow list holds - so comparing them directly silently blocks
       * realtime while leaving every ordinary request working, which is a confusing way
       * to fail. The scheme is normalised before the comparison.
       */
      const origin = url.origin.replace(/^ws/, 'http');
      const permitted =
        url.protocol === `${APP_SCHEME}:` ||
        url.protocol === 'devtools:' ||
        url.protocol === 'blob:' ||
        url.protocol === 'data:' ||
        [...networkAllowList()].includes(origin);
      callback({ cancel: !permitted });
    });

    if (devServer === null) {
      serveRenderer(join(__dirname, '../renderer'));
    }

    registerIpc(() => mainWindow);
    mainWindow = createWindow();

    void (devServer
      ? mainWindow.loadURL(devServer)
      : mainWindow.loadURL(`${APP_SCHEME}://-/index.html`));

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  // On macOS an application conventionally stays running with no windows; elsewhere
  // closing the last window means quitting.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/** Imported lazily so the config module's URL parsing runs after app.whenReady. */
function networkAllowList(): Set<string> {
  return require('./config').allowedApiOrigins as Set<string>;
}
