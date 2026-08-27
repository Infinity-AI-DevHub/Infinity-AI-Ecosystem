/**
 * End-to-end and authorization-matrix tests (blueprint 17: "End-to-end", "Authorization",
 * "API contract"). These run against a real Postgres database and a real HTTP server.
 *
 * They assert the acceptance criteria from blueprint 20: invite -> activate -> login ->
 * MFA -> authorized dashboard, suspension closing access, cross-tenant isolation,
 * separation of duties, concurrency preconditions and idempotency.
 *
 * Skipped automatically when TEST_DATABASE_URL is not set.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const enabled = DATABASE_URL.length > 0;

type Json = Record<string, any>;

/** Minimal cookie-aware client so CSRF and session behaviour are exercised for real. */
class Client {
  private cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(raw: string[] | string | undefined): void {
    if (!raw) return;
    for (const line of Array.isArray(raw) ? raw : [raw]) {
      const [pair] = line.split(';');
      const idx = pair?.indexOf('=') ?? -1;
      if (idx <= 0 || !pair) continue;
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json; headers: Record<string, unknown> }> {
    const merged: Record<string, string> = { ...headers };
    const cookie = this.cookieHeader();
    if (cookie) merged.cookie = cookie;
    if (this.csrfToken && !['GET', 'HEAD'].includes(method)) {
      merged['x-csrf-token'] = this.csrfToken;
    }
    const response = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as never,
      headers: merged,
    });
    this.absorb(response.headers['set-cookie'] as string[] | string | undefined);
    let parsed: Json = {};
    try {
      parsed = response.body ? JSON.parse(response.body) : {};
    } catch {
      parsed = { raw: response.body };
    }
    return { status: response.statusCode, body: parsed, headers: response.headers };
  }

  get = (url: string, headers?: Record<string, string>) => this.request('GET', url, undefined, headers);
  post = (url: string, body?: unknown, headers?: Record<string, string>) =>
    this.request('POST', url, body, headers);
  patch = (url: string, body?: unknown, headers?: Record<string, string>) =>
    this.request('PATCH', url, body, headers);
  put = (url: string, body?: unknown, headers?: Record<string, string>) =>
    this.request('PUT', url, body, headers);
  del = (url: string, headers?: Record<string, string>) => this.request('DELETE', url, undefined, headers);
}

