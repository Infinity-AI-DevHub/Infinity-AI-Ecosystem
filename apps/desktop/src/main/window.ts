import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { allowedApiOrigins, devServer } from './config';

/**
 * The application window, and the security posture that goes with it.
 *
 * Every flag here is deliberate. In a browser a renderer compromise is stored XSS; in
 * Electron, a renderer with Node access is remote code execution on the employee's
 * machine. The renderer therefore gets no Node, no module system, and no way to reach the
 * main process except the named channels in the preload bridge.
 */
export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#f1f3f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The three that matter most. Context isolation keeps the preload's privileged
      // scope out of reach of page script; sandbox puts the renderer in the OS sandbox;
      // nodeIntegration off means `require` does not exist in the page at all.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      // Same-origin policy stays on. Cross-origin calls to the API are permitted by the
      // API's own CORS configuration rather than by disabling the check here.
      webSecurity: true,
      spellcheck: true,
    },
  });

  // Painting only once there is something to paint avoids the white flash that makes a
  // desktop app feel like a web page in a frame.
  window.once('ready-to-show', () => window.show());

  /**
   * Load diagnostics.
   *
   * A renderer that fails to load shows an empty window and says nothing, which is
   * indistinguishable from a slow network. These two lines are the difference between
   * "the app is broken" and knowing which URL failed and why.
   */
  window.webContents.on('did-finish-load', () => {
    console.log(`[renderer] loaded ${window.webContents.getURL()}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason}`);
  });

  /**
   * Navigation is pinned to the application itself.
   *
   * Without this, a link in a document or a chat message could navigate the whole window
   * to an attacker's page, which would then be running inside the application frame with
   * the app's own look and its preload attached.
   */
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const isApp = target.protocol === 'app:';
    const isDev = devServer !== null && target.origin === new URL(devServer).origin;
    if (!isApp && !isDev) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  /**
   * Anything asking for a new window is a link to the outside world, so it opens in the
   * real browser rather than a chromeless Electron window that looks like the app.
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  /**
   * Permissions are denied by default and granted only where the product actually asks.
   * Notifications yes; camera and microphone for meetings; everything else no.
   */
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(['notifications', 'media'].includes(permission));
  });

  // Attaching a debugger to a packaged build is a common way to lift tokens out of a
  // running app, so the shortcut is only wired up when unpackaged.
  window.webContents.on('before-input-event', (event, input) => {
    const devtools =
      input.key.toLowerCase() === 'i' && (input.control || input.meta) && input.shift;
    if (devtools && devServer === null) event.preventDefault();
  });

  return window;
}

/** Origins the renderer is permitted to reach over the network. */
export const networkAllowList = allowedApiOrigins;
