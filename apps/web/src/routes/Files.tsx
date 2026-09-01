/**
 * Files module (blueprint 11).
 *
 * Uploads go through the two-step session flow so the server records intent, enforces
 * quota and scans the content before the file becomes usable. Downloads are always
 * short-lived signed URLs requested at click time - never long-lived links in markup.
 */
import { useMemo, useRef, useState } from 'react';
import { Download, FolderPlus, History, Link2, RotateCcw, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { api, ApiError, idempotencyKey, NetworkError } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { saveDownload } from '../lib/desktop';
import { AsyncSection, Empty, FormError } from '../components/States';
import { formatBytes, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import { uploadWorkspaceFile } from '../lib/uploads';

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
  const [versionsFor, setVersionsFor] = useState<FileRecord | null>(null);
  const [sharingFile, setSharingFile] = useState<FileRecord | null>(null);
  const [showRecycled, setShowRecycled] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const folders = useQuery<{ items: Folder[] }>('/files/folders', (signal) =>
    api.get('/files/folders', signal),
  );

  const listKey = `/files?limit=100${folderId ? `&folderId=${folderId}` : ''}${
    showRecycled ? '&recycled=true' : ''
  }`;
  const files = useQuery<{ items: FileRecord[] }>(listKey, (signal) => api.get(listKey, signal));

  /**
   * Two-step upload: reserve a session (authorization, quota, object key), then send the
   * bytes for scanning and storage.
   */
  const upload = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      await uploadWorkspaceFile(file, { folderId });
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
    /**
     * The signed URL is used immediately and never stored. On the desktop this opens the
     * OS save dialog rather than navigating - navigating would be caught by the window's
     * own guard and handed to the system browser, so the file would arrive in Safari
     * instead of where the person asked for it.
     */
    await saveDownload(result.url, result.filename);
    return result;
  });

  const recycle = useMutation(async (fileId: string) => api.delete(`/files/${fileId}`), {
    invalidates: ['/files'],
  });

  const restore = useMutation(async (fileId: string) => api.post(`/files/${fileId}/restore`), {
    invalidates: ['/files'],
  });

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Files</h2>
          <p>
            {showRecycled
              ? 'Deleted files, recoverable until their retention window ends.'
              : 'Company documents with versions, scanning and a recycle bin.'}
          </p>
        </div>
        <div className="header-controls">
          <button
            type="button"
            className={`ghost-button ${showRecycled ? 'toggle-active' : ''}`}
            aria-pressed={showRecycled}
            onClick={() => setShowRecycled((open) => !open)}
          >
            <RotateCcw size={15} aria-hidden="true" /> Recycle bin
          </button>
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
                  title={showRecycled ? 'The recycle bin is empty' : 'No files here'}
                  description={
                    showRecycled
                      ? 'Deleted files appear here until their retention window ends.'
                      : 'Upload a document to get started.'
                  }
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
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Version history for ${file.name}`}
                              onClick={() => setVersionsFor(file)}
                            >
                              <History size={15} />
                            </button>
                            {can('file.share_external') ? (
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Share ${file.name} outside the company`}
                                disabled={file.state !== 'active'}
                                onClick={() => setSharingFile(file)}
                              >
                                <Link2 size={15} />
                              </button>
                            ) : null}
                            {file.state === 'recycled' && can('file.restore') ? (
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Restore ${file.name}`}
                                onClick={() => void restore.mutate(file.id)}
                              >
                                <RotateCcw size={15} />
                              </button>
                            ) : can('file.delete') ? (
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

      {sharingFile ? (

        <ShareDialog file={sharingFile} onClose={() => setSharingFile(null)} />

      ) : null}


      {versionsFor ? (
        <VersionHistoryDialog file={versionsFor} onClose={() => setVersionsFor(null)} />
      ) : null}

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

/**
 * Every stored version, with its checksum and scan verdict. Downloading an older
 * version issues its own short-lived signed URL rather than reusing the current one.
 */
function VersionHistoryDialog({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const versions = useQuery<{
    items: {
      version: number;
      size_bytes: number;
      checksum: string;
      mime_type: string;
      scan_state: string;
      created_at: string;
      uploaded_by_name: string | null;
    }[];
  }>(`/files/${file.id}/versions`, (signal) => api.get(`/files/${file.id}/versions`, signal));

  const download = useMutation(async (version: number) => {
    const result = await api.get<{ url: string }>(`/files/${file.id}/download?version=${version}`);
    window.location.assign(result.url);
    return result;
  });

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="versions-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="versions-title">Version history — {file.name}</h3>

        <AsyncSection query={versions}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty title="No versions recorded" />
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="visually-hidden">Stored versions of {file.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Version</th>
                      <th scope="col">Uploaded by</th>
                      <th scope="col">Size</th>
                      <th scope="col">Scan</th>
                      <th scope="col">When</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((version) => (
                      <tr key={version.version}>
                        <th scope="row">
                          v{version.version}
                          {version.version === file.currentVersion ? (
                            <span className="status-tag">Current</span>
                          ) : null}
                        </th>
                        <td>{version.uploaded_by_name ?? '—'}</td>
                        <td>{formatBytes(Number(version.size_bytes))}</td>
                        <td>
                          {version.scan_state === 'infected' ? (
                            <span className="thread-flag thread-flag-error">Quarantined</span>
                          ) : version.scan_state === 'skipped' ? (
                            <span className="thread-flag thread-flag-warn">Not scanned</span>
                          ) : (
                            titleCase(version.scan_state)
                          )}
                        </td>
                        <td>
                          <time dateTime={version.created_at}>{relativeTime(version.created_at)}</time>
                        </td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Download version ${version.version}`}
                            disabled={version.scan_state === 'infected' || download.pending}
                            onClick={() => void download.mutate(version.version)}
                          >
                            <Download size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </AsyncSection>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </div>
      </div>
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
        <FormError error={create.error} />
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

/**
 * Creating an external share link.
 *
 * The defaults are the conservative ones - two weeks, download allowed, no password -
 * because a link is a credential in a URL and whoever holds it holds the access. The
 * copy says that plainly rather than leaving someone to infer it.
 */
function ShareDialog({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [password, setPassword] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const key = useMemo(() => idempotencyKey(), []);

  const create = useMutation(
    async () =>
      api.post<{ url: string }>(
        '/share-links',
        {
          resourceType: 'file',
          resourceId: file.id,
          expiresInDays,
          password: password || null,
          recipientEmail: recipientEmail || null,
          maxUses: maxUses ? Number(maxUses) : null,
        },
        { idempotencyKey: key },
      ),
    { onSuccess: (result) => setUrl(result.url) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="share-title">Share {file.name} outside the company</h3>

        {url ? (
          <>
            <p className="field-hint">
              Anyone with this link can open the file until it expires. Send it the way you
              would send the file itself.
            </p>
            <code className="invitation-link">{url}</code>
            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={() => navigator.clipboard?.writeText(url)}>
                Copy link
              </button>
              <button type="button" className="primary-button" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <p className="field-hint">
              This creates a link that works without an account. Anyone who has it has the
              access, so keep it short-lived and add a password for anything sensitive.
            </p>
            <FormError error={create.error} />
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create.mutate();
              }}
            >
              <div className="field-row">
                <div className="field">
                  <label htmlFor="share-days">Expires after</label>
                  <select
                    id="share-days"
                    value={expiresInDays}
                    onChange={(event) => setExpiresInDays(Number(event.target.value))}
                  >
                    {[1, 7, 14, 30, 90].map((days) => (
                      <option key={days} value={days}>{days} day{days === 1 ? '' : 's'}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="share-uses">Limit opens</label>
                  <input
                    id="share-uses"
                    type="number"
                    min={1}
                    value={maxUses}
                    placeholder="Unlimited"
                    onChange={(event) => setMaxUses(event.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="share-password-set">Password (optional)</label>
                <input
                  id="share-password-set"
                  type="text"
                  value={password}
                  minLength={6}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 6 characters"
                />
                <p className="field-hint">Send this separately from the link, not alongside it.</p>
              </div>
              <div className="field">
                <label htmlFor="share-recipient">Who is it for? (optional)</label>
                <input
                  id="share-recipient"
                  type="email"
                  value={recipientEmail}
                  onChange={(event) => setRecipientEmail(event.target.value)}
                />
                <p className="field-hint">Recorded with the link so you know who it was meant for.</p>
              </div>
              <div className="dialog-actions">
                <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
                <button type="submit" className="primary-button" disabled={create.pending}>
                  {create.pending ? 'Creating…' : 'Create link'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
