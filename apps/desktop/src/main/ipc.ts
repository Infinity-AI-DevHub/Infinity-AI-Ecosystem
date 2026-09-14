import { BrowserWindow, dialog, ipcMain, Notification, shell, app } from 'electron';
import { writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { CHANNELS, type StoredSession, type UpdateStatus } from '../shared/contract';
import { appConfig } from './config';
import { clearSession, readSession, writeSession } from './vault';
import { checkForUpdate, installUpdate } from './updater';

/**
 * The privileged operations the renderer may ask for.
 *
 * Each handler validates its own input rather than trusting the caller. The renderer is
 * our own code, but it is also the part of the system that renders documents and chat
 * messages written by other people - so it is treated as the least trusted component in
 * the process, not the most.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.config, () => appConfig());

  ipcMain.handle(CHANNELS.sessionGet, () => readSession());
  ipcMain.handle(CHANNELS.sessionSet, (_event, session: StoredSession) => {
    if (
      typeof session?.accessToken !== 'string' ||
      typeof session?.refreshToken !== 'string'
    ) {
      throw new Error('Refusing to store a malformed session');
    }
    writeSession(session);
  });
  ipcMain.handle(CHANNELS.sessionClear, () => clearSession());

  /**
   * Opening a link in the real browser.
   *
   * Restricted to http and https: without that check a document could hand the main
   * process a `file://` path to open, and on Windows a `.url` or `.lnk` target, which is
   * command execution wearing a link's clothing.
   */
  ipcMain.handle(CHANNELS.openExternal, async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  });

  /**
   * Opening Infinity Mail.
   *
   * Mail is a separate application holding each person's mailbox credentials, so the
   * workspace launches it rather than embedding or talking to it. The renderer supplies
   * nothing: the target is fixed here, by bundle identifier on macOS and by the installer's
   * known locations on Windows, so this cannot be used to launch anything else.
   */
  ipcMain.handle(CHANNELS.openMail, async (): Promise<'opened' | 'not_installed'> => {
    if (process.platform === 'darwin') {
      return new Promise((resolve) => {
        execFile('open', ['-b', 'com.iinfinityai.mail'], (error) =>
          resolve(error ? 'not_installed' : 'opened'));
      });
    }
    if (process.platform === 'win32') {
      const candidates = [
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'infinity-mail', 'Infinity Mail.exe'),
        process.env.ProgramFiles && join(process.env.ProgramFiles, 'Infinity Mail', 'Infinity Mail.exe'),
      ].filter((path): path is string => Boolean(path));
      for (const path of candidates) {
        try {
          if (statSync(path).isFile() && (await shell.openPath(path)) === '') return 'opened';
        } catch {
          /* not at this location */
        }
      }
    }
    return 'not_installed';
  });

  /** Saving a downloaded file where the person chooses, through the OS dialog. */
  ipcMain.handle(
    CHANNELS.saveFile,
    async (_event, input: { suggestedName: string; data: ArrayBuffer }) => {
      const window = getWindow();
      if (!window) return null;
      const result = await dialog.showSaveDialog(window, {
        defaultPath: basename(input.suggestedName || 'download'),
      });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, Buffer.from(input.data));
      return result.filePath;
    },
  );

  /**
   * Picking files to upload.
   *
   * Only metadata crosses back to the renderer - never the contents. The renderer reads
   * the bytes through the ordinary web File API, so an oversized selection cannot be
   * marshalled through IPC and exhaust the main process's memory.
   */
  ipcMain.handle(
    CHANNELS.pickFiles,
    async (_event, input?: { accept?: string[]; multiple?: boolean }) => {
      const window = getWindow();
      if (!window) return [];
      const result = await dialog.showOpenDialog(window, {
        properties: input?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: input?.accept?.length
          ? [{ name: 'Allowed', extensions: input.accept.map((e) => e.replace(/^\./, '')) }]
          : undefined,
      });
      if (result.canceled) return [];
      return result.filePaths.map((path) => ({
        name: basename(path),
        path,
        size: statSync(path).size,
      }));
    },
  );

  ipcMain.handle(
    CHANNELS.notify,
    async (_event, input: { title: string; body: string; deepLink?: string }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: String(input.title).slice(0, 200),
        body: String(input.body).slice(0, 500),
      });
      notification.on('click', () => {
        const window = getWindow();
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.focus();
        // The deep link is a route inside the app, never a URL, so a notification cannot
        // be used to navigate the window somewhere unexpected.
        if (input.deepLink && /^\/[\w\-/?=&.]*$/.test(input.deepLink)) {
          window.webContents.send('app:navigate', input.deepLink);
        }
      });
      notification.show();
    },
  );

  ipcMain.handle(CHANNELS.badgeSet, (_event, count: number) => {
    const value = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (process.platform === 'darwin') app.dock?.setBadge(value ? String(value) : '');
    else getWindow()?.setOverlayIcon(null, value ? `${value} unread` : '');
  });

  ipcMain.handle(CHANNELS.updateCheck, async (): Promise<UpdateStatus> => checkForUpdate());
  ipcMain.handle(CHANNELS.updateInstall, async () => installUpdate());
}
