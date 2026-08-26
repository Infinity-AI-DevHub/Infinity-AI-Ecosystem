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
  const res = await pool.query<{ count: number; expires_at: Date }>(
    `INSERT INTO rate_counters (bucket, count, expires_at)
          VALUES ($1, 1, now() + ($2 || ' seconds')::interval)
     ON CONFLICT (bucket) DO UPDATE
        SET count = CASE WHEN rate_counters.expires_at < now() THEN 1 ELSE rate_counters.count + 1 END,
            expires_at = CASE WHEN rate_counters.expires_at < now()
                              THEN now() + ($2 || ' seconds')::interval
                              ELSE rate_counters.expires_at END
      RETURNING count, expires_at`,
    [bucket, windowSeconds],
  );
  const row = res.rows[0]!;
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
  const res = await pool.query('DELETE FROM rate_counters WHERE expires_at < now() - interval \'1 hour\'');
  return res.rowCount ?? 0;
}
