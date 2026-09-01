import { api, ApiError, NetworkError } from './api';

type UploadSession = { uploadId: string; uploadUrl: string };

export type UploadOptions = {
  folderId?: string | null;
  fileId?: string;
};

const completionDelays = [0, 350, 1_000];

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function completeUpload<T>(uploadId: string): Promise<T> {
  let lastError: unknown;
  for (const delay of completionDelays) {
    if (delay > 0) await wait(delay);
    try {
      return await api.post<T>(`/files/uploads/${uploadId}/complete`, {});
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof NetworkError ||
        (error instanceof ApiError && (error.status === 409 || error.status >= 500));
      if (!retryable) throw error;
    }
  }
  throw lastError;
}

async function uploadResponseError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null);
  const serverMessage = payload?.error?.message;
  if (serverMessage) return new Error(serverMessage);
  if (response.status === 408 || response.status === 504) {
    return new Error('The upload timed out before storage confirmed it. Check your connection and try again.');
  }
  if (response.status === 413) return new Error('This file is larger than the workspace upload limit.');
  if (response.status >= 500) {
    return new Error('Storage is temporarily unavailable. Your file was not duplicated; please try again.');
  }
  return new Error('Storage rejected the upload. Choose the file again and retry.');
}

/** Uploads bytes directly to private storage, then asks the API to verify and scan them. */
export async function uploadWorkspaceFile<T>(file: File, options: UploadOptions = {}): Promise<T> {
  const session = await api.post<UploadSession>('/files/uploads', {
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    folderId: options.folderId ?? null,
    fileId: options.fileId,
  });

  let stored: Response;
  try {
    stored = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new Error('The connection was interrupted during upload. Check your connection and try again.');
  }
  if (!stored.ok) throw await uploadResponseError(stored);

  return completeUpload<T>(session.uploadId);
}
