/**
 * Opening the server-rendered PDF of a document.
 *
 * The server renders it, not the browser: that is the same file the client received by
 * email, signatures and all. Printing the page instead would produce a second rendering
 * that can drift from what was actually sent — and would not contain the signatures at
 * all, since those are drawn onto the PDF.
 */
import { API_URL, uploadAuth } from './api';
import { desktop, saveDownload } from './desktop';

export async function openDocumentPdf(
  kind: 'invoice' | 'quotation' | 'receipt',
  documentId: string,
): Promise<void> {
  const url = `${API_URL}/api/v1/documents/${kind}/${documentId}/pdf`;
  const auth = await uploadAuth();
  const response = await fetch(url, auth);
  if (!response.ok) throw new Error('That document could not be produced');

  const blob = await response.blob();
  const name = `${kind}-${documentId.slice(0, 8)}.pdf`;

  if (desktop) {
    // A blob URL in Electron opens in a window with no chrome and no way to save it;
    // the native dialog is what people expect from an application.
    await saveDownload(url, name);
    return;
  }

  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, '_blank', 'noopener');
  // Revoked on a delay: revoking immediately races the new tab reading it.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
