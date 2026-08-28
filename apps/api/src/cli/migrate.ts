/**
 * Migration runner (MySQL).
 *
 * Migrations are applied in filename order, recorded with their checksum, and guarded
 * by a named lock so two instances starting together cannot both apply the same file.
 * A changed checksum on an applied migration is an error: editing in place would
 * silently diverge environments.
 *
 * MySQL has no transactional DDL, so a migration that fails part-way leaves the
 * statements before it applied. Each file is therefore written to be independently
 * safe to inspect, and the failure names the exact statement that stopped.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool, query } from '../core/db.js';
import { logger } from '../core/logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const LOCK_NAME = 'infinity_migrations';

/**
 * Splits a migration file into individual statements.
 *
 * MySQL sends one statement per round trip, but a trigger body legitimately contains
 * semicolons. Rather than relying on the client-side DELIMITER convention, this tracks
 * block depth so a `;` inside BEGIN/IF/CASE does not end the statement. String
 * literals, quoted identifiers and comments are skipped so their contents cannot be
 * mistaken for keywords.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;

  const rest = () => sql.slice(i);
  /** Matches a keyword only at a word boundary, so `ENDING` is not `END`. */
  const keyword = (word: string): boolean => {
    const candidate = sql.slice(i, i + word.length);
    if (candidate.toUpperCase() !== word) return false;
    const before = i === 0 ? ' ' : sql[i - 1]!;
    const after = sql[i + word.length] ?? ' ';
    return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
  };

  while (i < sql.length) {
    const ch = sql[i]!;

    // ---- comments
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // ---- quoted spans
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && quote !== '`') {
          j += 2;
          continue;
        }
        if (sql[j] === quote && sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // ---- block structure
    // `END IF` / `END CASE` close a block that its opener already counted, so they are
    // consumed as one token to avoid double-counting the bare END.
    if (/^END\s+(IF|CASE|WHILE|LOOP|REPEAT)\b/i.test(rest())) {
      const match = /^END\s+(IF|CASE|WHILE|LOOP|REPEAT)/i.exec(rest())!;
      depth = Math.max(0, depth - 1);
      current += match[0];
      i += match[0].length;
      continue;
    }
    if (keyword('BEGIN') || keyword('CASE')) {
      depth += 1;
      current += sql.slice(i, i + 5);
      i += 5;
      continue;
    }
    // A bare `IF` opens a procedural block, but two other `IF`s open nothing: `IF(` is
    // the scalar function, and `IF [NOT] EXISTS` is a DDL clause. Counting the latter
    // left the depth permanently above zero, so no statement ever terminated and the
    // whole file was sent to the server as one - which is how the first migration to
    // say `CREATE TABLE IF NOT EXISTS` failed on its opening comment.
    if (
      keyword('IF') &&
      !/^IF\s*\(/i.test(rest()) &&
      !/^IF\s+(NOT\s+)?EXISTS\b/i.test(rest())
    ) {
      depth += 1;
      current += 'IF';
      i += 2;
      continue;
    }
    if (keyword('END')) {
      depth = Math.max(0, depth - 1);
      current += 'END';
      i += 3;
      continue;
    }

    if (ch === ';' && depth === 0) {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  // A file may end with only comments; those carry no statement to run.
  return statements.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

export async function migrate(): Promise<{ applied: string[] }> {
  const connection = await pool.getConnection();
  const applied: string[] = [];
  try {
    const [lockRows] = await connection.query<{ locked: number }[] & never>(
      'SELECT GET_LOCK(?, 30) AS locked',
      [LOCK_NAME],
    );
    if ((lockRows as unknown as { locked: number }[])[0]?.locked !== 1) {
      throw new Error('Could not acquire the migration lock; another instance may be migrating');
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(200) NOT NULL PRIMARY KEY,
        checksum   VARCHAR(64)  NOT NULL,
        applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const [existingRows] = await connection.query('SELECT name, checksum FROM schema_migrations');
    const byName = new Map(
      (existingRows as { name: string; checksum: string }[]).map((r) => [r.name, r.checksum]),
    );

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = byName.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied. ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      logger.info({ migration: file }, 'applying migration');
      const statements = splitStatements(sql);
      for (const [index, statement] of statements.entries()) {
        try {
          await connection.query(statement);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Migration ${file} failed at statement ${index + 1}/${statements.length}: ${detail}\n` +
              `--- statement ---\n${statement.slice(0, 400)}`,
          );
        }
      }
      await connection.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
        [file, checksum],
      );
      applied.push(file);
    }
    return { applied };
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => undefined);
    connection.release();
  }
}

// Run directly: `npm run migrate`
if (process.argv[1] && process.argv[1].includes('migrate')) {
  migrate()
    .then((result) => {
      if (result.applied.length === 0) logger.info('database is already up to date');
      else logger.info({ applied: result.applied }, 'migrations applied');
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err }, 'migration failed');
      process.exit(1);
    });
}

export { query };
