/**
 * The page someone outside the company lands on when they follow a share link.
 *
 * They have no account, no navigation and no way back into the product, so this screen
 * carries no workspace chrome. It also says as little as possible: a name, a size, and
 * whether a password is needed. Anything more - who shared it, which folder it sits in,
 * who else received it - would leak the company's structure to whoever holds the URL.
 *
 * Every failure looks the same on purpose. Expired, revoked, used up and never-existed
 * are one message, because distinguishing them would confirm a guessed token.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, FileText, FolderOpen, Lock, ShieldAlert } from 'lucide-react';
import { api, ApiError, NetworkError } from '../lib/api';
import { FormError } from '../components/States';
import { formatDateTime } from '../lib/format';

type Preview = {
  resourceType: 'file' | 'folder';
  requiresPassword: boolean;
  allowDownload: boolean;
  expiresAt: string;
  resource: { name: string; sizeBytes: number | null; itemCount: number | null } | null;
};

function readableSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export default function SharedResource() {
  const { token = '' } = useParams();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [pending, setPending] = useState(false);
  const [opened, setOpened] = useState<{ url: string; filename: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<Preview>(`/shared/${token}`)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const open = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api.post<{ download: { url: string; filename: string } | null }>(
        `/shared/${token}/open`,
        { password: password || null },
      );
      if (result.download) setOpened(result.download);
      else setUnavailable(true);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
    } finally {
      setPending(false);
    }
  };

  if (unavailable) {
    return (
      <main className="share-page">
        <section className="share-card">
          <div className="state-block state-error">
            <span className="state-icon"><ShieldAlert size={20} aria-hidden="true" /></span>
            <h1>This link is no longer available</h1>
            <p>
              It may have expired, been used already, or been withdrawn. Ask whoever sent
              it for a new one.
            </p>
          </div>
        </section>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="share-page">
        <section className="share-card">
          <div className="skeleton-stack" aria-busy="true" aria-label="Loading">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        </section>
      </main>
    );
  }

  const Icon = preview.resourceType === 'folder' ? FolderOpen : FileText;
  const size = readableSize(preview.resource?.sizeBytes ?? null);

  return (
    <main className="share-page">
      <section className="share-card">
        <h1>{opened ? 'Ready to download' : 'Shared with you'}</h1>

        <div className="share-resource">
          <Icon size={22} aria-hidden="true" />
          <div>
            <strong>{preview.resource?.name ?? 'Shared item'}</strong>
            <span>
              {preview.resourceType === 'folder'
                ? `${preview.resource?.itemCount ?? 0} item${preview.resource?.itemCount === 1 ? '' : 's'}`
                : size ?? 'File'}
            </span>
          </div>
        </div>

        {opened ? (
          <a className="primary-button" href={opened.url} rel="noopener noreferrer">
            <Download size={15} aria-hidden="true" /> Download {opened.filename}
          </a>
        ) : (
          <>
            <FormError error={error} />
            <form onSubmit={open} noValidate>
              {preview.requiresPassword ? (
                <div className="field">
                  <label htmlFor="share-password">
                    <Lock size={13} aria-hidden="true" /> Password
                  </label>
                  <input
                    id="share-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    autoFocus
                  />
                  <p className="field-hint">Whoever sent this link will have given you the password.</p>
                </div>
              ) : null}
              <button type="submit" className="primary-button" disabled={pending}>
                {pending ? 'Opening…' : preview.allowDownload ? 'Open and download' : 'Open'}
              </button>
            </form>
          </>
        )}

        <p className="share-expiry">
          This link stops working on {formatDateTime(preview.expiresAt)}.
        </p>
      </section>
    </main>
  );
}
