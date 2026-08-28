/**
 * Rate limiting (blueprint 12: abuse protection). Counters live in Postgres so limits
 * hold across API instances without requiring Redis for a small deployment; the same
 * interface can be backed by Redis when throughput demands it.
 */
import { pool } from './db.js';
import { rateLimited } from './errors.js';

export type LimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export async function consume(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<LimitResult> {
  // The window is a fixed counter reset: the first request in a new window sets the
  // expiry, and subsequent ones increment until it lapses. `limit` is applied in JS,
  // so it is deliberately not a query parameter.
  //
  // MySQL has no UPDATE ... RETURNING, so the upsert and the read are two statements.
  // They race only with another request on the same bucket, and the worst outcome is
  // reading a count one higher than this request caused - which fails closed.
  await pool.query(
    `INSERT INTO rate_counters (bucket, count, expires_at)
          VALUES ($1, 1, DATE_ADD(NOW(3), INTERVAL $2 SECOND))
     ON DUPLICATE KEY UPDATE
        count = CASE WHEN rate_counters.expires_at < NOW(3) THEN 1 ELSE rate_counters.count + 1 END,
        expires_at = CASE WHEN rate_counters.expires_at < NOW(3)
                          THEN DATE_ADD(NOW(3), INTERVAL $2 SECOND)
                          ELSE rate_counters.expires_at END`,
    [bucket, windowSeconds],
  );
  const res = await pool.query<{ count: number; expires_at: Date }>(
    'SELECT count, expires_at FROM rate_counters WHERE bucket = $1',
    [bucket],
  );
  const row = res.rows[0] ?? { count: 1, expires_at: new Date(Date.now() + windowSeconds * 1000) };
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000),
  );
  return {
    allowed: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    retryAfterSeconds,
  };
}

export async function enforce(bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const result = await consume(bucket, limit, windowSeconds);
  if (!result.allowed) throw rateLimited(result.retryAfterSeconds);
}

/** Housekeeping for expired counters; called by the maintenance worker. */
export async function purgeExpired(): Promise<number> {
  const res = await pool.query(
    'DELETE FROM rate_counters WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 1 HOUR)',
  );
  return res.rowCount ?? 0;
}
