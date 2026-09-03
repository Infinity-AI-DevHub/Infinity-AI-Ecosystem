/**
 * Signing, for any document that needs it.
 *
 * Quotations, invoices and receipts differ in what they say and how many signatures they
 * need; the act of signing is identical in all three. Keeping it in one place means the
 * rules — two different people internally, the client's signature recorded rather than
 * placed, the hash written at the moment of signing — cannot drift apart between them.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { uploadWorkspaceFile } from '../lib/uploads';
import { SignaturePlacer, type Placement } from './SignaturePlacer';
import { SignatureSettings } from './SignatureSettings';

export type DocumentType = 'quotation' | 'invoice' | 'receipt';

export type SignatureState = {
  documentHash: string;
  required: string[];
  complete: boolean;
  intact: boolean;
  signatures: {
    id: string;
    role: string;
    signer_user_id: string | null;
    signer_name: string;
    signed_at: string;
    image_file_id: string | null;
    pos_x: string | null;
    pos_y: string | null;
    width: string | null;
    valid: boolean;
    imageUrl?: string | null;
  }[];
};

/**
 * Signature images, resolved to short-lived URLs.
 *
 * The API returns file ids, not links — a long-lived URL to a signature image sitting in
 * markup would be a signature anyone could lift. They are exchanged for signed URLs at
 * render time and never stored.
 */
export function useSignatureImages(state: SignatureState | undefined): SignatureState | undefined {
  const [resolved, setResolved] = useState<SignatureState | undefined>(state);

  useEffect(() => {
    let cancelled = false;
    if (!state) {
      setResolved(undefined);
      return;
    }
    void (async () => {
      const withUrls = await Promise.all(
        state.signatures.map(async (signature) => {
          if (!signature.image_file_id) return signature;
          try {
            const link = await api.get<{ url: string }>(`/files/${signature.image_file_id}/download`);
            return { ...signature, imageUrl: link.url };
          } catch {
            // A missing image is cosmetic: the signature record is what counts, and the
            // document still shows who signed and when.
            return signature;
          }
        }),
      );
      if (!cancelled) setResolved({ ...state, signatures: withUrls });
    })();
    return () => { cancelled = true; };
    // Keyed on the ids so a refetch returning the same rows does not refetch every image.
  }, [state?.signatures.map((s) => s.id).join(','), state?.documentHash]);

  return resolved;
}

/** Which internal slot this person would fill, or null if there is none for them. */
export function nextInternalRole(
  state: SignatureState | undefined,
  userId: string | undefined,
): 'internal_1' | 'internal_2' | null {
  if (!state || !userId) return null;
  if (state.signatures.some((s) => s.signer_user_id === userId)) return null;
  const taken = new Set(state.signatures.map((s) => s.role));
  if (!taken.has('internal_1')) return 'internal_1';
  if (!taken.has('internal_2')) return 'internal_2';
  return null;
}

