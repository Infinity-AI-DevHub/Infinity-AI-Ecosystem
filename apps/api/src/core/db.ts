/**
 * PostgreSQL access. All state changes run inside a transaction together with their
 * audit and outbox rows (blueprint 06/07) so a commit can never leave the trail behind.
 */
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

// Return bigint columns as JS numbers where the range is safe; ids stay strings.
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});
// numeric -> number (amounts are money with 2dp, safely within float range here)
pg.types.setTypeParser(1700, (v: string) => Number(v));

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
  statement_timeout: config.db.statementTimeoutMs,
  application_name: 'infinity-api',
});

pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

export type Queryable = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
};

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T | undefined> {
  const res = await pool.query<T>(text, values);
  return res.rows[0];
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, values);
  return res.rows;
}

/**
 * Runs `fn` in a single transaction. Nested calls reuse the outer transaction so a
 * service method can be composed without opening a second connection.
 */
export async function transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/** Postgres error codes we translate into user-facing responses. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
} as const;

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
