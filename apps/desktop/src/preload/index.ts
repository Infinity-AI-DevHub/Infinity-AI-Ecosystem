/**
 * The bridge between the renderer and the main process.
 *
 * This is the entire attack surface between page script and the operating system, so it
 * is written as a fixed list of functions rather than anything that forwards a channel
 * name. The renderer cannot name a channel; it can only call one of these.
 *
 * `ipcRenderer` itself is never exposed. Handing it to the page - even behind a wrapper
 * that "only forwards known channels" - is the classic Electron mistake, because the
 * wrapper inevitably grows an escape hatch.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type DesktopBridge, type StoredSession, type UpdateStatus } from '../shared/contract';

/**
 * This file is bundled into a single self-contained script before it ships.
 *
 * A sandboxed preload cannot `require` a relative file - only `electron` and a handful of
 * builtins - so importing the shared contract from source would throw at load and expose
 * nothing at all, silently. Bundling keeps one definition of the channel names while
 * giving the sandbox a single file with no local requires in it.
 */

const bridge: DesktopBridge = {
  config: () => ipcRenderer.invoke(CHANNELS.config),

  session: {
    get: () => ipcRenderer.invoke(CHANNELS.sessionGet),
    set: (session: StoredSession) => ipcRenderer.invoke(CHANNELS.sessionSet, session),
    clear: () => ipcRenderer.invoke(CHANNELS.sessionClear),
  },

  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.openExternal, url),

  saveFile: (input) => ipcRenderer.invoke(CHANNELS.saveFile, input),
  pickFiles: (input) => ipcRenderer.invoke(CHANNELS.pickFiles, input),

  notify: (input) => ipcRenderer.invoke(CHANNELS.notify, input),
  setBadge: (count: number) => ipcRenderer.invoke(CHANNELS.badgeSet, count),

  update: {
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    /**
     * Subscribing returns its own unsubscribe rather than exposing `removeListener`,
     * so the renderer never holds a reference it could use to strip other listeners.
     */
    onStatus: (handler: (status: UpdateStatus) => void) => {
      const listener = (_event: unknown, status: UpdateStatus) => handler(status);
      ipcRenderer.on(CHANNELS.updateStatus, listener);
      return () => ipcRenderer.removeListener(CHANNELS.updateStatus, listener);
    },
  },
};

contextBridge.exposeInMainWorld('infinity', bridge);

/**
 * Navigation requested by the main process - from a clicked notification.
 *
 * Delivered as a DOM event rather than a callback the renderer registers, so the router
 * can listen without the preload needing to know anything about React.
 */
ipcRenderer.on('app:navigate', (_event, route: string) => {
  window.dispatchEvent(new CustomEvent('infinity:navigate', { detail: route }));
});
