/**
 * Break-glass account recovery.
 *
 * The workspace is this company's only system. There is no identity provider behind it
 * and no second console to sign in from, so if every administrator loses their password
 * there is nothing else that can let them back in - re-running the seed will not, since
 * it deliberately leaves an existing administrator's credentials untouched.
 *
 * This is that last resort. It requires shell access to the server and the database
 * credentials, which is the point: the barrier is infrastructure access rather than
 * anything the application itself can be talked out of.
 *
 * Every use is recorded in break_glass_events and the audit trail, and every session and
 * token belonging to the account is revoked, so an operator cannot quietly borrow an
 * account and hand it back. Recovery is meant to be survivable, not invisible.
 *
 *   npm run recover -- --email admin@example.com --reason "locked out after laptop loss"
 *   npm run recover -- --email new.admin@example.com --promote --reason "sole admin left"
 */
import { randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { closePool, newId, one, pool, transaction } from '../core/db.js';
import { hashPassword } from '../core/crypto.js';
import { logger } from '../core/logger.js';

type Args = { email?: string; reason?: string; promote: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { promote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--promote') args.promote = true;
    else if (flag === '--email') args.email = argv[++i];
    else if (flag === '--reason') args.reason = argv[++i];
  }
  return args;
}

/**
 * A generated passphrase rather than an operator-chosen one. Whoever runs this is under
 * pressure and would otherwise pick something memorable, and this credential is the only
 * thing standing in front of the whole company until it is changed.
 */
function generatePassphrase(): string {
  return `${randomBytes(18).toString('base64url')}-Iw1!`;
}

export async function recover(args: Args): Promise<{ email: string; password: string }> {
  if (!args.email) throw new Error('--email is required');
  if (!args.reason || args.reason.trim().length < 8) {
    throw new Error('--reason is required and must say something useful (8 characters or more)');
  }

  const email = args.email.toLowerCase().trim();
  const user = await one<{
    id: string;
    company_id: string;
    email: string;
    display_name: string;
    access_level: string;
    status: string;
  }>('SELECT id, company_id, email, display_name, access_level, status FROM users WHERE email = $1', [
    email,
  ]);
  if (!user) throw new Error(`No account exists for ${email}`);
  if (user.status === 'offboarded') {
    throw new Error(
      `${email} has been offboarded. Recovering it would resurrect a departed employee's ` +
        'access; create a new account instead.',
    );
  }

  const password = generatePassphrase();
  const passwordHash = await hashPassword(password);
  const operator = `${userInfo().username}@${hostname()}`;

  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO identities (user_id, password_hash, password_set_at)
       VALUES ($1, $2, NOW(3))
       ON DUPLICATE KEY UPDATE
         password_hash = VALUES(password_hash),
         password_set_at = NOW(3),
         failed_attempts = 0,
         locked_until = NULL,
         updated_at = NOW(3)`,
      [user.id, passwordHash],
    );

    // A locked-out account is frequently also a suspended one, and an administrator who
    // cannot reach the product cannot lift that either.
    await tx.query(
      `UPDATE users
          SET status = 'active', suspended_at = NULL, activated_at = COALESCE(activated_at, NOW(3)),
              ${args.promote ? "access_level = 'super_admin'," : ''}
              version = version + 1, updated_at = NOW(3)
        WHERE id = $1`,
      [user.id],
    );

    // Anything issued before the account was recovered is treated as untrusted: nobody
    // knows why it was locked out.
    await tx.query('UPDATE sessions SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    await tx.query('UPDATE api_tokens SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    await tx.query(
      `UPDATE password_resets SET invalidated_at = NOW(3)
        WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [user.id],
    );

    await tx.query(
      `INSERT INTO break_glass_events (id, company_id, user_id, reason, operator)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId(), user.company_id, user.id, args.reason!.trim(), operator],
    );
    // Written directly rather than through recordAudit: this runs with no actor and no
    // request, and the audit trail should still show it above everything else.
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_email, action, resource_type, resource_id, metadata)
       VALUES ($1,$2,$3,'auth.break_glass','user',$4,$5)`,
      [
        user.company_id,
        user.id,
        user.email,
        user.id,
        JSON.stringify({ operator, reason: args.reason!.trim(), promoted: args.promote }),
      ],
    );
  });

  return { email: user.email, password };
}

if (process.argv[1] && process.argv[1].includes('recover')) {
  recover(parseArgs(process.argv.slice(2)))
    .then((result) => {
      // Printed to stdout on purpose, and nowhere else. It is not logged, not mailed and
      // not stored: the only copy is on the operator's terminal.
      process.stdout.write(
        [
          '',
          '  Account recovered.',
          '',
          `    email:    ${result.email}`,
          `    password: ${result.password}`,
          '',
          '  Every session and token for this account has been revoked.',
          '  Sign in and change this password now - it is recorded as a break-glass event',
          '  and will show up in the audit trail.',
          '',
        ].join('\n'),
      );
      return closePool();
    })
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'recovery failed');
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}

export { pool };
