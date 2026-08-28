/**
 * Idempotency-Key handling (blueprint 08). Retry-sensitive commands - invitations,
 * sending mail, creating meetings, approval decisions - must not double-apply when a
 * client retries after a timeout.
 */
import { pool } from './db.js';
import { conflict } from './errors.js';
import { sha256 } from './crypto.js';

export type StoredResponse = { statusCode: number; body: unknown };

export function fingerprint(body: unknown): string {
  return sha256(JSON.stringify(body ?? null));
}

/**
 * Returns the previously stored response when this exact key + request was already
 * processed. A key reused with a *different* body is a client bug and is rejected.
 */
export async function lookup(
  key: string,
  companyId: string,
  userId: string,
  endpoint: string,
  requestFingerprint: string,
): Promise<StoredResponse | null> {
  const res = await pool.query<{
    request_fingerprint: string;
    status_code: number | null;
    response: unknown;
  }>(
    `SELECT request_fingerprint, status_code, response
       FROM idempotency_keys WHERE \`key\` = $1 AND company_id = $2 AND endpoint = $3`,
    [key, companyId, endpoint],
  );
  const row = res.rows[0];
  if (!row) {
    await pool.query(
      `INSERT IGNORE INTO idempotency_keys
         (\`key\`, company_id, user_id, endpoint, request_fingerprint)
       VALUES ($1,$2,$3,$4,$5)`,
      [key, companyId, userId, endpoint, requestFingerprint],
    );
    return null;
  }
  if (row.request_fingerprint !== requestFingerprint) {
    throw conflict('Idempotency-Key was already used with a different request body');
  }
  if (row.status_code === null) {
    // The original request is still in flight.
    throw conflict('A request with this Idempotency-Key is still being processed');
  }
  return { statusCode: row.status_code, body: row.response };
}

export async function store(
  key: string,
  companyId: string,
  endpoint: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys SET status_code = $4, response = $5
      WHERE \`key\` = $1 AND company_id = $2 AND endpoint = $3`,
    [key, companyId, endpoint, statusCode, JSON.stringify(body ?? null)],
  );
}

/** Abandoned in-flight records are cleared so a retry is not blocked forever. */
export async function releaseStale(key: string, companyId: string, endpoint: string): Promise<void> {
  await pool.query(
    `DELETE FROM idempotency_keys
      WHERE \`key\` = $1 AND company_id = $2 AND endpoint = $3 AND status_code IS NULL`,
    [key, companyId, endpoint],
  );
}
