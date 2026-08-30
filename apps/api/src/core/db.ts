/**
 * MySQL access. All state changes run inside a transaction together with their audit
 * and outbox rows (blueprint 06/07) so a commit can never leave the trail behind.
 *
 * Queries are written with PostgreSQL-style `$1` placeholders and translated here to
 * the `?` form mysql2 expects. Keeping one placeholder style across the codebase means
 * a repeated parameter (`$1` used twice) stays a single logical argument, which is both
 * easier to read and harder to get wrong than hand-maintaining positional duplicates.
 */
import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Rewrites `$n` placeholders to `?` and expands the argument list to match.
 *
 * `$1` appearing twice becomes two `?` bound to the same value. Occurrences inside
 * string literals are left alone so a literal like '$1.00' is not corrupted.
 */
export function translate(sql: string, values: unknown[]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    // Skip over single-quoted literals verbatim.
    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }

    if (ch === '$' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j]!)) j += 1;
      const index = Number(sql.slice(i + 1, j));
      params.push(values[index - 1] ?? null);
      out += '?';
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { text: out, params };
}

const url = new URL(config.db.url);

const mysqlPool: Pool = mysql.createPool({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  connectionLimit: config.db.poolMax,
  waitForConnections: true,
  // Keeps DATETIME values as JS Dates in UTC rather than driver-local strings.
  timezone: 'Z',
  dateStrings: false,
  // The application stores JSON columns as strings it parses itself, so that a value
  // round-trips identically regardless of driver version.
  supportBigNumbers: true,
  bigNumberStrings: false,
  ssl: config.db.ssl ? {} : undefined,
  charset: 'utf8mb4',
});

/**
 * Pins every connection's session time zone to UTC.
 *
 * The driver writes JS Dates as UTC, but MySQL's NOW() answers in the server's local
 * zone. Left alone, the two disagree by the server's offset, and every `expires_at >
 * NOW(3)` comparison silently drifts - sessions ending early or late, invitations
 * expiring at the wrong moment, rate-limit windows the wrong length. Setting it per
 * connection keeps the application correct regardless of how the host is configured.
 */
mysqlPool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

export type QueryResult<T> = { rows: T[]; rowCount: number };

export type Queryable = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
};

/**
 * The pool exposed to the application presents `{ rows, rowCount }` rather than mysql2's
 * `[rows, fields]` tuple. Keeping one result shape means domain code reads the same way
 * whichever connection it is handed, and a query can move between pool and transaction
 * without being rewritten.
 */
export const pool: Queryable & {
  getConnection: Pool['getConnection'];
  end: Pool['end'];
} = {
  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
    const { text: sql, params } = translate(text, values);
    const [raw] = await mysqlPool.query<RowDataPacket[]>(sql, params);
    return toResult<T>(raw);
  },
  getConnection: () => mysqlPool.getConnection(),
  end: () => mysqlPool.end(),
};

function toResult<T>(raw: unknown): QueryResult<T> {
  if (Array.isArray(raw)) {
    return { rows: raw as T[], rowCount: (raw as T[]).length };
  }
  const header = raw as ResultSetHeader;
  return { rows: [], rowCount: header?.affectedRows ?? 0 };
}

export async function query<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function one<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T | undefined> {
  const result = await query<T>(text, values);
  return result.rows[0];
}

export async function many<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await query<T>(text, values);
  return result.rows;
}

function wrap(connection: PoolConnection): Queryable {
  return {
    async query<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
      const { text: sql, params } = translate(text, values);
      const [raw] = await connection.query<RowDataPacket[]>(sql, params);
      return toResult<T>(raw);
    },
  };
}

/**
 * Runs `fn` in a single transaction. The connection is always released, and a failed
 * rollback is logged rather than masking the original error.
 */
export async function transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const connection = await mysqlPool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(wrap(connection));
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Runs `fn` in a transaction permitted to delete append-only rows (audit events and
 * approval decisions).
 *
 * Reserved for governed lifecycle work - removing a tenant, or enforcing an approved
 * retention schedule. The flag is a session variable set on this connection only, and
 * cleared afterwards, so ordinary application code can never delete history by accident.
 */
export async function purgeTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const connection = await mysqlPool.getConnection();
  try {
    await connection.query("SET @infinity_purge = 'on'");
    await connection.beginTransaction();
    const result = await fn(wrap(connection));
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    await connection.query('SET @infinity_purge = NULL').catch(() => undefined);
    connection.release();
  }
}

export async function closePool(): Promise<void> {
  await mysqlPool.end();
}

/** MySQL error codes we translate into user-facing responses. */
export const PG = {
  UNIQUE_VIOLATION: 'ER_DUP_ENTRY',
  FOREIGN_KEY_VIOLATION: 'ER_NO_REFERENCED_ROW_2',
  CHECK_VIOLATION: 'ER_CHECK_CONSTRAINT_VIOLATED',
  EXCLUSION_VIOLATION: 'ER_DUP_ENTRY',
} as const;

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

/**
 * Identifiers are generated by the application rather than the database.
 *
 * MySQL has no RETURNING clause, so a server-generated key would force an extra
 * round trip just to learn what was inserted. Generating it here means the caller
 * already holds the id before the INSERT runs.
 */
export function newId(): string {
  return randomUUID();
}

/**
 * Reads a row back by primary key after a write, standing in for RETURNING.
 *
 * `table` is always a literal from this codebase, never user input, so interpolating
 * it carries no injection risk; the value is still parameterised.
 */
export async function reload<T = Record<string, unknown>>(
  db: Queryable,
  table: string,
  id: string,
): Promise<T | undefined> {
  const res = await db.query<T>(`SELECT * FROM \`${table}\` WHERE id = $1`, [id]);
  return res.rows[0];
}

/**
 * Parses a JSON column. mysql2 may hand back either a parsed value or a string
 * depending on column type and driver version, so both are accepted.
 */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/** Reads a column that holds a JSON array of strings. */
export function jsonArray(value: unknown): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/**
 * Portable "does this JSON array share any element with these ids".
 *
 * `JSON_OVERLAPS` says this in one call, but it arrived in MySQL 8.0.17 and MariaDB 10.9,
 * so depending on it pins a deployment to recent versions of both - and the failure is a
 * runtime error in whichever screen uses it, not something the migration catches.
 * `JSON_CONTAINS` exists in every version, so the question is asked once per id instead.
 *
 * The lists here are a person's group memberships: a handful of entries, not a scan, so
 * the expansion costs nothing worth measuring.
 *
 * Returns `FALSE` when the caller belongs to no groups. That is the correct answer, and
 * it keeps the surrounding statement valid rather than emitting an empty `()`.
 */
export function jsonArrayOverlaps(column: string, ids: string[], firstIndex: number): string {
  if (ids.length === 0) return 'FALSE';
  const tests = ids.map((_, offset) => `JSON_CONTAINS(${column}, JSON_QUOTE($${firstIndex + offset}))`);
  return `(${tests.join(' OR ')})`;
}
