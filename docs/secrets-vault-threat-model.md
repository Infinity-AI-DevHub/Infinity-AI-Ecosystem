# Secrets vault — threat model and go/no-go (draft for security review)

Status: **not built.** Phase 5 delivers access governance and the Academy; a secrets vault is a
separate milestone that starts only when this document has been reviewed and the open decisions
at the end are made. Nothing in the codebase stores third-party credentials for people to retrieve.

## 1. What is being asked for

A place where teams keep shared credentials (service accounts, API keys, database passwords,
recovery codes) with per-item access control, an audit trail of every reveal, rotation reminders,
and removal of access when someone leaves — instead of chat messages, spreadsheets and documents.

## 2. Why this is different from everything else in Workspace

Every other record Workspace keeps is *about* something. A secret *is* the thing: one leaked row is
a working key to a production system. The platform's existing controls (RBAC, tenant scoping,
audit, field encryption with `core/crypto.ts`) are designed so that a bug exposes information;
here the same bug exposes access. The bar is therefore "a full compromise of the Workspace API
server or database does not reveal secret values", which the current field encryption does not
meet — the server holds the key.

## 3. Assets

| Asset | Impact if disclosed |
| --- | --- |
| Secret values | Direct access to external systems; potentially customer data |
| Secret metadata (names, systems, who can read) | Targeting information for an attacker |
| Encryption keys / key-encryption keys | All secret values |
| Reveal audit trail | Hides misuse if tampered with |
| Membership of vault groups | Grants future access |

## 4. Actors

- Employees with legitimate access to specific items.
- Employees without access (curious or malicious insiders).
- Administrators of Workspace (who today can change roles and read the database).
- Departed employees whose sessions or devices persist.
- An external attacker with: a stolen session; a stolen laptop running the desktop app; code
  execution on the API host; a database backup; a compromised dependency (supply chain).
- The hosting provider.

## 5. Entry points

Web and desktop UI (reveal, copy, share); API routes; the Electron preload bridge and clipboard;
database and backups; logs and error reporting; search index; notifications and emails; outbox
events; browser/renderer memory; the audit log export.

## 6. Threats (STRIDE) and required mitigations

| # | Threat | Mitigation required before launch |
| --- | --- | --- |
| S1 | Stolen session reveals secrets | Step-up re-authentication (password + second factor) within the last few minutes for every reveal; reveal tokens bound to session and expiring in seconds |
| S2 | Admin grants themselves access silently | Vault membership changes need a second approver (approvals engine) and notify every existing member; admins are not implicit members |
| T1 | Audit trail altered to hide a reveal | Append-only reveal log with hash chaining; periodic export to storage the API cannot delete |
| R1 | "I never looked at it" | Every reveal and copy is attributable (user, device, IP, reason field for high-risk items) |
| I1 | Database or backup theft | Envelope encryption: per-item data keys wrapped by a key-encryption key held in an external KMS (AWS KMS / GCP KMS / Vault Transit), never in the database or app config |
| I2 | API host compromise reads values in memory | Decrypt only on explicit reveal, never for list/search; zero values in logs; consider client-side decryption so the server never holds plaintext (see decision D1) |
| I3 | Values leak through search, notifications, emails, outbox, error reports | Values never enter `search_documents`, notifications, outbox payloads or logs; a test asserts this for every route |
| I4 | Clipboard and screen leakage on desktop | Auto-clear clipboard after 30 s; hide values by default; exclude vault windows from screenshots where the OS allows |
| I5 | Cross-tenant read | Company-scoped keys (a data key wrapped per company) so a tenant bug cannot decrypt another company's items |
| D1 | Brute-force of reveal endpoint | Per-user and per-item rate limits; alert on unusual reveal volume |
| E1 | Departed employee keeps secrets they saw | Offboarding lists every item the person revealed in the last N days as "rotate now" tasks (extends the Phase 5 offboarding workflow) |
| E2 | Compromised dependency exfiltrates in renderer | Strict CSP, no remote code, reveal rendered in an isolated view; dependency review for the vault bundle |

## 7. Design options

1. **Integrate, don't store (recommended first step).** Workspace keeps the *catalogue and
   governance* of secrets — which system, who owns it, who should have access, when it was last
   rotated — and links out to an existing vault (1Password Business, Bitwarden, HashiCorp Vault,
   AWS Secrets Manager). Access requests and reviews from Phase 5 already cover the "who should
   have access" half. No secret value ever touches Workspace.
2. **Server-side envelope encryption with external KMS.** Values stored encrypted; the API decrypts
   on step-up-authenticated reveal. Protects against database/backup theft; does not protect
   against API host compromise.
3. **End-to-end encrypted vault.** Keys derived on the client; the server stores ciphertext only.
   Strongest, but requires key recovery design, device enrolment, and sharing via public-key
   wrapping — a substantial cryptography project needing external review.

## 8. Open decisions (needed before any build)

- **D1** Option 1, 2 or 3. Recommendation: ship option 1 now; revisit 2/3 only if integration is
  rejected.
- **D2** Which external vault or KMS the company already pays for or will adopt.
- **D3** Whether a second factor is mandatory for all vault users (it should be; Workspace does not
  enforce MFA today).
- **D4** Retention of the reveal log and who may export it.
- **D5** External penetration test before production use (required for options 2 and 3).

## 9. What already exists that a vault would reuse

Access catalogue, requests via the approvals engine, temporary grants, owner-confirmed provisioning
and removal, periodic access reviews and offboarding tasks (Phase 5); audit log; outbox;
notifications; tenant scoping; rate limiting.
