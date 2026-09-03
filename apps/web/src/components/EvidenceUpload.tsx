/**
 * Attaching files to something somebody else has to judge.
 *
 * The same control on a leave request, an approval request and a clock-out, because it is
 * the same act: making a case with more than an assertion. It uploads through the normal
 * file path and hands back ids — the caller submits them with the form, so nothing is
 * attached to a submission that was never made.
 */
import { useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { ApiError } from '../lib/api';
import { uploadWorkspaceFile } from '../lib/uploads';

export type AttachedFile = { id: string; name: string };

export function EvidenceUpload({
  files,
  onChange,
  label = 'Evidence',
  hint,
  max = 10,
}: {
  files: AttachedFile[];
  onChange: (files: AttachedFile[]) => void;
  label?: string;
  hint?: string;
  max?: number;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(chosen: FileList) {
    setError(null);
    const room = max - files.length;
    if (room <= 0) {
      setError(`You can attach at most ${max} files`);
      return;
    }
    setUploading(true);
    try {
      const added: AttachedFile[] = [];
      for (const file of Array.from(chosen).slice(0, room)) {
        const uploaded = await uploadWorkspaceFile<{ id: string }>(file);
        added.push({ id: uploaded.id, name: file.name });
      }
      onChange([...files, ...added]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="field">
      <span className="label-row">{label}</span>
      {hint ? <span className="field-hint">{hint}</span> : null}

      {files.length > 0 ? (
        <ul className="evidence-chips">
          {files.map((file) => (
            <li key={file.id}>
              <Paperclip size={12} aria-hidden="true" />
              {file.name}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${file.name}`}
                onClick={() => onChange(files.filter((f) => f.id !== file.id))}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="ghost-button logo-upload">
        {uploading ? 'Uploading…' : files.length > 0 ? 'Add another' : 'Attach a file'}
        <input
          type="file"
          hidden
          multiple
          disabled={uploading || files.length >= max}
          onChange={(event) => {
            if (event.target.files?.length) void add(event.target.files);
            event.target.value = '';
          }}
        />
      </label>

      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

/** The read side: what was attached, openable by whoever is judging it. */
export function EvidenceList({
  items,
  onOpen,
  emptyText = 'Nothing was attached.',
}: {
  items: { id: string; file_id: string; name: string; mime_type: string | null; size_bytes: number }[];
  onOpen: (file: { fileId: string; name: string; mimeType: string | null; sizeBytes: number }) => void;
  emptyText?: string;
}) {
  if (items.length === 0) return <p className="field-hint">{emptyText}</p>;
  return (
    <ul className="attachment-list">
      {items.map((file) => (
        <li key={file.id} className="attachment-row">
          <button
            type="button"
            className="link-button attachment-name"
            onClick={() => onOpen({
              fileId: file.file_id, name: file.name,
              mimeType: file.mime_type, sizeBytes: file.size_bytes,
            })}
          >
            {file.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
