/**
 * A displayable URL for the company logo.
 *
 * The profile carries a file id; an <img> needs a URL, and download URLs are short-lived
 * and signed, so they are fetched at display time rather than stored anywhere. Shared by
 * the invoice, quotation and receipt previews so all three match the PDF.
 */
import { useEffect, useState } from 'react';
import { api } from './api';

export function useLogoUrl(fileId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!fileId) { setUrl(null); return; }
    let cancelled = false;
    void api.get<{ url: string }>(`/files/${fileId}/download`)
      .then((link) => { if (!cancelled) setUrl(link.url); })
      // A missing logo is not an error worth showing: the document falls back to the
      // legal name in type, exactly as the PDF does.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [fileId]);

  return url;
}
