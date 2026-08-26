# Security model

Maps the blueprint's section 12 controls to where each one is actually enforced.

## Authentication

| Control | Implementation |
|---|---|
| Password hashing | scrypt (memory-hard, RFC 7914), per-password random salt, parameters stored with the hash. Verification is constant-time and never throws on malformed input. Weak stored parameters are transparently upgraded on next sign-in. |
| Password policy | Minimum 12 characters, must not contain the local part of the address, rejects single repeated characters, optional k-anonymity breached-password check (only a 5-character SHA-1 prefix ever leaves the process, and a lookup failure never blocks the user). |
| MFA | TOTP (RFC 6238), ±1 step drift tolerance. Secrets encrypted at rest with AES-256-GCM. Ten single-use recovery codes, stored only as hashes. |
| No plaintext passwords | Accounts are created *invited*; the person sets their own password through a single-use, expiring invitation. No password is ever generated, emailed or displayed. |
| Account enumeration | Wrong password, unknown address and inactive company all return an identical 401. Password verification runs even for unknown accounts to keep timing comparable. |
| Lockout | Configurable failed-attempt threshold, then a timed lock. The correct password is still refused while the lock stands. |

## Sessions

- Opaque 256-bit tokens; only a SHA-256 digest is stored.
- HttpOnly, Secure, SameSite=Lax cookies. Script can never read the session.
- Both absolute and idle expiry.
- Double-submit CSRF on every cookie-authenticated state change.
- Suspension, role change or password change revokes every session **and** closes live
  WebSocket connections immediately — verified by test, not assumed.
- Users can list and revoke their own sessions.

## Authorization

Deny by default, checked on every endpoint and every realtime subscription. See
[architecture.md](architecture.md#authorization) for the evaluation order.

Threats from the blueprint that are explicitly tested:

- **Cross-tenant access** — a valid identifier from another company reads as `404`, never
  as data, and never appears in a listing.
- **Broken object-level authorization** — resource checks are per-record, not per-route.
- **Role escalation** — access level cannot be changed through the self-service profile
  endpoint; only a super administrator can grant administrator roles, and never to
  themselves.
- **Stale permission caches** — a role change invalidates the capability cache and revokes
  sessions rather than waiting for a TTL.
- **Hidden frontend routes called directly** — route guards are cosmetic; the API refuses
  regardless of what the client renders.
- **Session fixation and invitation reuse** — invitations are single-use, enforced by a
  conditional `UPDATE` so two concurrent activations cannot both succeed.

## Content handling

| Threat | Control |
|---|---|
| Stored XSS in HTML email | Server-side allow-list sanitizer. The tokenizer is quote-aware, so markup smuggled inside an attribute value cannot desynchronize the parse and escape as live tags (the mutation-XSS bypass class). Event handlers, `style`, `srcset`, `javascript:` and `data:` URLs are all dropped. Unclosed tags are balanced so a fragment cannot escape its container. |
| Tracking pixels | Remote images are neutralised to `data-blocked-src`; the reader opts in per message. |
| Header injection | Newlines in any address or subject are rejected as a field-level validation error, and re-checked in the adapter before anything reaches the wire. |
| Content-type confusion | Uploaded bytes are MIME-sniffed; the declared type is never trusted. Downloads are always served `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`. |
| Malware | Files stay `processing` until scanned and become `quarantined` on a bad verdict. A scanner outage records `skipped` rather than silently passing the file. |
| Dangerous attachments | Executable types are blocked on send and quarantined on receipt. |
| Path traversal | Object keys are generated server-side; user filenames are sanitized and never form the storage path. |

## Transport and data

- TLS terminates at the edge; HSTS is set in production.
- MFA secrets are encrypted at rest with AES-256-GCM keyed from `DATA_ENCRYPTION_KEY`.
- Object storage is private. Access is only ever via short-lived signed URLs; there are no
  permanent public object links.
- Secrets come from the environment. `.env` files are gitignored and CI fails if one is
  committed or if a private key or cloud credential pattern appears in history.

## Abuse protection

- Per-account and per-IP rate limits on sign-in, so neither a single-account attack nor
  credential stuffing across many accounts is cheap.
- Per-endpoint limits on activation, MFA verification, general API traffic and outbound
  mail volume — the last one bounds the damage from a compromised account.
- Idempotency keys on retry-sensitive commands (account creation, sending mail, scheduling,
  approval decisions) so a timeout retry cannot double-apply.
- Provider webhooks require a valid HMAC signature and fall inside a replay window.

## Audit and privacy

- Append-only, database-enforced. `UPDATE` is impossible; `DELETE` requires an explicit,
  transaction-local opt-in used only by tenant removal and approved retention.
- Reading the audit trail is itself audited, and exporting requires step-up MFA.
- Recorded state is redacted before it is written: passwords, tokens, secrets, recovery
  codes and message bodies are replaced with `[redacted]`, and long values truncated.
- Logs are structured JSON with the same redaction applied at the logger, so a careless
  call site cannot leak a credential.
- Audit entries carry a correlation ID that is also returned to the client in the error
  envelope, so a user can quote a reference without exposing internal detail.

## Known gaps before launch

These need your infrastructure and are documented rather than hidden:

1. **Penetration test** — the blueprint requires one before launch with remediation
   verified. Automated tests cover the threat list; they do not replace a human assessment.
2. **Key management** — `DATA_ENCRYPTION_KEY` is read from the environment. Move it to a
   managed KMS with a rotation schedule before production.
3. **Provider hardening** — SPF, DKIM and DMARC alignment must be verified against your
   real domain, and outbound bounce and complaint handling monitored.
