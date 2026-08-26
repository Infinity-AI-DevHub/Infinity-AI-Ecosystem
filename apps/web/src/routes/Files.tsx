/**
 * Files module (blueprint 11).
 *
 * Uploads go through the two-step session flow so the server records intent, enforces
 * quota and scans the content before the file becomes usable. Downloads are always
 * short-lived signed URLs requested at click time - never long-lived links in markup.
 */
import { useRef, useState } from 'react';
import { Download, FolderPlus, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { api, API_URL, ApiError, NetworkError } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty } from '../components/States';
import { formatBytes, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type FileRecord = {
  id: string;
  folderId: string | null;
  name: string;
  ownerName: string | null;
  classification: string;
  state: string;
  currentVersion: number;
  sizeBytes: number;
  mimeType: string;
  updatedAt: string;
};

type Folder = { id: string; parent_id: string | null; name: string; path: string };

export default function Files() {
  const { can } = useSession();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const folders = useQuery<{ items: Folder[] }>('/files/folders', (signal) =>
    api.get('/files/folders', signal),
  );

  const listKey = `/files?limit=100${folderId ? `&folderId=${folderId}` : ''}`;
  const files = useQuery<{ items: FileRecord[] }>(listKey, (signal) => api.get(listKey, signal));

  /**
   * Two-step upload: reserve a session (authorization, quota, object key), then send the
   * bytes for scanning and storage.
   */
  const upload = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      const session = await api.post<{ uploadId: string }>('/files/uploads', {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        folderId,
      });

      const form = new FormData();
      form.append('file', file, file.name);

      const csrf = document.cookie.match(/(?:^|; )iw_csrf=([^;]*)/)?.[1];
      const response = await fetch(
        `${API_URL}/api/v1/files/uploads/${session.uploadId}/content`,
        {
          method: 'POST',
          credentials: 'include',
          headers: csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {},
          body: form,
        },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        // A quarantine verdict is a normal outcome to explain, not a crash.
        throw new Error(payload?.error?.message ?? 'The upload could not be completed');
      }
      invalidate('/files');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'The upload could not be completed');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const download = useMutation(async (fileId: string) => {
    const result = await api.get<{ url: string; filename: string }>(`/files/${fileId}/download`);
    // The signed URL is used immediately and never stored.
    window.location.assign(result.url);
    return result;
  });

  const recycle = useMutation(async (fileId: string) => api.delete(`/files/${fileId}`), {
    invalidates: ['/files'],
  });

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Files</h2>
          <p>Company documents with versions, scanning and a recycle bin.</p>
        </div>
        <div className="header-controls">
          {can('file.create') ? (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setCreatingFolder(true)}
              >
                <FolderPlus size={15} aria-hidden="true" /> New folder
              </button>
              <label className="primary-button file-upload-label">
                <Upload size={15} aria-hidden="true" />
                {uploading ? 'Uploading…' : 'Upload file'}
                <input
                  ref={inputRef}
                  type="file"
                  className="visually-hidden"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
              </label>
            </>
          ) : null}
        </div>
      </header>

      {uploadError ? (
        <div className="auth-error" role="alert">
          <p>{uploadError}</p>
        </div>
      ) : null}

      <div className="split-layout">
        <nav className="panel" aria-label="Folders">
          <h3 className="panel-title">Folders</h3>
          <ul className="folder-tree">
            <li>
              <button
                type="button"
                className={`folder-button ${folderId === null ? 'folder-active' : ''}`}
                onClick={() => setFolderId(null)}
              >
                All files
              </button>
            </li>
            {(folders.data?.items ?? []).map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className={`folder-button ${folderId === folder.id ? 'folder-active' : ''}`}
                  onClick={() => setFolderId(folder.id)}
                >
                  {folder.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="panel" aria-label="Files">
          <AsyncSection query={files}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty
                  title="No files here"
                  description="Upload a document to get started."
                />
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <caption className="visually-hidden">Files in this folder</caption>
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Owner</th>
                        <th scope="col">Size</th>
                        <th scope="col">State</th>
                        <th scope="col">Updated</th>
                        <th scope="col"><span className="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((file) => (
                        <tr key={file.id}>
                          <th scope="row">
                            {file.name}
                            {file.classification === 'restricted' ? (
                              <span className="thread-flag thread-flag-warn">Restricted</span>
                            ) : null}
                          </th>
                          <td>{file.ownerName ?? '—'}</td>
                          <td>{formatBytes(file.sizeBytes)}</td>
                          <td>
                            {file.state === 'quarantined' ? (
                              <span className="thread-flag thread-flag-error">
                                <ShieldAlert size={12} aria-hidden="true" /> Quarantined
                              </span>
                            ) : file.state === 'processing' ? (
                              <span className="thread-flag">Processing</span>
                            ) : (
                              titleCase(file.state)
                            )}
                          </td>
                          <td>
                            <time dateTime={file.updatedAt}>{relativeTime(file.updatedAt)}</time>
                          </td>
                          <td className="table-actions">
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Download ${file.name}`}
                              disabled={file.state !== 'active' || download.pending}
                              onClick={() => void download.mutate(file.id)}
                            >
                              <Download size={15} />
                            </button>
                            {can('file.delete') ? (
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Move ${file.name} to the recycle bin`}
                                onClick={() => void recycle.mutate(file.id)}
                              >
                                <Trash2 size={15} />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </AsyncSection>

          {download.error ? (
            <p className="field-error" role="alert">{describeError(download.error)}</p>
          ) : null}
          {recycle.error ? (
            <p className="field-error" role="alert">{describeError(recycle.error)}</p>
          ) : null}
        </section>
      </div>

      {creatingFolder ? (
        <NewFolderDialog
          parentId={folderId}
          onClose={() => setCreatingFolder(false)}
          onCreated={() => {
            setCreatingFolder(false);
            invalidate('/files/folders');
          }}
        />
      ) : null}
    </div>
  );
}

function describeError(error: ApiError | NetworkError): string {
  if (error instanceof ApiError && error.isForbidden) {
    return 'You do not have permission to do that.';
  }
  return error.message;
}

function NewFolderDialog({
  parentId,
  onClose,
  onCreated,
}: {
  parentId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const create = useMutation(
    async () => api.post('/files/folders', { name, parentId }),
    { invalidates: ['/files'], onSuccess: onCreated },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="folder-title">New folder</h3>
        {create.error ? (
          <div className="auth-error" role="alert"><p>{create.error.message}</p></div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="folder-name">Folder name</label>
            <input
              id="folder-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
