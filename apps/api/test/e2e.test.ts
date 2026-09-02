/**
 * End-to-end and authorization-matrix tests (blueprint 17: "End-to-end", "Authorization",
 * "API contract"). These run against a real Postgres database and a real HTTP server.
 *
 * They assert the acceptance criteria from blueprint 20: invite -> activate -> login ->
 * authorized dashboard, suspension closing access, cross-tenant isolation, separation
 * of duties, concurrency preconditions and idempotency.
 *
 * Skipped automatically when TEST_DATABASE_URL is not set.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const enabled = DATABASE_URL.length > 0;

/**
 * A suite that quietly skips itself is worse than one that fails: `npm test` reports
 * green while every integration path goes unchecked. Outside a developer's machine the
 * absence of a database is a broken pipeline, not a reason to pass, so refuse to start.
 * Set SKIP_E2E=1 to opt out deliberately.
 */
if (!enabled && process.env.CI === 'true' && process.env.SKIP_E2E !== '1') {
  throw new Error(
    'End-to-end tests require TEST_DATABASE_URL (or DATABASE_URL). ' +
      'Set it, or set SKIP_E2E=1 to skip these tests on purpose.',
  );
}
if (!enabled) {
  console.warn(
    '\n  ! End-to-end tests skipped: TEST_DATABASE_URL is not set. ' +
      'Unit tests alone do not cover HTTP, authorization or persistence.\n',
  );
}

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
  let identity: typeof import('../src/domains/identity.js');
  let companyId: string;
  let adminId: string;
  let admin: Client;

  const ADMIN_EMAIL = 'e2e.admin@e2e.test';
  const ADMIN_PASSWORD = 'e2e-Administrator-Passphrase-9';
  const STAFF_PASSWORD = 'e2e-Colleague-Passphrase-77';

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DATA_ENCRYPTION_KEY ??= 'a'.repeat(64);
    process.env.NOTIFY_DRIVER = 'log';
    process.env.NOTIFY_DEFAULT_DOMAIN = 'e2e.test';
    process.env.RATE_API_PER_MIN = '100000';
    process.env.RATE_LOGIN_PER_MIN = '10000';

    db = await import('../src/core/db.js');
    crypto = await import('../src/core/crypto.js');
    identity = await import('../src/domains/identity.js');
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
    await db.query(
      `INSERT INTO identities (user_id, password_hash, password_set_at)
       VALUES ($1,$2,NOW(3))`,
      [adminId, await crypto.hashPassword(ADMIN_PASSWORD)],
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

    admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  /** Signs in and returns a client holding the resulting session. */
  async function signIn(email: string, password: string): Promise<Client> {
    const client = new Client(app);
    const login = await client.post('/api/v1/auth/login', { email, password });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, 'authenticated');
    client.csrfToken = login.body.csrfToken;
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

  it('signs in with a password alone, without a second factor', async () => {
    // Multi-factor authentication was removed from the product, so a correct password
    // must yield a usable session in one step rather than a challenge.
    const client = new Client(app);
    const login = await client.post('/api/v1/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, 'authenticated');
    assert.ok(login.body.csrfToken);
    client.csrfToken = login.body.csrfToken;

    // That session reaches privileged actions immediately; there is no step-up gate.
    const created = await client.post(
      '/api/v1/users',
      {
        email: `nostepup.${Date.now()}@e2e.test`,
        displayName: 'No Step Up',
        accessLevel: 'staff',
      },
      { 'idempotency-key': `nostepup-${Date.now()}` },
    );
    assert.equal(created.status, 201);
  });

  it('no longer exposes multi-factor endpoints', async () => {
    for (const path of ['/api/v1/auth/mfa/verify', '/api/v1/auth/mfa/confirm']) {
      const response = await admin.post(path, {});
      assert.equal(response.status, 404, `${path} should not exist`);
    }
  });

  it('stores and returns the company legal name', async () => {
    const updated = await admin.patch('/api/v1/admin/company', {
      legalName: 'Infinity AI (Pvt) Ltd',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.legal_name, 'Infinity AI (Pvt) Ltd');

    const me = await admin.get('/api/v1/me');
    assert.equal(me.body.company.legal_name, 'Infinity AI (Pvt) Ltd');
  });

  it('refuses unauthenticated access to protected endpoints', async () => {
    const anonymous = new Client(app);
    assert.equal((await anonymous.get('/api/v1/me')).status, 401);
    assert.equal((await anonymous.get('/api/v1/users')).status, 401);
    assert.equal((await anonymous.get('/api/v1/audit/events')).status, 401);
  });

  it('rejects a state-changing request without a CSRF token', async () => {
    const noCsrf = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    // Drop the token so the header is omitted even though the session is valid.
    noCsrf.csrfToken = null;
    const attempt = await noCsrf.post('/api/v1/chat/rooms', { name: 'csrf-probe' });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.error.code, 'forbidden');
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
    const resent = await admin.post(
      `/api/v1/users/${staffId}/invitation`,
      {},
      { 'idempotency-key': `resend-${staffEmail}` },
    );
    assert.equal(resent.status, 200);
    assert.equal(resent.body.invitation.expiresInHours, 72);
    const replacementToken = new URL(resent.body.invitation.url).searchParams.get('token')!;
    assert.notEqual(replacementToken, token);

    // A resend revokes the previous link before issuing the replacement.
    const expiredByResend = await anonymous.post('/api/v1/auth/activate', {
      token,
      password: STAFF_PASSWORD,
    });
    assert.equal(expiredByResend.status, 400);

    const activated = await anonymous.post('/api/v1/auth/activate', {
      token: replacementToken,
      password: STAFF_PASSWORD,
    });
    assert.equal(activated.status, 201);
    assert.equal(activated.body.user.status, 'active');

    // The same invitation cannot be replayed.
    const replay = await anonymous.post('/api/v1/auth/activate', {
      token: replacementToken,
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
        onlineUrl: 'https://meet.example.com/quarterly-review',
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

    const detail = await staff.get(`/api/v1/calendar/events/${created.body.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.myRsvp, 'accepted');
    assert.equal(detail.body.onlineUrl, 'https://meet.example.com/quarterly-review');
    assert.equal(
      detail.body.attendees.find((attendee: { user_id: string }) => attendee.user_id === staffId)?.rsvp,
      'accepted',
    );
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

  it('routes a request for someone with no manager, via the fallback approver', async () => {
    // The administrator sits at the top of the reporting line and has no manager. Every
    // seeded route starts with a manager step, which previously made the request
    // impossible to raise at all rather than merely routing it elsewhere.
    //
    // This uses its own definition so it cannot disturb the shared 'expense' route that
    // later tests depend on.
    await db.query(
      `INSERT INTO approval_definitions (id, company_id, \`key\`, name, form_schema, routing)
       VALUES ($1,$2,'fallback_probe','Fallback probe', JSON_ARRAY(), CAST($3 AS JSON))`,
      [
        randomUUID(),
        companyId,
        JSON.stringify([
          {
            step: 1,
            approver: { type: 'manager', fallback: { type: 'access_level', value: 'admin' } },
            dueHours: 48,
          },
        ]),
      ],
    );

    // An admin-level colleague exists to receive the fallback, and is not the requester.
    const fallbackId = randomUUID();
    await db.query(
      `INSERT INTO users
         (id, company_id, email, email_display, display_name, access_level, status, activated_at, modules)
       VALUES ($1,$2,$3,$3,'Fallback Approver','admin','active',NOW(3), JSON_ARRAY())`,
      [fallbackId, companyId, `fallback.${Date.now()}@e2e.test`],
    );

    const raised = await admin.post(
      '/api/v1/approvals',
      { definitionKey: 'fallback_probe', title: 'Chief executive travel', amount: 300 },
      { 'idempotency-key': `fallback-${Date.now()}` },
    );
    assert.equal(raised.status, 201);

    const detail = await admin.get(`/api/v1/approvals/${raised.body.id}`);
    const approvers = detail.body.steps.map((step: Json) => step.approver_id);
    assert.equal(approvers.includes(fallbackId), true, 'fallback approver should be routed');
    // Separation of duties still holds: the requester is never an approver.
    assert.equal(approvers.includes(adminId), false);
  });

  it('refuses a request when no step can resolve an approver', async () => {
    // A route resolving to nobody must be refused outright rather than quietly creating
    // a request that is already fully approved.
    await db.query(
      `INSERT INTO approval_definitions (id, company_id, \`key\`, name, form_schema, routing)
       VALUES ($1,$2,'unroutable_probe','Unroutable probe', JSON_ARRAY(), CAST($3 AS JSON))`,
      [
        randomUUID(),
        companyId,
        JSON.stringify([
          { step: 1, approver: { type: 'access_level', value: 'nonexistent_role' }, optional: true },
        ]),
      ],
    );
    const attempt = await admin.post(
      '/api/v1/approvals',
      { definitionKey: 'unroutable_probe', title: 'Unroutable', amount: 10 },
      { 'idempotency-key': `unroutable-${Date.now()}` },
    );
    assert.equal(attempt.status, 422);
  });

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
      sizeBytes: 22,
    });
    assert.equal(upload.status, 201);
    const fileId = upload.body.fileId as string;

    // Finalise it directly so the record reaches an active state.
    const fileDomain = await import('../src/domains/files.js');
    const actorContext = await (await import('../src/domains/identity.js')).findUserById(adminId);
    const { buildActor } = await import('../src/domains/identity.js');
    const actor = await buildActor(actorContext!, { id: 'test' });
    await fileDomain.receiveUpload(actor, upload.body.uploadId, Buffer.from('retention note content'));

    const active = await admin.get('/api/v1/files?limit=100');
    const stored = active.body.items.find((f: Json) => f.id === fileId);
    assert.ok(stored);
    assert.equal(stored.state, 'active');
    assert.equal(stored.sizeBytes, 22);

    const download = await admin.get(`/api/v1/files/${fileId}/download`);
    assert.equal(download.status, 200);
    const signed = new URL(download.body.url);
    const content = await app.inject({ method: 'GET', url: `${signed.pathname}${signed.search}` });
    assert.equal(content.statusCode, 200);
    assert.equal(content.rawPayload.toString(), 'retention note content');

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

  it('rejects a page size above the configured maximum', async () => {
    // The people pickers requested limit=200 against a cap of 100 and failed on every
    // load. The contract is asserted here so a client cannot drift past it unnoticed.
    const over = await admin.get('/api/v1/users?limit=200');
    assert.equal(over.status, 422);

    const atCap = await admin.get('/api/v1/users?limit=100');
    assert.equal(atCap.status, 200);
  });

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

  it('caps a desktop session at five days and treats a replayed refresh as theft', async () => {
    // The desktop client cannot use the cookie and CSRF pair, so it carries a bearer
    // token. The two properties worth pinning: refreshing must never extend the ceiling,
    // and a refresh token presented twice must be treated as stolen rather than as a
    // retry - otherwise a copied token quietly outlives the session it came from.
    const anonymous = new Client(app);
    const granted = await anonymous.post('/api/v1/auth/token', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      device: 'Suite runner',
    });
    assert.equal(granted.status, 200);
    const first = granted.body as {
      accessToken: string;
      refreshToken: string;
      absoluteExpiresAt: string;
    };

    const days = (new Date(first.absoluteExpiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 4.9 && days < 5.1, `ceiling should be five days, got ${days}`);

    // The bearer token authenticates, and a write needs no CSRF token: that defence
    // exists because browsers attach cookies unbidden, which a header never is.
    const bearer = { authorization: `Bearer ${first.accessToken}` };
    assert.equal((await anonymous.get('/api/v1/me', bearer)).status, 200);

    const rotated = await anonymous.post('/api/v1/auth/token/refresh', {
      refreshToken: first.refreshToken,
    });
    assert.equal(rotated.status, 200);
    const second = rotated.body as { accessToken: string; absoluteExpiresAt: string };

    // Refreshing buys a new access token, never more time overall.
    assert.equal(second.absoluteExpiresAt, first.absoluteExpiresAt);
    assert.equal((await anonymous.get('/api/v1/me', bearer)).status, 401);
    assert.equal(
      (await anonymous.get('/api/v1/me', { authorization: `Bearer ${second.accessToken}` })).status,
      200,
    );

    // Replaying the spent refresh token means the credential is in more hands than it
    // should be. The whole rotation chain goes, including the session currently live.
    const replay = await anonymous.post('/api/v1/auth/token/refresh', {
      refreshToken: first.refreshToken,
    });
    assert.equal(replay.status, 401);
    assert.equal(
      (await anonymous.get('/api/v1/me', { authorization: `Bearer ${second.accessToken}` })).status,
      401,
      'a replayed refresh token must kill the live session too, not just the replay',
    );
  });

  it('surfaces the money nobody paid and the equipment nobody returned', async () => {
    // report.read was granted to roles in the first migration and checked nowhere. These
    // two reports are why it exists: approved-but-unpaid and equipment still out with
    // someone who has left are both invisible until something asks the question.
    const overview = await admin.get('/api/v1/reports/overview');
    assert.equal(overview.status, 200);
    assert.ok(overview.body.headcount);
    assert.ok(overview.body.spend);
    assert.ok(overview.body.assets);

    const claim = await admin.post(
      '/api/v1/expenses/claims',
      { title: 'Unpaid probe', items: [{ spentOn: '2026-08-10', amount: 40 }] },
      { 'idempotency-key': `unpaid-${Date.now()}` },
    );
    assert.equal(claim.status, 201);
    // Approved and left unpaid, which is precisely the state the report exists to find.
    await db.pool.query(
      "UPDATE expense_claims SET status = 'approved', decided_at = NOW(3) WHERE id = $1",
      [claim.body.id],
    );

    const spend = await admin.get('/api/v1/reports/spend');
    assert.equal(
      (spend.body.awaitingPayment as { reference: string }[]).some(
        (row) => row.reference === claim.body.reference,
      ),
      true,
    );

    // Equipment assigned while someone was active, then they left - a laptop cannot be
    // transferred by a database update, so offboarding cannot clear this on its own.
    const leaverEmail = `stranded.${Date.now()}@e2e.test`;
    const leaver = await admin.post(
      '/api/v1/users',
      { email: leaverEmail, displayName: 'Departing Holder', accessLevel: 'staff' },
      { 'idempotency-key': `stranded-${Date.now()}` },
    );
    await new Client(app).post('/api/v1/auth/activate', {
      token: new URL(leaver.body.invitation.url).searchParams.get('token')!,
      password: 'Departing-Holder-2026!',
    });

    const asset = await admin.post('/api/v1/assets', {
      assetTag: `PROBE-${Date.now().toString().slice(-6)}`,
      name: 'Probe laptop',
      purchaseCost: 1200,
    });
    assert.equal(asset.status, 201);
    assert.equal(
      (await admin.post(`/api/v1/assets/${asset.body.id}/assign`, {
        userId: leaver.body.user.id,
      })).status,
      200,
    );
    assert.equal(
      (await admin.post(
        `/api/v1/users/${leaver.body.user.id}/offboard`,
        { successorId: adminId, reason: 'Left' },
        { 'idempotency-key': `stranded-off-${Date.now()}` },
      )).status,
      200,
    );

    const assets = await admin.get('/api/v1/reports/assets');
    assert.equal(
      (assets.body.withDepartedStaff as { asset_tag: string }[]).some(
        (row) => row.asset_tag === asset.body.asset_tag,
      ),
      true,
      'equipment left with a departed employee must appear in the report',
    );
  });

  it('shows an employment history without showing what people earn', async () => {
    // Compensation is the one thing here sensitive between colleagues rather than only to
    // outsiders, so it is gated separately from the record it sits in - plenty of people
    // need an employment history without seeing a salary.
    const subject = await admin.post(
      '/api/v1/users',
      { email: `hire.${Date.now()}@e2e.test`, displayName: 'New Hire', accessLevel: 'staff' },
      { 'idempotency-key': `hire-${Date.now()}` },
    );
    assert.equal(subject.status, 201);
    const subjectId = subject.body.user.id as string;

    const first = await admin.post(`/api/v1/hr/employment/${subjectId}`, {
      jobTitle: 'Engineer',
      effectiveFrom: '2025-01-06',
      salary: 62000,
      changeReason: 'Joined',
    });
    assert.equal(first.status, 201);

    const promotion = await admin.post(`/api/v1/hr/employment/${subjectId}`, {
      jobTitle: 'Senior Engineer',
      effectiveFrom: '2026-04-01',
      salary: 74000,
      changeReason: 'Promotion',
    });
    assert.equal(promotion.status, 201);

    // History rather than current state: the earlier record is closed, not overwritten,
    // because "what were they on in March" is a question payroll and audits both ask.
    const history = await admin.get(`/api/v1/hr/employment/${subjectId}`);
    const rows = history.body.items as { job_title: string; effective_to: string | null; salary?: number }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.job_title, 'Senior Engineer');
    assert.equal(rows[0]!.effective_to, null);
    assert.notEqual(rows[1]!.effective_to, null);
    assert.equal(rows[0]!.salary, 74000);

    // Back-dating over terms someone was already paid under is a correction, not an edit,
    // and is refused rather than silently rewriting the history.
    const backdated = await admin.post(`/api/v1/hr/employment/${subjectId}`, {
      jobTitle: 'Backdated',
      effectiveFrom: '2025-06-01',
      salary: 1,
    });
    assert.equal(backdated.status, 409);

    // An auditor reads the record and not the pay. The field is absent rather than null,
    // so a reader cannot mistake "withheld" for "nothing recorded".
    const auditorEmail = `auditor.${Date.now()}@e2e.test`;
    const auditor = await admin.post(
      '/api/v1/users',
      { email: auditorEmail, displayName: 'Auditor', accessLevel: 'auditor' },
      { 'idempotency-key': `auditor-${Date.now()}` },
    );
    assert.equal(auditor.status, 201);
    const auditorClient = new Client(app);
    await auditorClient.post('/api/v1/auth/activate', {
      token: new URL(auditor.body.invitation.url).searchParams.get('token')!,
      password: 'Auditor-Passphrase-2026!',
    });
    await auditorClient.post('/api/v1/auth/login', {
      email: auditorEmail,
      password: 'Auditor-Passphrase-2026!',
    });

    const seen = await auditorClient.get(`/api/v1/hr/employment/${subjectId}`);
    assert.equal(seen.status, 200);
    const auditorRows = seen.body.items as Record<string, unknown>[];
    assert.equal(auditorRows[0]!.job_title, 'Senior Engineer');
    assert.equal(auditorRows[0]!.salaryVisible, false);
    assert.equal(Object.hasOwn(auditorRows[0]!, 'salary'), false);

    // And the amount never reaches the audit trail, which is read far more widely than
    // the record itself.
    const trail = await admin.get('/api/v1/admin/audit?limit=50');
    assert.equal(JSON.stringify(trail.body).includes('74000'), false);
  });

  it('keeps approving a claim and paying it in different hands', async () => {
    // The commonest expense fraud is approving your own reimbursement and then recording
    // the payment. Both halves must be refused, and the check has to actually fire - the
    // first version of it queried a column for a value that never occurs, so it silently
    // matched nothing and read as though it worked.
    // Claims submit against the 'expense' definition, and the suite's copy routes to a
    // manager with no fallback - which the administrator raising this does not have.
    await db.query(
      "UPDATE approval_definitions SET routing = $2 WHERE company_id = $1 AND `key` = 'expense'",
      [
        companyId,
        JSON.stringify([
          {
            step: 1,
            approver: { type: 'manager', fallback: { type: 'access_level', value: 'admin' } },
            dueHours: 48,
          },
        ]),
      ],
    );

    const claim = await admin.post(
      '/api/v1/expenses/claims',
      {
        title: 'Duties probe',
        items: [{ spentOn: '2026-08-10', amount: 100, merchant: 'Rail' }],
      },
      { 'idempotency-key': `claim-${Date.now()}` },
    );
    assert.equal(claim.status, 201);
    // The total is computed from the lines, never accepted from the caller.
    assert.equal(Number(claim.body.total_amount), 100);

    const submitted = await admin.post(
      `/api/v1/expenses/claims/${claim.body.id}/submit`,
      {},
      { 'idempotency-key': `submit-${Date.now()}` },
    );
    assert.equal(submitted.status, 200);

    // Approve it as the admin, who is also the claimant here.
    const approvalId = submitted.body.approval_request_id as string;
    await admin.post(
      `/api/v1/approvals/${approvalId}/decisions`,
      { decision: 'approved', comment: 'probe' },
      { 'idempotency-key': `decide-${Date.now()}` },
    );
    await db.pool.query("UPDATE expense_claims SET status = 'approved' WHERE id = $1", [
      claim.body.id,
    ]);

    const selfPay = await admin.post(
      `/api/v1/expenses/claims/${claim.body.id}/reimburse`,
      { paymentReference: 'SELF' },
      { 'idempotency-key': `pay-${Date.now()}` },
    );
    assert.equal(selfPay.status >= 400, true, 'the claimant must not be able to pay themselves');
    assert.equal(
      (await admin.get(`/api/v1/expenses/claims/${claim.body.id}`)).body.status,
      'approved',
    );
  });

  it('sanitizes page content and refuses a save that would overwrite someone', async () => {
    const space = await admin.post('/api/v1/docs/spaces', {
      name: `Handbook ${Date.now()}`,
      visibility: 'company',
    });
    assert.equal(space.status, 201);

    // A page is written by a colleague, but "has an account" is not "is trustworthy":
    // stored markup in a company handbook is read by everyone.
    const page = await admin.post('/api/v1/docs/pages', {
      spaceId: space.body.id,
      title: 'Deploying to production',
      body: '<h2>Steps</h2><p>ok</p><script>alert(1)</script>'
        + '<img src=x onerror="alert(2)"><a href="javascript:alert(3)">click</a>',
      publish: true,
    });
    assert.equal(page.status, 201);
    assert.equal(page.body.body.includes('<script'), false);
    assert.equal(/onerror/i.test(page.body.body), false);
    assert.equal(/javascript:/i.test(page.body.body), false);
    // The safe structure survives; only the dangerous parts are removed.
    assert.equal(page.body.body.includes('<h2>'), true);

    // Two people editing the same page is the normal case for a wiki, so a save must say
    // which version it replaces, and a stale one is refused rather than merged.
    const noPrecondition = await admin.patch(`/api/v1/docs/pages/${page.body.id}`, {
      body: '<p>blind write</p>',
    });
    assert.equal(noPrecondition.status, 400);

    const first = await admin.patch(
      `/api/v1/docs/pages/${page.body.id}`,
      { body: '<p>first writer</p>', changeNote: 'First' },
      { 'if-match': `"${page.body.version}"` },
    );
    assert.equal(first.status, 200);

    const stale = await admin.patch(
      `/api/v1/docs/pages/${page.body.id}`,
      { body: '<p>second writer, working from the old copy</p>' },
      { 'if-match': `"${page.body.version}"` },
    );
    assert.equal(stale.status, 412);

    // The first writer's work is intact - the refusal protected it.
    const current = await admin.get(`/api/v1/docs/pages/${page.body.id}`);
    assert.equal(current.body.body.includes('first writer'), true);

    // History is append-only, so a restore adds a version rather than rewinding.
    const history = await admin.get(`/api/v1/docs/pages/${page.body.id}/history`);
    assert.equal((history.body.items as unknown[]).length >= 2, true);
    const restored = await admin.post(
      `/api/v1/docs/pages/${page.body.id}/versions/1/restore`,
      {},
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.version > current.body.version, true);
  });

  it('requires readers for restricted document spaces and grants them access', async () => {
    const missingReaders = await admin.post('/api/v1/docs/spaces', {
      name: `Restricted empty ${Date.now()}`,
      visibility: 'restricted',
      readerIds: [],
    });
    assert.equal(missingReaders.status, 422);

    const restricted = await admin.post('/api/v1/docs/spaces', {
      name: `Leadership notes ${Date.now()}`,
      visibility: 'restricted',
      readerIds: [staffId],
    });
    assert.equal(restricted.status, 201);

    const creatorSpaces = await admin.get('/api/v1/docs/spaces');
    assert.equal(creatorSpaces.body.items.some((space: Json) => space.id === restricted.body.id), true);
    const readerSpaces = await staff.get('/api/v1/docs/spaces');
    assert.equal(readerSpaces.body.items.some((space: Json) => space.id === restricted.body.id), true);
  });

  it('lets a document editor upload and attach a standard file', async () => {
    const space = await admin.post('/api/v1/docs/spaces', {
      name: `Attachment space ${Date.now()}`,
      visibility: 'company',
    });
    const page = await admin.post('/api/v1/docs/pages', {
      spaceId: space.body.id,
      title: 'Attachment target',
      body: '<p>Supporting files</p>',
      publish: true,
    });

    const upload = await staff.post('/api/v1/files/uploads', {
      filename: 'supporting-notes.txt',
      mimeType: 'application/octet-stream',
      sizeBytes: 15,
    });
    assert.equal(upload.status, 201);
    const fileDomain = await import('../src/domains/files.js');
    const identity = await import('../src/domains/identity.js');
    const staffContext = await identity.findUserById(staffId);
    const staffActor = await identity.buildActor(staffContext!, { id: 'attachment-test' });
    await fileDomain.receiveUpload(staffActor, upload.body.uploadId, Buffer.from('attachment data'));

    const attached = await staff.post(`/api/v1/docs/pages/${page.body.id}/attachments`, {
      fileId: upload.body.fileId,
    });
    assert.equal(attached.status, 201);
    const listed = await staff.get(`/api/v1/docs/pages/${page.body.id}/attachments`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.some((item: Json) => item.file_id === upload.body.fileId), true);
  });

  it('counts only working days, and reserves them before the decision', async () => {
    // Leave rides on the approvals engine, so the company needs a route for it. The
    // fallback matters here: the administrator raising this has no manager.
    await db.query(
      `INSERT IGNORE INTO approval_definitions (id, company_id, \`key\`, name, form_schema, routing)
       VALUES ($1,$2,'leave','Leave request', JSON_ARRAY(), $3)`,
      [
        randomUUID(),
        companyId,
        JSON.stringify([
          {
            step: 1,
            approver: { type: 'manager', fallback: { type: 'access_level', value: 'admin' } },
            dueHours: 72,
          },
        ]),
      ],
    );

    const type = await admin.post('/api/v1/leave/types', {
      key: `annual-${Date.now()}`,
      name: 'Annual leave (suite)',
      defaultAnnualDays: 25,
    });
    assert.equal(type.status, 201);

    // A public holiday inside the range must not be charged to the person's entitlement.
    await db.pool.query(
      'INSERT IGNORE INTO company_holidays (id, company_id, holiday_date, name) VALUES ($1,$2,$3,$4)',
      [randomUUID(), companyId, '2026-09-07', 'Suite holiday'],
    );

    const before = await admin.get('/api/v1/leave/balances');
    const startingRemaining = Number(
      (before.body.items as { leave_type_id: string; remaining_days: string }[]).find(
        (b) => b.leave_type_id === type.body.id,
      )!.remaining_days,
    );

    // Thu 3rd to Wed 9th: two days, a weekend, a holiday, then two more.
    const booked = await admin.post(
      '/api/v1/leave/requests',
      { leaveTypeId: type.body.id, startDate: '2026-09-03', endDate: '2026-09-09' },
      { 'idempotency-key': `leave-${Date.now()}` },
    );
    assert.equal(booked.status, 201);
    assert.equal(Number(booked.body.working_days), 4);

    // Reserved immediately, which is what stops the same week being booked twice while
    // the first request is still waiting for a decision.
    const after = await admin.get('/api/v1/leave/balances');
    const balance = (after.body.items as { leave_type_id: string; pending_days: string; remaining_days: string }[]).find(
      (b) => b.leave_type_id === type.body.id,
    )!;
    assert.equal(Number(balance.pending_days), 4);
    assert.equal(Number(balance.remaining_days), startingRemaining - 4);

    const overlapping = await admin.post(
      '/api/v1/leave/requests',
      { leaveTypeId: type.body.id, startDate: '2026-09-08', endDate: '2026-09-10' },
      { 'idempotency-key': `leave-overlap-${Date.now()}` },
    );
    assert.equal(overlapping.status, 409);

    // A weekend is not leave, so a weekend-only range is not a request.
    const weekend = await admin.post(
      '/api/v1/leave/requests',
      { leaveTypeId: type.body.id, startDate: '2026-09-05', endDate: '2026-09-06' },
      { 'idempotency-key': `leave-weekend-${Date.now()}` },
    );
    assert.equal(weekend.status, 422);

    // Cancelling gives the days back.
    const cancelled = await admin.post(`/api/v1/leave/requests/${booked.body.id}/cancel`, {
      reason: 'Plans changed',
    });
    assert.equal(cancelled.status, 204);
    const released = await admin.get('/api/v1/leave/balances');
    assert.equal(
      Number(
        (released.body.items as { leave_type_id: string; remaining_days: string }[]).find(
          (b) => b.leave_type_id === type.body.id,
        )!.remaining_days,
      ),
      startingRemaining,
    );
  });

  it('routes approvals to a stand-in while the approver is away', async () => {
    // Unroutable requests refuse outright rather than stranding, so without delegation an
    // approver on holiday blocks everything routed to them. This is the release valve.
    const coverEmail = `cover.${Date.now()}@e2e.test`;
    const cover = await admin.post(
      '/api/v1/users',
      { email: coverEmail, displayName: 'Standing In', accessLevel: 'manager' },
      { 'idempotency-key': `cover-${coverEmail}` },
    );
    assert.equal(cover.status, 201);
    const coverToken = new URL(cover.body.invitation.url).searchParams.get('token')!;
    await new Client(app).post('/api/v1/auth/activate', {
      token: coverToken,
      password: 'Standing-In-Passphrase-2026!',
    });

    // A route naming one specific approver, so the test is about delegation rather than
    // about how a manager chain happens to resolve.
    const away = await admin.post(
      '/api/v1/users',
      { email: `away.${Date.now()}@e2e.test`, displayName: 'Away Approver', accessLevel: 'manager' },
      { 'idempotency-key': `away-${Date.now()}` },
    );
    assert.equal(away.status, 201);
    const awayToken = new URL(away.body.invitation.url).searchParams.get('token')!;
    await new Client(app).post('/api/v1/auth/activate', {
      token: awayToken,
      password: 'Away-Approver-Passphrase-2026!',
    });
    const originalApprover = away.body.user.id as string;

    const definitionKey = `deleg_probe_${Date.now()}`;
    await db.query(
      `INSERT INTO approval_definitions (id, company_id, \`key\`, name, form_schema, routing)
       VALUES ($1,$2,$3,'Delegation probe', JSON_ARRAY(), $4)`,
      [
        randomUUID(),
        companyId,
        definitionKey,
        JSON.stringify([
          { step: 1, approver: { type: 'user', value: originalApprover }, dueHours: 48 },
        ]),
      ],
    );

    const raise = async (title: string) =>
      admin.post(
        '/api/v1/approvals',
        { definitionKey, title, amount: 10 },
        { 'idempotency-key': `deleg-${title}-${Date.now()}` },
      );

    const beforeDelegation = await raise('before-cover');
    assert.equal(beforeDelegation.status, 201);
    assert.equal(
      (await admin.get(`/api/v1/approvals/${beforeDelegation.body.id}`)).body.steps[0].approver_id,
      originalApprover,
    );

    const delegation = await admin.post('/api/v1/delegations', {
      fromUserId: originalApprover,
      toUserId: cover.body.user.id,
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      reason: 'Annual leave',
      reassignExisting: true,
    });
    assert.equal(delegation.status, 201);

    const duringCover = await raise('during-cover');
    assert.equal(
      (await admin.get(`/api/v1/approvals/${duringCover.body.id}`)).body.steps[0].approver_id,
      cover.body.user.id,
    );

    // Withdrawing cover puts the route back where the rule says it should be.
    assert.equal(
      (await admin.del(`/api/v1/delegations/${delegation.body.delegation.id}`)).status,
      204,
    );
    const afterCover = await raise('after-cover');
    assert.equal(
      (await admin.get(`/api/v1/approvals/${afterCover.body.id}`)).body.steps[0].approver_id,
      originalApprover,
    );
  });

  it('confines a guest to what was explicitly granted, and nothing else', async () => {
    // Client work is central here, so guests are real accounts belonging to real people
    // at other companies. The property that matters is negative: a guest holds a row in
    // this company, and must still reach none of it by default.
    const org = await admin.post('/api/v1/external/organizations', {
      name: `Northwind ${Date.now()}`,
      kind: 'client',
    });
    assert.equal(org.status, 201);

    const guestEmail = `contact.${Date.now()}@northwind-external.test`;
    const invited = await admin.post(
      '/api/v1/external/guests',
      { organizationId: org.body.id, email: guestEmail, displayName: 'Dana Cross' },
      { 'idempotency-key': `guest-${Date.now()}` },
    );
    assert.equal(invited.status, 201);

    // A colleague's address must never be turned into a guest: that would demote a real
    // employee to the guest role and strip everything they can reach.
    const internal = await admin.post(
      '/api/v1/external/guests',
      { organizationId: org.body.id, email: ADMIN_EMAIL, displayName: 'Impersonator' },
      { 'idempotency-key': `guest-internal-${Date.now()}` },
    );
    assert.equal(internal.status, 422);

    const guest = new Client(app);
    const token = new URL(invited.body.invitationUrl).searchParams.get('token')!;
    assert.equal(
      (await guest.post('/api/v1/auth/activate', { token, password: 'Guest-Passphrase-2026!' }))
        .status,
      201,
    );
    // Their address belongs to the client, so it will never match a verified domain -
    // sign-in has to resolve the company through the guest account itself.
    assert.equal(
      (await guest.post('/api/v1/auth/login', {
        email: guestEmail,
        password: 'Guest-Passphrase-2026!',
      })).status,
      200,
    );

    // Everything company-wide is closed. Several of these listings scope by company
    // alone, which is correct for an employee and wrong for an external contact, so the
    // guest surface denies them at the boundary rather than trusting each one.
    for (const path of [
      '/api/v1/users',
      '/api/v1/announcements',
      '/api/v1/search?q=a',
      '/api/v1/tasks',
      '/api/v1/chat/rooms',
      '/api/v1/admin/audit',
      '/api/v1/external/organizations',
    ]) {
      const denied = await guest.get(path);
      assert.equal(denied.status, 403, `${path} should be closed to guests, got ${denied.status}`);
    }

    // And they are not a colleague: the directory must not list them.
    const directory = await admin.get('/api/v1/users?limit=100');
    assert.equal(
      (directory.body.items as { email: string }[]).some((u) => u.email === guestEmail),
      false,
    );
  });

  it('moves a departing person\'s work to a successor instead of orphaning it', async () => {
    // Suspension left projects, open tasks and direct reports pointing at someone who
    // would never sign in again, and any approval waiting on them stalled forever. On a
    // platform that holds everything the company has, that is quiet data loss.
    // A dedicated account: offboarding is terminal, so borrowing the shared staff fixture
    // would leave every later test working against a closed account.
    const leaverEmail = `leaver.${Date.now()}@e2e.test`;
    const leaver = await admin.post(
      '/api/v1/users',
      { email: leaverEmail, displayName: 'Departing Colleague', accessLevel: 'staff' },
      { 'idempotency-key': `create-${leaverEmail}` },
    );
    assert.equal(leaver.status, 201);
    const leaverId = leaver.body.user.id as string;

    // Activate them: work is only ever assigned to a live account, and offboarding
    // someone who never signed in would not exercise the transfer at all.
    const leaverToken = new URL(leaver.body.invitation.url).searchParams.get('token')!;
    const activated = await new Client(app).post('/api/v1/auth/activate', {
      token: leaverToken,
      password: 'Departing-Colleague-2026!',
    });
    assert.equal(activated.status, 201);

    const project = await admin.post('/api/v1/projects', {
      name: 'Offboarding probe',
      key: `O${Date.now().toString().slice(-6)}`,
    });
    assert.equal(project.status, 201);

    const task = await admin.post(`/api/v1/projects/${project.body.id}/tasks`, {
      title: 'Work in flight',
      assigneeId: leaverId,
    });
    assert.equal(task.status, 201);

    // The project owner is its creator, so hand it to the departing person directly -
    // the point of the test is the transfer, not how ownership was acquired.
    await db.pool.query('UPDATE projects SET owner_id = $1 WHERE id = $2', [
      leaverId,
      project.body.id,
    ]);

    const result = await admin.post(
      `/api/v1/users/${leaverId}/offboard`,
      { successorId: adminId, reason: 'Left the company' },
      { 'idempotency-key': `offb-${Date.now()}` },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.user.status, 'offboarded');
    assert.ok(result.body.transferred.tasks >= 1);
    assert.ok(result.body.transferred.projects >= 1);

    // Nothing may still point at the departed account.
    const orphanedProjects = await db.one<{ c: number }>(
      'SELECT COUNT(*) AS c FROM projects WHERE owner_id = $1',
      [leaverId],
    );
    assert.equal(Number(orphanedProjects!.c), 0);
    const orphanedTasks = await db.one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM tasks WHERE assignee_id = $1 AND status NOT IN ('done','cancelled')",
      [leaverId],
    );
    assert.equal(Number(orphanedTasks!.c), 0);

    // And the account is closed for good, not merely paused.
    // The account is closed for good: even a fresh activation link cannot revive it.
    const revive = await admin.post(
      `/api/v1/users/${leaverId}/invitation`,
      {},
      { 'idempotency-key': `revive-${Date.now()}` },
    );
    assert.equal(revive.status >= 400, true);

    const repeat = await admin.post(
      `/api/v1/users/${leaverId}/offboard`,
      { successorId: adminId, reason: 'Left the company' },
      { 'idempotency-key': `offb-again-${Date.now()}` },
    );
    assert.equal(repeat.status, 409);
  });

  it('recovers a forgotten password without revealing who has an account', async () => {
    // This is the company's only system: there is no identity provider to fall back on,
    // so recovery has to work. It also must not become an employee directory for anyone
    // who can reach the sign-in page, which is why both answers are identical.
    const caller = new Client(app);
    const known = await caller.post('/api/v1/auth/password/forgot', { email: staffEmail });
    const unknown = await caller.post('/api/v1/auth/password/forgot', {
      email: `nobody-${Date.now()}@e2e.test`,
    });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(known.body, unknown.body);

    // The token never crosses the API boundary; it exists only in the message. The test
    // reads it the way the mail worker would.
    const issued = await identity.requestPasswordReset(staffEmail, {
      ip: '127.0.0.1',
      userAgent: 'e2e',
      correlationId: 'e2e-reset',
    });
    assert.ok(issued);

    const replacement = 'Recovered-By-The-Suite-2026!';
    await identity.completePasswordReset(issued!.token, replacement, {
      ip: '127.0.0.1',
      userAgent: 'e2e',
      correlationId: 'e2e-reset',
    });

    // Single use, and the old credential is genuinely gone.
    await assert.rejects(() =>
      identity.completePasswordReset(issued!.token, 'Another-Passphrase-2026!', {
        ip: '127.0.0.1',
        userAgent: 'e2e',
        correlationId: 'e2e-reset',
      }),
    );

    const withNew = await caller.post('/api/v1/auth/login', {
      email: staffEmail,
      password: replacement,
    });
    assert.equal(withNew.status, 200);
  });

  it('treats a wrong current password as a field error, not a dead session', async () => {
    // A 401 here made the client's global "your session is gone" handler fire, so a
    // single typo signed the person out mid-form with nothing on screen to explain it.
    // The session is valid; only the field is wrong, and it must be reported as such.
    const wrong = await admin.post('/api/v1/auth/password', {
      currentPassword: 'this-is-not-the-password',
      newPassword: 'A-Perfectly-Fine-Passphrase-1!',
    });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error.code, 'unprocessable');
    assert.equal(
      wrong.body.error.fields.some((field: Json) => field.field === 'currentPassword'),
      true,
    );

    // The session must still be usable straight afterwards.
    const stillSignedIn = await admin.get('/api/v1/me');
    assert.equal(stillSignedIn.status, 200);
  });

  it('never leaks internal detail or stack traces in an error body', async () => {
    const response = await admin.get('/api/v1/search?q=');
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('at Object'), false);
    assert.equal(serialized.toLowerCase().includes('postgres'), false);
    assert.equal(serialized.includes('node_modules'), false);
  });
});
