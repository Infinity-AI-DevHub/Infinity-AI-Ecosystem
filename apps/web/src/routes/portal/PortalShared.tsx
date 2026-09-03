/**
 * The documents, files and work shared with this client.
 *
 * These read the ordinary `/files`, `/files/folders` and `/tasks` endpoints, which are
 * grant-scoped: a guest sees exactly what was deliberately shared with them. Pages come
 * from the portal's own listing, because documentation had no grant-scoped index at all.
 *
 * Files are grouped under the folder they came in, because that is how they were shared —
 * a client given "Designs" expects to see a folder called Designs, not its contents
 * spilled into one flat list beside everything else.
 */
import { useState } from 'react';
import { BookText, FileText, FolderOpen } from 'lucide-react';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { AsyncSection, Empty } from '../../components/States';
import { formatDate } from '../../lib/format';
import { FilePreview, type PreviewTarget } from '../../components/FilePreview';

/** The files API returns camelCase; the portal reads exactly what it sends. */
type SharedFile = {
  id: string; name: string; mimeType: string | null; sizeBytes: number;
  updatedAt: string; folderId: string | null;
};

type Folder = { id: string; parent_id: string | null; name: string; path: string };
type Page = { id: string; title: string; updated_at: string };

export function PortalDocuments() {
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null);
  const files = useQuery<{ items: SharedFile[] }>('/files', (signal) => api.get('/files', signal));
  const folders = useQuery<{ items: Folder[] }>('/files/folders', (signal) =>
    api.get('/files/folders', signal),
  );
  const pages = useQuery<{ items: Page[] }>('/portal/pages', (signal) =>
    api.get('/portal/pages', signal),
  );

  return (
    <>
      <header className="portal-head">
        <h1>Documents</h1>
        <p>Everything the team has shared with you.</p>
      </header>

      <AsyncSection query={files}>
        {(fileData) => {
          const folderList = folders.data?.items ?? [];
          const byFolder = new Map<string | null, SharedFile[]>();
          for (const file of fileData.items) {
            const key = file.folderId ?? null;
            byFolder.set(key, [...(byFolder.get(key) ?? []), file]);
          }
          // Only folders that actually contain something reachable: an empty folder in a
          // client's portal is a question they have to ask us about.
          const shown = folderList.filter((folder) => (byFolder.get(folder.id) ?? []).length > 0);
          const loose = byFolder.get(null) ?? [];

          if (fileData.items.length === 0 && (pages.data?.items.length ?? 0) === 0) {
            return (
              <Empty
                title="Nothing shared yet"
                description="When someone shares a file or document with you, it appears here."
              />
            );
          }

          return (
            <>
              {shown.map((folder) => (
                <section key={folder.id} className="portal-folder">
                  <h2>
                    <FolderOpen size={15} aria-hidden="true" />
                    {folder.name}
                  </h2>
                  <FileList
                    files={byFolder.get(folder.id) ?? []}
                    onOpen={setPreviewing}
                  />
                </section>
              ))}

              {loose.length > 0 ? (
                <section className="portal-folder">
                  <h2><FileText size={15} aria-hidden="true" /> Shared with you</h2>
                  <FileList files={loose} onOpen={setPreviewing} />
                </section>
              ) : null}

              {(pages.data?.items.length ?? 0) > 0 ? (
                <section className="portal-folder">
                  <h2><BookText size={15} aria-hidden="true" /> Pages</h2>
                  <ul className="portal-file-list">
                    {pages.data!.items.map((page) => (
                      <li key={page.id}>
                        <span className="portal-file portal-file-static">
                          <BookText size={16} aria-hidden="true" />
                          <span>
                            <strong>{page.title}</strong>
                            <span className="field-hint">
                              Updated {formatDate(page.updated_at)}
                            </span>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          );
        }}
      </AsyncSection>

      {previewing ? (
        <FilePreview target={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
    </>
  );
}

function FileList({
  files, onOpen,
}: { files: SharedFile[]; onOpen: (target: PreviewTarget) => void }) {
  return (
    <ul className="portal-file-list">
      {files.map((file) => (
        <li key={file.id}>
          <button
            type="button"
            className="portal-file"
            onClick={() => onOpen({
              fileId: file.id, name: file.name,
              mimeType: file.mimeType, sizeBytes: file.sizeBytes,
            })}
          >
            <FileText size={16} aria-hidden="true" />
            <span>
              <strong>{file.name}</strong>
              <span className="field-hint">Updated {formatDate(file.updatedAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
