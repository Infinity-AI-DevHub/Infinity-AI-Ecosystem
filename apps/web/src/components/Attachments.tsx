/**
 * Files attached to a documentation page.
 *
 * Uploads go through the ordinary file pipeline - a session, a direct upload, then a
 * completion - rather than a second route into storage. That is what keeps scanning,
 * quota accounting and retention applying to a document attachment exactly as they do
 * to anything in Files.
 */
import { useRef, useState } from 'react';
import { api, API_URL, ApiError, idempotencyKey, uploadAuth } from '../lib/api';
import { useQuery } from '../lib/query';
import { formatBytes } from '../lib/format';

type Attachment = {
  id: string;
  file_id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  uploaded_by_name: string | null;
};

export function Attachments({ pageId }: { pageId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery<{ items: Attachment[] }>(`/docs/pages/${pageId}/attachments`, (signal) =>
    api.get(`/docs/pages/${pageId}/attachments`, signal),
  );

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const session = await api.post<{ uploadId: string }>(
        '/files/uploads',
        { filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
        { idempotencyKey: idempotencyKey() },
      );
      // The bytes go straight to storage; only the completion comes back through the API.
      const form = new FormData();
      form.append('file', file, file.name);
      const auth = await uploadAuth();
      const put = await fetch(
        `${API_URL}/api/v1/files/uploads/${session.uploadId}/content`,
        { method: 'POST', ...auth, body: form },
      );
      if (!put.ok) {
        const payload = await put.json().catch(() => null);
        throw new Error(payload?.error?.message ?? 'That upload was rejected');
      }

      const completed = await api.post<{ id: string }>(
        `/files/uploads/${session.uploadId}/complete`, {},
        { idempotencyKey: idempotencyKey() },
      );
      await api.post(`/docs/pages/${pageId}/attachments`, { fileId: completed.id });
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That file could not be attached');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function detach(attachmentId: string) {
    setError(null);
    try {
      await api.delete(`/docs/pages/${pageId}/attachments/${attachmentId}`);
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That attachment could not be removed');
    }
  }

  return (
    <div className="field">
      <span className="label-row">Attachments</span>

      {(list.data?.items ?? []).length === 0 ? (
        <p className="field-hint">Nothing attached yet.</p>
      ) : (
        <ul className="plain-list">
          {list.data!.items.map((item) => (
            <li key={item.id}>
              <span>{item.name}</span>{' '}
              <span className="field-hint">{formatBytes(item.size_bytes)}</span>{' '}
              <button type="button" className="ghost-button" onClick={() => void detach(item.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={input}
        type="file"
        className="file-upload-label"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {busy ? <p className="field-hint">Uploading…</p> : null}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}
