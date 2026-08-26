/**
 * Migration runner.
 *
 * Migrations are applied in filename order inside a transaction, recorded with their
 * checksum, and guarded by an advisory lock so two instances starting together cannot
 * both apply the same file. A changed checksum on an applied migration is an error:
 * edit-in-place would silently diverge environments.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from '../core/db.js';
import { logger } from '../core/logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const LOCK_KEY = 811_000;

export async function migrate(): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const existing = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const byName = new Map(existing.rows.map((r) => [r.name, r.checksum]));

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
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
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
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