describe('Infinity Workspace end to end', { skip: !enabled && 'TEST_DATABASE_URL not set' }, () => {
  let app: FastifyInstance;
  let db: typeof import('../src/core/db.js');
  let crypto: typeof import('../src/core/crypto.js');
  let companyId: string;
  let adminId: string;
  let admin: Client;
  let adminTotpSecret: string;

  const ADMIN_EMAIL = 'e2e.admin@e2e.test';
  const ADMIN_PASSWORD = 'e2e-Administrator-Passphrase-9';
  const STAFF_PASSWORD = 'e2e-Colleague-Passphrase-77';

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DATA_ENCRYPTION_KEY ??= 'a'.repeat(64);
    process.env.NOTIFY_DRIVER = 'log';
    process.env.NOTIFY_DEFAULT_DOMAIN = 'e2e.test';
    process.env.REQUIRE_MFA_FOR_ADMINS = 'false';
    process.env.RATE_API_PER_MIN = '100000';
    process.env.RATE_LOGIN_PER_MIN = '10000';

    db = await import('../src/core/db.js');
    crypto = await import('../src/core/crypto.js');
    const { migrate } = await import('../src/cli/migrate.js');
    await migrate();

    // Rate-limit counters are global and time-windowed, so a previous run would
    // otherwise leak into this one (activation is deliberately capped per IP).
    // The limits themselves are unchanged; only the accumulated state is reset.
    await db.query('DELETE FROM rate_counters');

    // A dedicated company keeps this suite isolated from seeded data.
    await db.purgeTransaction((tx) =>
      tx.query(
        `DELETE FROM companies WHERE JSON_CONTAINS(verified_domains, JSON_QUOTE('e2e.test'))`,
      ),
    );
    companyId = randomUUID();
    await db.query(
      `INSERT INTO companies (id, name, verified_domains, settings)
       VALUES ($1, 'E2E Corp', JSON_ARRAY('e2e.test'), JSON_OBJECT())`,
      [companyId],
    );

    adminId = randomUUID();
    await db.query(
      `INSERT INTO users
         (id, company_id, email, email_display, display_name, access_level, status, activated_at, modules)
       VALUES ($1,$2,$3,$3,'E2E Administrator','super_admin','active',NOW(3), JSON_ARRAY())`,
      [adminId, companyId, ADMIN_EMAIL],
    );
    // The administrator is enrolled in MFA: privileged operations require a session
    // that actually satisfied a second factor, so the suite must go through it.
    adminTotpSecret = crypto.generateTotpSecret();
    await db.query(
      `INSERT INTO identities
         (user_id, password_hash, password_set_at, mfa_enabled, mfa_secret_enc, mfa_confirmed_at, recovery_codes)
       VALUES ($1,$2,NOW(3),1,$3,NOW(3), JSON_ARRAY())`,
      [adminId, await crypto.hashPassword(ADMIN_PASSWORD), crypto.encryptField(adminTotpSecret)],
    );
    await db.query(
      `INSERT INTO approval_definitions (id, company_id, \`key\`, name, form_schema, routing)
       VALUES ($1,$2,'expense','Expense claim', JSON_ARRAY(), $3)`,
      [
        randomUUID(),
        companyId,
        JSON.stringify([{ step: 1, approver: { type: 'manager' }, dueHours: 48 }]),
      ],
    );

    const { buildServer } = await import('../src/http/server.js');
    app = await buildServer();
    await app.ready();

    admin = await signInWithMfa();
  });

  /** Full two-step sign-in, producing a session that satisfied MFA. */
  async function signInWithMfa(): Promise<Client> {
    const client = new Client(app);
    const login = await client.post('/api/v1/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, 'mfa_required');

    const code = crypto.totpCode(adminTotpSecret, Math.floor(Date.now() / 1000 / 30));
    const verified = await client.post('/api/v1/auth/mfa/verify', {
      challengeToken: login.body.challengeToken,
      code,
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.status, 'authenticated');
    client.csrfToken = verified.body.csrfToken;
    return client;
  }

  after(async () => {
    if (app) await app.close();
    if (db) {
      await db
        .purgeTransaction((tx) => tx.query('DELETE FROM companies WHERE id = $1', [companyId]))
        .catch(() => undefined);
      await db.closePool();
    }
  });

  // --------------------------------------------------------------- health

  it('reports liveness and readiness', async () => {
    const client = new Client(app);
    assert.equal((await client.get('/health')).status, 200);
    const ready = await client.get('/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.checks.database, 'ok');
  });

  // --------------------------------------------------------------- authentication

  it('rejects a wrong password with a neutral message that does not enumerate accounts', async () => {
    const client = new Client(app);
    const wrongPassword = await client.post('/api/v1/auth/login', {
      email: ADMIN_EMAIL,
      password: 'not-the-right-password',
    });
    const unknownAccount = await client.post('/api/v1/auth/login', {
      email: 'nobody@e2e.test',
      password: 'not-the-right-password',
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownAccount.status, 401);
    // Identical responses: an attacker cannot tell which addresses exist.
    assert.equal(wrongPassword.body.error.message, unknownAccount.body.error.message);
  });

  it('refuses unauthenticated access to protected endpoints', async () => {
    const anonymous = new Client(app);
    assert.equal((await anonymous.get('/api/v1/me')).status, 401);
    assert.equal((await anonymous.get('/api/v1/users')).status, 401);
    assert.equal((await anonymous.get('/api/v1/audit/events')).status, 401);
  });

  it('rejects a state-changing request without a CSRF token', async () => {
    const noCsrf = await signInWithMfa();
    // Drop the token so the header is omitted even though the session is valid.
    noCsrf.csrfToken = null;
    const attempt = await noCsrf.post('/api/v1/chat/rooms', { name: 'csrf-probe' });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.error.code, 'forbidden');
  });

  it('refuses a privileged action from a session that has not satisfied MFA', async () => {
    // A password-only session for an account whose role can create users must still be
    // refused: step-up is a property of the session, not of the role.
    const email = `nomfa.${Date.now()}@e2e.test`;
    const noMfaId = randomUUID();
    await db.query(
      `INSERT INTO users
         (id, company_id, email, email_display, display_name, access_level, status, activated_at, modules)
       VALUES ($1,$2,$3,$3,'No MFA Admin','admin','active',NOW(3), JSON_ARRAY())`,
      [noMfaId, companyId, email],
    );
    await db.query(
      `INSERT INTO identities (user_id, password_hash, password_set_at, recovery_codes)
       VALUES ($1,$2,NOW(3), JSON_ARRAY())`,
      [noMfaId, await crypto.hashPassword(ADMIN_PASSWORD)],
    );

    const client = new Client(app);
    const login = await client.post('/api/v1/auth/login', {
      email,
      password: ADMIN_PASSWORD,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, 'authenticated');
    client.csrfToken = login.body.csrfToken;

    const attempt = await client.post(
      '/api/v1/users',
      { email: `blocked.${Date.now()}@e2e.test`, displayName: 'Blocked', accessLevel: 'staff' },
      { 'idempotency-key': `stepup-${Date.now()}` },
    );
    assert.equal(attempt.status, 403);
    assert.equal(/multi-factor/i.test(attempt.body.error.message), true);
  });

  it('returns the current user and capability set', async () => {
    const me = await admin.get('/api/v1/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, ADMIN_EMAIL);

    const capabilities = await admin.get('/api/v1/me/capabilities');
    assert.equal(capabilities.body.accessLevel, 'super_admin');
    assert.equal(capabilities.body.capabilities.includes('user.create'), true);
  });

  // --------------------------------------------------------------- account lifecycle

  let staffId: string;
  let staffEmail: string;
  let staff: Client;

  it('creates an account, activates it, and signs in (blueprint 20 acceptance)', async () => {
    staffEmail = `colleague.${Date.now()}@e2e.test`;
    const created = await admin.post(
      '/api/v1/users',
      {
        email: staffEmail,
        displayName: 'Test Colleague',
        accessLevel: 'staff',
        title: 'Analyst',
      },
      { 'idempotency-key': `create-${staffEmail}` },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.user.status, 'invited');
    staffId = created.body.user.id;

    // The activation token is single use and never stored in plaintext.
    const invitation = await db.one<{ token_hash: string }>(
      'SELECT token_hash FROM invitations WHERE user_id = $1 AND used_at IS NULL',
      [staffId],
    );
    assert.ok(invitation);
    const token = new URL(created.body.invitation.url).searchParams.get('token')!;
    assert.equal(crypto.hashToken(token), invitation!.token_hash);

    const anonymous = new Client(app);
    const activated = await anonymous.post('/api/v1/auth/activate', {
      token,
      password: STAFF_PASSWORD,
    });
    assert.equal(activated.status, 201);
    assert.equal(activated.body.user.status, 'active');
    assert.equal(activated.body.recoveryCodes.length, 10);
    assert.ok(activated.body.mfa.secret);

    // The same invitation cannot be replayed.
    const replay = await anonymous.post('/api/v1/auth/activate', {
      token,
      password: STAFF_PASSWORD,
    });
    assert.equal(replay.status, 400);

    staff = new Client(app);
    const login = await staff.post('/api/v1/auth/login', {
      email: staffEmail,
      password: STAFF_PASSWORD,
    });
    assert.equal(login.status, 200);
    staff.csrfToken = login.body.csrfToken;
  });

  it('rejects an account on an unverified domain', async () => {
    const attempt = await admin.post(
      '/api/v1/users',
      { email: 'someone@not-our-domain.com', displayName: 'Outsider', accessLevel: 'staff' },
      { 'idempotency-key': `bad-domain-${Date.now()}` },
    );
    assert.equal(attempt.status, 422);
    assert.equal(attempt.body.error.fields[0].field, 'email');
  });

  it('enforces password policy on activation', async () => {
    const weakEmail = `weak.${Date.now()}@e2e.test`;
    const created = await admin.post(
      '/api/v1/users',
      { email: weakEmail, displayName: 'Weak Password', accessLevel: 'staff' },
      { 'idempotency-key': `weak-${weakEmail}` },
    );
    const token = new URL(created.body.invitation.url).searchParams.get('token')!;
    const anonymous = new Client(app);
    const attempt = await anonymous.post('/api/v1/auth/activate', { token, password: 'short' });
    assert.equal(attempt.status, 422);
    assert.equal(attempt.body.error.fields.some((f: Json) => f.field === 'password'), true);
  });

  it('honours Idempotency-Key so a retried creation does not duplicate the account', async () => {
    const email = `idem.${Date.now()}@e2e.test`;
    const key = `idem-${email}`;
    const first = await admin.post(
      '/api/v1/users',
      { email, displayName: 'Idempotent Person', accessLevel: 'staff' },
      { 'idempotency-key': key },
    );
    const second = await admin.post(
      '/api/v1/users',
      { email, displayName: 'Idempotent Person', accessLevel: 'staff' },
      { 'idempotency-key': key },
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.user.id, first.body.user.id);
    assert.equal(second.headers['idempotent-replay'], 'true');

    const count = await db.one<{ count: number }>(
      'SELECT count(*) AS count FROM users WHERE company_id = $1 AND email = $2',
      [companyId, email],
    );
    assert.equal(count!.count, 1);
  });

  // --------------------------------------------------------------- authorization matrix

  it('denies privileged endpoints to a staff account', async () => {
    const create = await staff.post(
      '/api/v1/users',
      { email: `escalate.${Date.now()}@e2e.test`, displayName: 'Escalation', accessLevel: 'admin' },
      { 'idempotency-key': `esc-${Date.now()}` },
    );
    assert.equal(create.status, 403);

    const audit = await staff.get('/api/v1/audit/events');
    assert.equal(audit.status, 403);

    const settings = await staff.patch('/api/v1/admin/company', { name: 'Renamed By Staff' });
    assert.equal(settings.status, 403);
  });

  it('prevents a person from raising their own access level', async () => {
    const attempt = await staff.patch('/api/v1/me', { accessLevel: 'admin' } as Json);
    // accessLevel is not part of the /me schema, so it is ignored rather than applied.
    const after = await db.one<{ access_level: string }>(
      'SELECT access_level FROM users WHERE id = $1',
      [staffId],
    );
    assert.equal(after!.access_level, 'staff');
    assert.equal([200, 422].includes(attempt.status), true);
  });

  it('isolates tenants: another company cannot be reached', async () => {
    const otherCompanyId = randomUUID();
    await db.query(
      `INSERT INTO companies (id, name, verified_domains, settings)
       VALUES ($1, 'Other Corp', JSON_ARRAY('other.test'), JSON_OBJECT())`,
      [otherCompanyId],
    );
    const otherUserId = randomUUID();
    await db.query(
      `INSERT INTO users
         (id, company_id, email, email_display, display_name, access_level, status, modules)
       VALUES ($1,$2,'outsider@other.test','outsider@other.test','Outsider','staff','active', JSON_ARRAY())`,
      [otherUserId, otherCompanyId],
    );

    // A valid identifier from a different company must read as "not found", never as data.
    const attempt = await admin.get(`/api/v1/users/${otherUserId}`);
    assert.equal(attempt.status, 404);

    const listed = await admin.get('/api/v1/users?limit=100');
    assert.equal(
      listed.body.items.some((u: Json) => u.id === otherUserId),
      false,
    );
    await db.purgeTransaction((tx) =>
      tx.query('DELETE FROM companies WHERE id = $1', [otherCompanyId]),
    );
  });

  // --------------------------------------------------------------- collaboration

  it('runs the chat flow with membership enforcement', async () => {
    const room = await admin.post('/api/v1/chat/rooms', {
      name: `team-${Date.now()}`,
      visibility: 'private',
      memberIds: [],
    });
    assert.equal(room.status, 201);
    const roomId = room.body.id;

    const posted = await admin.post(`/api/v1/chat/rooms/${roomId}/messages`, { body: 'First message' });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.seq, 1);

    // A non-member cannot read a private channel.
    const intrusion = await staff.get(`/api/v1/chat/rooms/${roomId}/messages`);
    assert.equal(intrusion.status, 403);

    await admin.post(`/api/v1/chat/rooms/${roomId}/members`, { userIds: [staffId] });
    const allowed = await staff.get(`/api/v1/chat/rooms/${roomId}/messages`);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.items.length, 1);

    // Sequences are strictly monotonic per room.
    const second = await staff.post(`/api/v1/chat/rooms/${roomId}/messages`, { body: 'Reply' });
    assert.equal(second.body.seq, 2);
  });

  it('schedules a meeting and prevents double-booking a room', async () => {
    const roomId = randomUUID();
    await db.query(
      `INSERT INTO rooms (id, company_id, name, capacity) VALUES ($1,$2,'E2E Boardroom',10)`,
      [roomId, companyId],
    );
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 90_000_000).toISOString();

    const created = await admin.post(
      '/api/v1/calendar/events',
      {
        title: 'Quarterly review',
        startsAt,
        endsAt,
        timezone: 'Asia/Colombo',
        roomId,
        attendeeIds: [staffId],
      },
      { 'idempotency-key': `event-${Date.now()}` },
    );
    assert.equal(created.status, 201);

    const clash = await admin.post(
      '/api/v1/calendar/events',
      {
        title: 'Competing booking',
        startsAt,
        endsAt,
        timezone: 'Asia/Colombo',
        roomId,
        attendeeIds: [],
      },
      { 'idempotency-key': `event-clash-${Date.now()}` },
    );
    assert.equal(clash.status, 409);

    // The invited attendee can see and respond to it.
    const rsvp = await staff.post(`/api/v1/calendar/events/${created.body.id}/rsvp`, {
      rsvp: 'accepted',
    });
    assert.equal(rsvp.status, 204);
  });

  it('rejects a meeting that ends before it starts', async () => {
    const attempt = await admin.post(
      '/api/v1/calendar/events',
      {
        title: 'Time travel',
        startsAt: new Date(Date.now() + 90_000_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        timezone: 'UTC',
        attendeeIds: [],
      },
      { 'idempotency-key': `bad-time-${Date.now()}` },
    );
    assert.equal(attempt.status, 422);
  });

  it('enforces optimistic concurrency on task updates', async () => {
    const project = await admin.post('/api/v1/projects', {
      name: 'E2E Project',
      key: `E${Date.now().toString().slice(-6)}`,
    });
    assert.equal(project.status, 201);

    const task = await admin.post(`/api/v1/projects/${project.body.id}/tasks`, {
      title: 'Prepare migration plan',
      priority: 'high',
    });
    assert.equal(task.status, 201);
    const version = task.body.version;

    const stale = await admin.patch(
      `/api/v1/tasks/${task.body.id}`,
      { status: 'in_progress' },
      { 'if-match': `"${version - 1}"` },
    );
    assert.equal(stale.status, 412);

    const current = await admin.patch(
      `/api/v1/tasks/${task.body.id}`,
      { status: 'in_progress' },
      { 'if-match': `"${version}"` },
    );
    assert.equal(current.status, 200);
    assert.equal(current.body.status, 'in_progress');
  });

  it('blocks completing a task whose dependency is still open', async () => {
    const project = await admin.post('/api/v1/projects', {
      name: 'Dependency Project',
      key: `D${Date.now().toString().slice(-6)}`,
    });
    const blocker = await admin.post(`/api/v1/projects/${project.body.id}/tasks`, {
      title: 'Blocking work',
    });
    const dependent = await admin.post(`/api/v1/projects/${project.body.id}/tasks`, {
      title: 'Dependent work',
      dependsOn: [blocker.body.id],
    });
    const attempt = await admin.patch(`/api/v1/tasks/${dependent.body.id}`, { status: 'done' });
    assert.equal(attempt.status, 409);
  });

  // --------------------------------------------------------------- approvals

  it('routes an approval and enforces separation of duties', async () => {
    // The requester reports to the administrator, who becomes the approver.
    await db.query('UPDATE users SET manager_id = $2 WHERE id = $1', [staffId, adminId]);

    const request = await staff.post(
      '/api/v1/approvals',
      { definitionKey: 'expense', title: 'Client travel', amount: 250 },
      { 'idempotency-key': `approval-${Date.now()}` },
    );
    assert.equal(request.status, 201);
    const requestId = request.body.id;

    // The requester cannot approve their own request.
    const selfApproval = await staff.post(
      `/api/v1/approvals/${requestId}/decisions`,
      { decision: 'approved' },
      { 'idempotency-key': `self-${Date.now()}` },
    );
    assert.equal(selfApproval.status, 403);

    const decision = await admin.post(
      `/api/v1/approvals/${requestId}/decisions`,
      { decision: 'approved', comment: 'Within policy' },
      { 'idempotency-key': `decide-${requestId}` },
    );
    assert.equal(decision.status, 201);
    assert.equal(decision.body.status, 'approved');

    // A second decision on a settled request is refused.
    const again = await admin.post(
      `/api/v1/approvals/${requestId}/decisions`,
      { decision: 'rejected' },
      { 'idempotency-key': `decide-again-${requestId}` },
    );
    assert.equal(again.status, 409);

    // The decision history is immutable.
    await assert.rejects(
      db.query('UPDATE approval_decisions SET decision = $1 WHERE request_id = $2', [
        'rejected',
        requestId,
      ]),
    );
  });

  // --------------------------------------------------------------- announcements

  it('publishes an announcement and records acknowledgement', async () => {
    const created = await admin.post('/api/v1/announcements', {
      title: 'Office closed Friday',
      body: 'The building is closed for maintenance.',
      priority: 'important',
      audience: { scope: 'company' },
      requiresAck: true,
    });
    assert.equal(created.status, 201);

    // The targeted colleague sees it.
    const listed = await staff.get('/api/v1/announcements');
    assert.equal(listed.status, 200);
    assert.equal(
      listed.body.items.some((a: Json) => a.id === created.body.id),
      true,
    );

    // Acknowledgement is a deliberate act and is recorded.
    const acked = await staff.post(`/api/v1/announcements/${created.body.id}/read`, {
      acknowledge: true,
    });
    assert.equal(acked.status, 204);

    const stats = await admin.get(`/api/v1/announcements/${created.body.id}/stats`);
    assert.equal(stats.status, 200);
    assert.equal(stats.body.acks >= 1, true);

    // Withdrawing removes it from everyone's list.
    assert.equal((await admin.del(`/api/v1/announcements/${created.body.id}`)).status, 204);
    const after = await staff.get('/api/v1/announcements');
    assert.equal(
      after.body.items.some((a: Json) => a.id === created.body.id),
      false,
    );
  });

  it('refuses announcement publication to someone without the capability', async () => {
    const attempt = await staff.post('/api/v1/announcements', {
      title: 'Unauthorised',
      body: 'Should not publish',
    });
    assert.equal(attempt.status, 403);
  });

  // --------------------------------------------------------------- files

  it('separates the recycle bin from the active file list', async () => {
    const upload = await admin.post('/api/v1/files/uploads', {
      filename: 'retention-note.txt',
      mimeType: 'text/plain',
      sizeBytes: 24,
    });
    assert.equal(upload.status, 201);
    const fileId = upload.body.fileId as string;

    // Finalise it directly so the record reaches an active state.
    const fileDomain = await import('../src/domains/files.js');
    const actorContext = await (await import('../src/domains/identity.js')).findUserById(adminId);
    const { buildActor } = await import('../src/domains/identity.js');
    const actor = await buildActor(actorContext!, { id: 'test', mfa_satisfied: true });
    await fileDomain.receiveUpload(actor, upload.body.uploadId, Buffer.from('retention note content'));

    const active = await admin.get('/api/v1/files?limit=100');
    assert.equal(active.body.items.some((f: Json) => f.id === fileId), true);

    assert.equal((await admin.del(`/api/v1/files/${fileId}`)).status, 204);

    // Gone from the active list, present in the bin, and restorable.
    const afterDelete = await admin.get('/api/v1/files?limit=100');
    assert.equal(afterDelete.body.items.some((f: Json) => f.id === fileId), false);

    const bin = await admin.get('/api/v1/files?limit=100&recycled=true');
    assert.equal(bin.body.items.some((f: Json) => f.id === fileId), true);

    assert.equal((await admin.post(`/api/v1/files/${fileId}/restore`)).status, 200);
    const restored = await admin.get('/api/v1/files?limit=100');
    assert.equal(restored.body.items.some((f: Json) => f.id === fileId), true);
  });

  it('records every stored version of a file', async () => {
    const list = await admin.get('/api/v1/files?limit=100');
    const file = list.body.items[0];
    if (!file) return;
    const versions = await admin.get(`/api/v1/files/${file.id}/versions`);
    assert.equal(versions.status, 200);
    assert.equal(versions.body.items.length >= 1, true);
    assert.ok(versions.body.items[0].checksum);
  });

  // --------------------------------------------------------------- groups

  it('creates a group and applies membership immediately', async () => {
    const group = await admin.post('/api/v1/admin/groups', {
      name: `finance-reviewers-${Date.now()}`,
      description: 'Reviews finance requests',
    });
    assert.equal(group.status, 201);

    const set = await admin.put(`/api/v1/admin/groups/${group.body.id}/members`, {
      userIds: [staffId],
    });
    assert.equal(set.status, 204);

    const listed = await admin.get('/api/v1/admin/groups');
    const found = listed.body.items.find((g: Json) => g.id === group.body.id);
    assert.equal(found.member_count, 1);

    // The member's own capability context now includes the group.
    const capabilities = await staff.get('/api/v1/me/capabilities');
    assert.equal(capabilities.body.groupIds.includes(group.body.id), true);
  });

  // --------------------------------------------------------------- chat direct

  it('returns the same direct conversation rather than duplicating it', async () => {
    const first = await admin.post('/api/v1/chat/direct', { userId: staffId });
    const second = await admin.post('/api/v1/chat/direct', { userId: staffId });
    assert.equal(first.status, 201);
    assert.equal(second.body.id, first.body.id);
  });

  // --------------------------------------------------------------- mail is gone

  it('no longer exposes any mail endpoints', async () => {
    // The module was removed in favour of a separate email application; the routes
    // must be genuinely absent, not merely hidden in the interface.
    for (const path of ['/api/v1/mail/mailboxes', '/api/v1/mail/messages', '/api/v1/webhooks/mail']) {
      const response = await admin.get(path);
      assert.equal(response.status, 404, `${path} should not exist`);
    }
  });

  // --------------------------------------------------------------- search

  it('returns only results the caller is authorized to see', async () => {
    const searchIndex = await import('../src/domains/search.js');
    const secretId = randomUUID();
    await searchIndex.index({
      companyId,
      docType: 'file',
      resourceId: secretId,
      title: 'Restricted board pack zebra9',
      body: 'Confidential board material zebra9',
      classification: 'confidential',
      aclUserIds: [adminId],
    });

    const adminResults = await admin.get('/api/v1/search?q=zebra9');
    assert.equal(adminResults.status, 200);
    assert.equal(adminResults.body.hits.length >= 1, true);

    // The staff account is not on the ACL, so the document must be absent entirely -
    // not returned and hidden by the client.
    const staffResults = await staff.get('/api/v1/search?q=zebra9');
    assert.equal(staffResults.status, 200);
    assert.equal(staffResults.body.hits.length, 0);
    assert.equal(staffResults.body.total, 0);
  });

  // --------------------------------------------------------------- audit

  it('writes an append-only audit trail that cannot be altered', async () => {
    const events = await admin.get('/api/v1/audit/events?limit=50');
    assert.equal(events.status, 200);
    assert.equal(events.body.items.some((e: Json) => e.action === 'user.create'), true);

    // Credentials never reach the trail.
    const serialized = JSON.stringify(events.body);
    assert.equal(serialized.includes(ADMIN_PASSWORD), false);
    assert.equal(serialized.includes(STAFF_PASSWORD), false);

    await assert.rejects(
      db.query('UPDATE audit_events SET action = $1 WHERE company_id = $2', ['tampered', companyId]),
      /append-only/,
    );
    await assert.rejects(
      db.query('DELETE FROM audit_events WHERE company_id = $1', [companyId]),
      /append-only/,
    );

    // Only a transaction that explicitly opts in may purge history, and the opt-in is
    // transaction-local: it must not persist for later statements on the pool.
    await db.purgeTransaction((tx) =>
      tx.query('DELETE FROM audit_events WHERE company_id = $1 AND action = $2', [
        companyId,
        'never-matches-anything',
      ]),
    );
    await assert.rejects(
      db.query('DELETE FROM audit_events WHERE company_id = $1', [companyId]),
      /append-only/,
    );
  });

  // --------------------------------------------------------------- suspension

  it('closes all access the moment an account is suspended (blueprint 20)', async () => {
    // The account works before suspension.
    assert.equal((await staff.get('/api/v1/me')).status, 200);

    const suspended = await admin.post(`/api/v1/users/${staffId}/suspend`, {
      reason: 'Offboarding test',
    });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.status, 'suspended');

    // The existing session is dead immediately, not at its natural expiry.
    assert.equal((await staff.get('/api/v1/me')).status, 401);

    // A direct call to a module endpoint is refused too.
    assert.equal((await staff.get('/api/v1/chat/rooms')).status, 401);
    assert.equal((await staff.get('/api/v1/tasks')).status, 401);

    // Re-authentication is refused with a support-oriented message.
    const relogin = new Client(app);
    const attempt = await relogin.post('/api/v1/auth/login', {
      email: staffEmail,
      password: STAFF_PASSWORD,
    });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.error.code, 'account_unavailable');

    // Reactivation restores the ability to sign in.
    const reactivated = await admin.post(`/api/v1/users/${staffId}/reactivate`, {});
    assert.equal(reactivated.status, 200);
    const after = new Client(app);
    assert.equal(
      (await after.post('/api/v1/auth/login', { email: staffEmail, password: STAFF_PASSWORD })).status,
      200,
    );
  });

  it('locks an account after repeated failed sign-in attempts', async () => {
    const email = `lockout.${Date.now()}@e2e.test`;
    const created = await admin.post(
      '/api/v1/users',
      { email, displayName: 'Lockout Test', accessLevel: 'staff' },
      { 'idempotency-key': `lock-${email}` },
    );
    const token = new URL(created.body.invitation.url).searchParams.get('token')!;
    const anonymous = new Client(app);
    await anonymous.post('/api/v1/auth/activate', { token, password: STAFF_PASSWORD });

    for (let i = 0; i < 9; i += 1) {
      await anonymous.post('/api/v1/auth/login', { email, password: 'wrong-password-value' });
    }
    const locked = await db.one<{ locked_until: Date | null }>(
      'SELECT locked_until FROM identities WHERE user_id = $1',
      [created.body.user.id],
    );
    assert.notEqual(locked!.locked_until, null);

    // Even the correct password is refused while the lockout stands.
    const correct = await anonymous.post('/api/v1/auth/login', { email, password: STAFF_PASSWORD });
    assert.equal(correct.status, 401);
  });

  // --------------------------------------------------------------- contract

  it('returns the standard error envelope with a correlation id', async () => {
    const missing = await admin.get('/api/v1/users/00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
    assert.ok(missing.body.error.correlationId);
    assert.deepEqual(missing.body.error.fields, []);

    const invalid = await admin.post(
      '/api/v1/users',
      { email: 'not-an-email', displayName: '' },
      { 'idempotency-key': `invalid-${Date.now()}` },
    );
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, 'unprocessable');
    assert.equal(invalid.body.error.fields.length > 0, true);
  });

  it('never leaks internal detail or stack traces in an error body', async () => {
    const response = await admin.get('/api/v1/search?q=');
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('at Object'), false);
    assert.equal(serialized.toLowerCase().includes('postgres'), false);
    assert.equal(serialized.includes('node_modules'), false);
  });
});