export function SignDocumentDialog({
  documentType,
  documentId,
  documentLabel,
  role,
  children,
  onClose,
  onSigned,
}: {
  documentType: DocumentType;
  documentId: string;
  documentLabel: string;
  role: 'internal_1' | 'internal_2';
  /** The document to place the signature onto. */
  children: React.ReactNode;
  onClose: () => void;
  onSigned: () => void;
}) {
  const [placement, setPlacement] = useState<Placement>({
    page: 1,
    // The second signatory defaults beside the first rather than on top of it.
    posX: role === 'internal_1' ? 0.08 : 0.38,
    posY: 0.82,
    width: 0.2,
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [hasSignature, setHasSignature] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSignature = useCallback(async () => {
    try {
      const saved = await api.get<{ file_id: string | null }>('/me/signature');
      setHasSignature(Boolean(saved.file_id));
      if (saved.file_id) {
        const link = await api.get<{ url: string }>(`/files/${saved.file_id}/download`);
        setImageUrl(link.url);
      }
    } catch {
      setHasSignature(false);
    }
  }, []);

  useEffect(() => { void loadSignature(); }, [loadSignature]);

  async function commit() {
    setError(null);
    setSaving(true);
    try {
      await api.post(`/signatures/${documentType}/${documentId}/sign`, { role, ...placement });
      onSigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That signature could not be recorded');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-label={`Sign ${documentLabel}`}
           onClick={(event) => event.stopPropagation()}>
        <h3>Sign {documentLabel}</h3>

        {hasSignature === false ? (
          <>
            <p className="field-hint">
              Before you can sign, the app needs the signature it should place on the
              document. Upload it here once — it is saved to your account and reused
              every time after this.
            </p>
            <SignatureSettings onSaved={() => { void loadSignature(); }} />
            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : imageUrl ? (
          <>
            <SignaturePlacer imageUrl={imageUrl} value={placement} onChange={setPlacement}
                             label="Your signature">
              {children}
            </SignaturePlacer>

            <p className="field-hint">
              Signing records your account, the time, and a fingerprint of this document
              exactly as it reads now. If it changes afterwards, the signature is reported
              as no longer covering it.
            </p>

            {error ? <p className="field-error">{error}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary-button" disabled={saving} onClick={commit}>
                {saving ? 'Signing…' : `Sign ${documentLabel}`}
              </button>
            </div>
          </>
        ) : (
          <p className="field-hint">Loading your signature…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Recording a signature made on paper.
 *
 * A receipt needs two from the client, so the slot is chosen rather than assumed.
 */
export function RecordClientSignatureDialog({
  documentType,
  documentId,
  role,
  onClose,
  onRecorded,
}: {
  documentType: DocumentType;
  documentId: string;
  role: 'client_1' | 'client_2';
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setError(null);
    setSaving(true);
    try {
      const uploaded = await uploadWorkspaceFile<{ id: string }>(file);
      await api.post(`/signatures/${documentType}/${documentId}/client`, {
        role,
        signerName,
        signerEmail: signerEmail || null,
        fileId: uploaded.id,
      });
      onRecorded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="Upload the signed copy"
            onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h3>Upload the signed copy</h3>
        <p className="field-hint">
          They sign on paper and send it back. This records their signature and keeps the
          copy they returned. Who signed and who uploaded it are both kept — they are not
          the same person.
        </p>

        <label className="field">
          <span>Who signed it</span>
          <input value={signerName} onChange={(e) => setSignerName(e.target.value)}
                 required maxLength={200} placeholder="Name and role" />
        </label>
        <label className="field">
          <span>Their email <span className="field-hint">optional</span></span>
          <input type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>The signed document</span>
          <input type="file" accept="application/pdf,image/*" required
                 onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button"
                  disabled={saving || !file || !signerName.trim()}>
            {saving ? 'Uploading…' : 'Record their signature'}
          </button>
        </div>
      </form>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  internal_1: 'For us',
  internal_2: 'For us',
  client_1: 'For the client',
  client_2: 'For the client',
};

/** The signature blocks printed on a document. Shared by all three document types. */
export function SignatureBlocks({
  required,
  signatures,
}: {
  required: string[];
  signatures: SignatureState['signatures'];
}) {
  return (
    <section className="doc-signatures">
      {required.map((role) => {
        const signature = signatures.find((s) => s.role === role);
        const sameSideCount = required.filter((r) => ROLE_LABEL[r] === ROLE_LABEL[role]).length;
        return (
          <div className="doc-sig-slot" key={role}>
            {signature?.imageUrl ? (
              <img src={signature.imageUrl} alt={`Signature of ${signature.signer_name}`} />
            ) : (
              <span className="doc-sig-blank" aria-hidden="true" />
            )}
            <span className="doc-sig-rule" />
            <span className="doc-sig-role">
              {ROLE_LABEL[role] ?? role}
              {sameSideCount > 1 ? (role.endsWith('_2') ? ' (second)' : ' (first)') : ''}
            </span>
            {signature ? (
              <>
                <span className="doc-sig-name">{signature.signer_name}</span>
                <span className="doc-sig-date">
                  {String(signature.signed_at).slice(0, 10)}
                  {/* Stated on the paper, not only in the app: whoever reads the
                      printed copy should see it too. */}
                  {!signature.valid ? ' · document changed after signing' : ''}
                </span>
              </>
            ) : (
              <span className="doc-sig-date">Not yet signed</span>
            )}
          </div>
        );
      })}
    </section>
  );
}


/**
 * Asking a colleague to countersign.
 *
 * The note matters more than it looks: "please check the staging terms" is the
 * difference between a colleague signing carefully and signing because they were asked
 * to. It goes into both the in-app notification and the email.
 */
export function RequestCountersignatureDialog({
  documentType,
  documentId,
  documentLabel,
  onClose,
  onRequested,
}: {
  documentType: DocumentType;
  documentId: string;
  documentLabel: string;
  onClose: () => void;
  onRequested: () => void;
}) {
  const [signerUserId, setSignerUserId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [people, setPeople] = useState<{ id: string; display_name: string }[]>([]);

  useEffect(() => {
    void api.get<{ items: { id: string; display_name: string }[] }>('/users?limit=100')
      .then((result) => setPeople(result.items))
      .catch(() => undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(`/signatures/${documentType}/${documentId}/request`, {
        signerUserId,
        note: note || null,
      });
      onRequested();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That request could not be sent');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label="Request a countersignature"
            onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h3>Ask someone to countersign</h3>
        <p className="field-hint">
          {documentLabel} needs a second signature. They are notified in the app and by
          email, with a link straight to it.
        </p>

        <label className="field">
          <span>Who should sign it</span>
          <select value={signerUserId} onChange={(e) => setSignerUserId(e.target.value)} required>
            <option value="">Choose a colleague…</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.display_name}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Anything they should check <span className="field-hint">optional</span></span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Please check the staging terms before signing." />
        </label>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || !signerUserId}>
            {saving ? 'Sending…' : 'Send the request'}
          </button>
        </div>
      </form>
    </div>
  );
}
