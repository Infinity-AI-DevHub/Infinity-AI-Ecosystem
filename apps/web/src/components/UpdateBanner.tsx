/**
 * Tells someone a new version is out.
 *
 * Unsigned builds split by platform: Windows can replace itself, macOS cannot - Squirrel
 * will not swap a binary whose signature it cannot verify - so the Mac path hands the
 * download to the browser and the person installs it. Saying so plainly beats an
 * "Install" button that silently does nothing, which is what pretending otherwise would
 * produce.
 */
import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { desktop, isDesktop } from '../lib/desktop';

type Status = {
  state: string;
  version?: string;
  canInstall?: boolean;
  message?: string;
};

/** Checked on launch and then daily; a desktop app left open for a week is normal. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function UpdateBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const bridge = desktop;
    if (!isDesktop || !bridge) return;

    let cancelled = false;
    const check = async () => {
      const result = (await bridge.update.check()) as Status;
      if (!cancelled && result?.state === 'available') setStatus(result);
    };

    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const unsubscribe = bridge.update.onStatus((next) => {
      if (!cancelled) setStatus(next as Status);
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  if (!status || status.state !== 'available' || dismissed) return null;

  return (
    <div className="update-banner" role="status">
      <Download size={15} aria-hidden="true" />
      <span>
        Version {status.version} is available.{' '}
        {status.canInstall
          ? 'It will install when you restart.'
          : 'Download it to update — this build cannot replace itself.'}
      </span>
      <button type="button" className="ghost-button" onClick={() => void desktop?.update.install()}>
        {status.canInstall ? 'Restart to update' : 'Download'}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss update notice"
        onClick={() => setDismissed(true)}
      >
        <X size={14} />
      </button>
    </div>
  );
}
