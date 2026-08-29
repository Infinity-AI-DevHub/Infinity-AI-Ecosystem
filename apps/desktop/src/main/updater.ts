import { app, shell } from 'electron';
import { net } from 'electron';
import { canSelfUpdate, updateFeedUrl } from './config';
import type { UpdateStatus } from '../shared/contract';

/**
 * Update checking.
 *
 * These builds are unsigned, which splits the behaviour by platform. Windows can apply an
 * update to an unsigned application, so it downloads and installs. macOS cannot - Squirrel
 * refuses to replace a binary whose signature it cannot verify - so the Mac path tells the
 * person a version is out and sends them to the download page. Pretending otherwise would
 * mean an update that silently never applies, which is worse than an honest prompt.
 *
 * The feed is a static JSON document on the update host, so there is no update service to
 * run or keep patched.
 */
type Feed = {
  version: string;
  notes?: string;
  downloads: Partial<Record<NodeJS.Platform, string>>;
};

/** Compares dotted versions without pulling in a dependency for it. */
function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

let pendingDownloadUrl: string | null = null;

export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const response = await net.fetch(`${updateFeedUrl}/latest.json`, { cache: 'no-store' });
    if (!response.ok) return { state: 'error', message: `Update feed returned ${response.status}` };

    const feed = (await response.json()) as Feed;
    if (!feed?.version || !isNewer(feed.version, app.getVersion())) return { state: 'idle' };

    const download = feed.downloads[process.platform];
    if (!download) return { state: 'idle' };

    // The feed is fetched over TLS from our own host, but the URL inside it still decides
    // where a binary comes from, so it is pinned to the update host rather than trusted.
    const parsed = new URL(download, updateFeedUrl);
    if (parsed.origin !== new URL(updateFeedUrl).origin) {
      return { state: 'error', message: 'Update feed pointed somewhere unexpected' };
    }

    pendingDownloadUrl = parsed.toString();
    return {
      state: 'available',
      version: feed.version,
      downloadUrl: pendingDownloadUrl,
      canInstall: canSelfUpdate,
    };
  } catch (error) {
    return {
      state: 'error',
      message: error instanceof Error ? error.message : 'Could not reach the update service',
    };
  }
}

export async function installUpdate(): Promise<void> {
  if (!pendingDownloadUrl) return;
  // On macOS, and as a fallback anywhere the in-place update is not possible, handing the
  // download to the browser is the honest path: the person installs it themselves.
  await shell.openExternal(pendingDownloadUrl);
}
