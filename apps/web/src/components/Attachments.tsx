/**
 * Files attached to a documentation page.
 *
 * Uploads go through the ordinary file pipeline - a session, a direct upload, then a
 * completion - rather than a second route into storage. That is what keeps scanning,
 * quota accounting and retention applying to a document attachment exactly as they do
 * to anything in Files.
 */
import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useQuery } from '../lib/query';
import { formatBytes } from '../lib/format';
import { uploadWorkspaceFile } from '../lib/uploads';

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
    if (file.size === 0) {
      setError('This file is empty. Choose a file that contains data.');
      if (input.current) input.current.value = '';
      return;
    }
    setBusy(true);
    try {
      const completed = await uploadWorkspaceFile<{ id: string }>(file);
      await api.post(`/docs/pages/${pageId}/attachments`, { fileId: completed.id });
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be attached');
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
      <p className="field-hint">
        Common formats such as PDF, DOCX, PNG, ZIP and TXT are supported. Files without
        browser MIME metadata are accepted and verified securely after upload.
      </p>
      {busy ? <p className="field-hint">Uploading…</p> : null}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}
