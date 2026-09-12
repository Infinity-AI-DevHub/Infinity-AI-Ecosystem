-- Asking a colleague to countersign, and being told when they have.
--
-- A request was a notification and nothing more: no record that it had been made, so
-- nothing could list what was waiting on you, and nothing knew who to tell once the
-- document was signed. The person who asked found out by going back to look.
--
-- Recording the request makes both halves possible — the banner that says "Kasun asked
-- you to sign INV-2026-0014", and the message back to Kasun when you do.
CREATE TABLE signature_requests (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,

  document_type VARCHAR(24)  NOT NULL,
  document_id   CHAR(36)     NOT NULL,
  -- Kept as text: it is what the notification and the email say, and re-deriving it
  -- later would mean loading a document that may since have been voided.
  document_label VARCHAR(200) NOT NULL,

  requested_by  CHAR(36)     NOT NULL,
  signer_id     CHAR(36)     NOT NULL,
  note          TEXT         NULL,

  -- pending -> signed, or cancelled if the document is withdrawn or the ask is dropped.
  state         VARCHAR(12)  NOT NULL DEFAULT 'pending',
  signed_at     DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_sigreq_company FOREIGN KEY (company_id)   REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_sigreq_asker   FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sigreq_signer  FOREIGN KEY (signer_id)    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_sigreq_state  CHECK (state IN ('pending','signed','cancelled')),

  -- One live ask per person per document. Asking twice should not produce two banners,
  -- and the second ask is the same request repeated, not a new one.
  UNIQUE KEY uq_sigreq_live (document_type, document_id, signer_id)
) ENGINE=InnoDB;

-- "What is waiting for me to sign" is the query the banner runs on every page load.
CREATE INDEX idx_sigreq_signer ON signature_requests (company_id, signer_id, state);
