-- Removes multi-factor authentication and records the company's legal name.
--
-- MFA was withdrawn from the product, so the columns that stored authenticator
-- secrets and recovery codes are dropped rather than left behind holding secrets no
-- code reads. The `sessions.mfa_satisfied` flag goes with it: step-up verification no
-- longer exists, so privileged actions are gated on capability alone. That is a
-- deliberate reduction from blueprint 12 and is recorded in docs/security.md.
--
-- Dropping these columns destroys the enrolled secrets. That is the intent: an
-- encrypted secret nothing can verify is a liability, not an asset.

ALTER TABLE identities
  DROP COLUMN mfa_enabled,
  DROP COLUMN mfa_secret_enc,
  DROP COLUMN mfa_confirmed_at,
  DROP COLUMN recovery_codes;

ALTER TABLE sessions DROP COLUMN mfa_satisfied;

-- The registered legal entity, distinct from the display name people see in the
-- interface. Contracts, invoices and audit exports need the former.
ALTER TABLE companies
  ADD COLUMN legal_name VARCHAR(200) NULL AFTER name;
