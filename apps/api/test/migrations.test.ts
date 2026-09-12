/**
 * Migrations must not pin a character set or collation.
 *
 * A CHAR foreign key requires both sides to have the *same* collation. Every table in
 * this schema inherits the database's default, so a migration that writes its own is
 * only correct where that default happens to match — it applied on a development
 * machine whose default was the same string, and failed on the server with
 * "Foreign key constraint is incorrectly formed", which names neither collation nor
 * the column involved.
 *
 * Inheriting is also the only thing that keeps working if the database is ever restored
 * onto a server with different defaults.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'migrations');
const files = readdirSync(dir).filter((name) => name.endsWith('.sql'));

describe('migrations', () => {
  it('finds the migrations, so this test cannot pass by looking at nothing', () => {
    assert.ok(files.length > 20, `expected the migration set, found ${files.length}`);
  });

  it('never pins a character set or collation on a table', () => {
    const offenders: string[] = [];
    for (const name of files) {
      const sql = readFileSync(join(dir, name), 'utf8');
      // Comments explain the rule; only real statements are the problem.
      const statements = sql.replace(/^\s*--.*$/gm, '');
      if (/DEFAULT\s+CHARSET\s*=/i.test(statements) || /\bCOLLATE\s*=/i.test(statements)) {
        offenders.push(name);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'these migrations pin a charset or collation instead of inheriting the database default:\n'
        + offenders.join('\n'),
    );
  });

  it('gives every foreign key a column type that can match its target', () => {
    // Every id in this schema is CHAR(36). A VARCHAR(36) column referencing one is the
    // other half of errno 150, and just as invisible until deploy.
    const offenders: string[] = [];
    for (const name of files) {
      const sql = readFileSync(join(dir, name), 'utf8').replace(/^\s*--.*$/gm, '');
      for (const match of sql.matchAll(/FOREIGN KEY \((\w+)\)/g)) {
        const column = match[1]!;
        const declared = new RegExp(`\\b${column}\\s+(CHAR\\(36\\)|VARCHAR\\(\\d+\\))`, 'i').exec(sql);
        if (declared && /VARCHAR/i.test(declared[1]!)) offenders.push(`${name}: ${column}`);
      }
    }
    assert.deepEqual(offenders, [], `foreign key columns declared as VARCHAR:\n${offenders.join('\n')}`);
  });
});
