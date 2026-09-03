/**
 * The documents, files and work shared with this client.
 *
 * These read the ordinary `/files`, `/docs` and `/tasks` endpoints, which are already
 * grant-scoped: a guest sees exactly what was deliberately shared with them and the
 * listing returns nothing otherwise. So there is no portal-specific query here — the
 * sharing model is the query.
 */
import { useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { AsyncSection, Empty } from '../../components/States';
import { formatDate } from '../../lib/format';
import { FilePreview, type PreviewTarget } from '../../components/FilePreview';

/** The files API returns camelCase; the portal reads exactly what it sends. */
type SharedFile = {
  id: string; name: string; mimeType: string | null; sizeBytes: number; updatedAt: string;
};

export function PortalDocuments() {
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null);
  const files = useQuery<{ items: SharedFile[] }>('/files', (signal) => api.get('/files', signal));

  return (
    <>
      <header className="portal-head">
        <h1>Documents</h1>
        <p>Everything the team has shared with you.</p>
      </header>

      <AsyncSection query={files}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty
              title="Nothing shared yet"
              description="When someone shares a file or document with you, it appears here."
            />
          ) : (
            <ul className="portal-file-list">
              {data.items.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className="portal-file"
                    onClick={() => setPreviewing({
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
          )
        }
      </AsyncSection>

      {previewing ? (
        <FilePreview target={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
    </>
  );
}

type SharedTask = {
  id: string; title: string; status: string; due_date: string | null; description: string | null;
};

export function PortalTasks() {
  const tasks = useQuery<{ items: SharedTask[] }>('/tasks', (signal) => api.get('/tasks', signal));

  return (
    <>
      <header className="portal-head">
        <h1>Work</h1>
        <p>The work we are doing for you that has been shared with you.</p>
      </header>

      <AsyncSection query={tasks}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty
              title="Nothing shared yet"
              description="Tasks appear here when the team shares them with you."
            />
          ) : (
            <ul className="portal-task-list">
              {data.items.map((task) => (
                <li key={task.id}>
                  <span className="portal-task-head">
                    <strong>{task.title}</strong>
                    <span className="status-tag">{task.status}</span>
                  </span>
                  {task.description ? (
                    <span className="field-hint">{task.description}</span>
                  ) : null}
                  {task.due_date ? (
                    <span className="field-hint">Due {formatDate(task.due_date)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </AsyncSection>
    </>
  );
}
