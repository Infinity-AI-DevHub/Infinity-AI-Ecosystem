/**
 * Looking at a file without downloading it first.
 *
 * Downloading to check whether you have the right document is a poor trade: it leaves
 * copies in everyone's Downloads folder, and on the desktop it opens whatever the OS
 * decides. So the common types are rendered here instead, and anything unrecognised says
 * so plainly rather than showing an empty frame.
 *
 * The bytes are fetched and shown from a `blob:` URL the renderer owns, never by
 * pointing an <img> or <iframe> straight at the download link. That is deliberate: the
 * download route serves everything as `application/octet-stream; attachment` with
 * `nosniff` precisely so an uploaded file can never render inline on the API's origin,
 * which is what stops a stored HTML payload executing there. Fetching the bytes and
 * choosing the type here keeps that guarantee and still shows the file.
 *
 * Only known-safe kinds are rendered. HTML is not among them; text is put in a <pre> as
 * text; and SVG arrives through <img>, where scripts inside it do not run.
 *
 * PDFs are the exception: Chromium's built-in viewer needs `plugins` enabled and an
 * <embed> the app's `object-src 'none'` policy forbids, and relaxing both to render a
 * document inline is a poor trade. They open in the reader you already use instead.
 */
import { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { saveDownload } from '../lib/desktop';
import { formatBytes } from '../lib/format';

export type PreviewTarget = {
  fileId: string;
  name: string;
  mimeType: string | null;
  sizeBytes?: number | null;
};

/** Text is fetched and shown inline, so it needs a ceiling. */
const MAX_TEXT_BYTES = 512 * 1024;

type Kind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'none';

function kindOf(mime: string | null, name: string): Kind {
  const type = (mime ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/') || /^application\/(json|xml|x-yaml)$/.test(type)) return 'text';
  // Some servers store source and data files as octet-stream; the extension is a better
  // guide than a content type that says "bytes".
  if (/\.(txt|md|csv|json|log|ya?ml|xml|ts|tsx|js|css|html|sql)$/i.test(name)) return 'text';
  return 'none';
}

export function FilePreview({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kind = kindOf(target.mimeType, target.name);
  const tooBigForText = kind === 'text' && (target.sizeBytes ?? 0) > MAX_TEXT_BYTES;

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setUrl(null); setDownloadUrl(null); setText(null); setError(null);

    void (async () => {
      try {
        const link = await api.get<{ url: string }>(`/files/${target.fileId}/download`);
        if (cancelled) return;
        setDownloadUrl(link.url);

        if (kind === 'none' || kind === 'pdf') return;

        const res = await fetch(link.url);
        if (!res.ok) throw new Error(`Storage returned ${res.status}`);

        if (kind === 'text') {
          const body = tooBigForText ? '' : (await res.text()).slice(0, MAX_TEXT_BYTES);
          if (!cancelled) setText(body);
          return;
        }

        // Re-typed on the way in: the response is deliberately octet-stream, and the
        // viewer needs to know what it is actually looking at.
        const typed = new Blob([await res.arrayBuffer()], {
          type: target.mimeType ?? 'application/octet-stream',
        });
        const objectUrl = URL.createObjectURL(typed);
        created = objectUrl;
        if (cancelled) { URL.revokeObjectURL(objectUrl); return; }
        setUrl(objectUrl);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'That file could not be opened.');
        }
      }
    })();

    // The blob is held only while the dialog is open.
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
  }, [target.fileId, kind, tooBigForText, target.mimeType]);

  // Escape closes, as it does in every other dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog-preview"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${target.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="preview-head">
          <div className="preview-title">
            <strong>{target.name}</strong>
            <span className="field-hint">
              {[target.mimeType, target.sizeBytes ? formatBytes(target.sizeBytes) : null]
                .filter(Boolean).join(' · ')}
            </span>
          </div>
          <div className="table-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={!downloadUrl}
              onClick={() => { if (downloadUrl) void saveDownload(downloadUrl, target.name); }}
            >
              <Download size={14} aria-hidden="true" /> Download
            </button>
            <button type="button" className="ghost-button" onClick={onClose}>Close</button>
          </div>
        </header>

        <div className="preview-body">
          {error ? <p className="field-error">{error}</p> : null}

          {!error && !downloadUrl ? <p className="field-hint">Opening…</p> : null}

          {url && kind === 'image' ? (
            <img className="preview-image" src={url} alt={target.name} />
          ) : null}

          {downloadUrl && kind === 'pdf' ? (
            <div className="preview-fallback">
              <FileText size={30} aria-hidden="true" />
              <p><strong>{target.name}</strong></p>
              <p className="field-hint">
                PDFs open in your usual reader, where you can search, print and sign them.
              </p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void saveDownload(downloadUrl, target.name)}
              >
                Open PDF
              </button>
            </div>
          ) : null}

          {url && kind === 'video' ? (
            <video className="preview-media" src={url} controls />
          ) : null}

          {url && kind === 'audio' ? (
            <audio className="preview-media" src={url} controls />
          ) : null}

          {downloadUrl && kind === 'text' ? (
            tooBigForText ? (
              <p className="field-hint">
                This file is {formatBytes(target.sizeBytes ?? 0)} — too large to show here.
                Download it to read the whole thing.
              </p>
            ) : text !== null ? (
              <pre className="preview-text">{text}</pre>
            ) : <p className="field-hint">Reading…</p>
          ) : null}

          {downloadUrl && kind === 'none' ? (
            <p className="field-hint">
              There is no preview for this kind of file. Download it to open it in the
              application it belongs to.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
