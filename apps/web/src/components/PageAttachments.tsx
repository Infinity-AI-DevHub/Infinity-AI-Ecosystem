/**
 * Files attached to a document page.
 *
 * The API for this has existed since attachments were built - attach, list and detach -
 * and nothing in the interface ever called it, so a page could hold files that nobody
 * could add or see. This is that missing surface.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, Paperclip, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { uploadWorkspaceFile } from '../lib/uploads';
import { saveDownload } from '../lib/desktop';
import { formatBytes, relativeTime } from '../lib/format';
import { useNotify } from '../lib/notify';
import { useConfirm } from './Prompt';
import { FilePreview, type PreviewTarget } from './FilePreview';

type Attachment = {
  id: string;
  file_id: string;
  name: string;
  size_bytes: number;
  mime_type: string | null;
  created_at: string;
  uploaded_by_name: string | null;
};

export function PageAttachments({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const { notify } = useNotify();
  const { confirm, element: confirmElement } = useConfirm();
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null);

  const load = useCallback(async () => {
    const result = await api.get<{ items: Attachment[] }>(`/docs/pages/${pageId}/attachments`);
    setItems(result.items);
  }, [pageId]);

  useEffect(() => { void load().catch(() => undefined); }, [load]);

  async function add(file: File) {
    setError(null);
    setBusy(true);
    try {
      // Uploaded to the drive first, then linked: an attachment is a normal workspace
      // file, so it keeps versioning, scanning and the recycle bin.
      const uploaded = await uploadWorkspaceFile<{ id: string }>(file);
      await api.post(`/docs/pages/${pageId}/attachments`, { fileId: uploaded.id });
      await load();
      notify({ severity: 'success', title: `${file.name} attached` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(attachment: Attachment) {
    const yes = await confirm({
      title: `Remove ${attachment.name}?`,
      description: 'It stays in Files — this only unlinks it from this page.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!yes) return;
    try {
      await api.delete(`/docs/pages/${pageId}/attachments/${attachment.id}`);
      await load();
    } catch (err) {
      notify({
        severity: 'warning',
        title: err instanceof ApiError ? err.message : 'That could not be removed',
      });
    }
  }

  return (
    <section className="panel attachments-panel" aria-labelledby={`attachments-${pageId}`}>
      <header className="panel-header">
        <div>
          <Paperclip size={15} aria-hidden="true" />
          <span className="panel-title" id={`attachments-${pageId}`}>
            Attachments{items.length > 0 ? ` (${items.length})` : ''}
          </span>
        </div>
        {canWrite ? (
          <label className="ghost-button logo-upload">
            {busy ? 'Uploading…' : 'Attach a file'}
            <input
              type="file"
              hidden
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void add(file);
                event.target.value = '';
              }}
            />
          </label>
        ) : null}
      </header>

      {error ? <p className="field-error">{error}</p> : null}

      {items.length === 0 ? (
        <p className="field-hint">
          Nothing attached yet. Anything added here travels with the page.
        </p>
      ) : (
        <ul className="attachment-list">
          {items.map((item) => (
            <li key={item.id} className="attachment-row">
              <button
                type="button"
                className="link-button attachment-name"
                onClick={() => setPreviewing({
                  fileId: item.file_id,
                  name: item.name,
                  mimeType: item.mime_type,
                  sizeBytes: item.size_bytes,
                })}
              >
                {item.name}
              </button>
              <span className="field-hint">
                {formatBytes(item.size_bytes)}
                {item.uploaded_by_name ? ` · ${item.uploaded_by_name}` : ''}
                {' · '}<time dateTime={item.created_at}>{relativeTime(item.created_at)}</time>
              </span>
              <span className="table-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Download ${item.name}`}
                  onClick={async () => {
                    const link = await api.get<{ url: string }>(`/files/${item.file_id}/download`);
                    void saveDownload(link.url, item.name);
                  }}
                >
                  <Download size={14} aria-hidden="true" />
                </button>
                {canWrite ? (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => void remove(item)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {previewing ? (
        <FilePreview target={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
      {confirmElement}
    </section>
  );
}
