/**
 * Your saved signature.
 *
 * Uploaded once and reused, because being asked to find a PNG every time you approve
 * something is how people end up keeping it on the desktop and emailing it around.
 *
 * The image is stored against your account and can only be placed by you. It is what a
 * reader recognises; what actually makes a signature verifiable is the record written
 * beside it — your account, the time, and a hash of the document as it stood.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { uploadWorkspaceFile } from '../lib/uploads';
import { useNotify } from '../lib/notify';

export function SignatureSettings({ onSaved }: { onSaved?: () => void } = {}) {
  const { notify } = useNotify();
  const input = useRef<HTMLInputElement>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const saved = await api.get<{ file_id: string | null }>('/me/signature');
    setFileId(saved.file_id);
    if (saved.file_id) {
      // A short-lived signed URL, requested at display time rather than stored in markup.
      const link = await api.get<{ url: string }>(`/files/${saved.file_id}/download`);
      setPreview(link.url);
    } else {
      setPreview(null);
    }
  }

  useEffect(() => { void load().catch(() => undefined); }, []);

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      if (!/^image\/(png|jpeg|svg\+xml)$/.test(file.type)) {
        throw new Error('Use a PNG, JPEG or SVG. A PNG with a transparent background sits best on a document.');
      }
      const uploaded = await uploadWorkspaceFile<{ id: string }>(file);
      await api.put('/me/signature', { fileId: uploaded.id });
      notify({ severity: 'success', title: 'Signature saved' });
      await load();
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <section className="panel" aria-labelledby="signature-heading">
      <header className="panel-header">
        <span className="panel-title" id="signature-heading">Your signature</span>
      </header>

      <p className="field-hint">
        Used when you sign a quotation, invoice or receipt in the app. A PNG with a
        transparent background looks best over a document.
      </p>

      <div className="signature-preview">
        {preview ? (
          <img src={preview} alt="Your saved signature" />
        ) : (
          <span className="field-hint">Nothing saved yet.</span>
        )}
      </div>

      <label className="field">
        <span>{fileId ? 'Replace it' : 'Upload a signature'}</span>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </label>

      {busy ? <p className="field-hint">Uploading…</p> : null}
      {error ? <p className="field-error">{error}</p> : null}

      <p className="field-hint">
        Replacing it does not change signatures you have already made — those keep the
        image they were signed with, so an old document still looks the way it did.
      </p>
    </section>
  );
}
