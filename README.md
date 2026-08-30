# Infinity Workspace

The system Infinity AI runs on. Meetings, chat, tasks, files, documents, announcements,
approvals, leave, expenses, equipment, HR records, clients and reporting — with the
identity, authorization and audit trail underneath them.

Employees use a **desktop application** for macOS and Windows. A small public website
exists only for people who cannot install it: clients opening a share link, and new
joiners activating an account before they have the app.

Employee email is deliberately **not** part of this system; a separate email application
owns that. The workspace still sends its own transactional messages — activation
invitations, password resets — which is what `NOTIFY_DRIVER` configures.

This is a working full-stack application, not a prototype. Identity, authorization, audit
and retention are enforced on the server; no client is trusted.

---

## What is here

```
apps/
  api/            Node + TypeScript + Fastify + MySQL 8 / MariaDB
    migrations/     Versioned, checksum-guarded SQL migrations
    src/core/       Config, database, authorization, audit, outbox, crypto, realtime
    src/domains/    Identity, calendar, chat, tasks, files, documents, approvals,
                    leave, finance, HR, external collaboration, reports, search
    src/http/       Server, routes, WebSocket gateway
    src/workers/    Outbox dispatcher and scheduled jobs
    src/cli/        Migrations, seeding, break-glass account recovery
    test/           Unit + end-to-end / authorization-matrix tests
  web/            React + TypeScript + Vite
                    One codebase, two bundles: the desktop renderer (all modules) and
                    a slim public build (share links, activation, password reset)
  desktop/        Electron + TypeScript — the client employees actually run
deploy/           nginx configuration for the three sites
docs/             Architecture, security, operations, API, deployment, user guide
```

### The three domains it runs on

| Address | Serves |
|---|---|
| `app-api.iinfinityai.com` | The API. The desktop app talks to this. |
| `app.iinfinityai.com` | Share links, activation, password reset. |
| `updates.iinfinityai.com` | Installers and the update feed. |

## Running it locally

You need Node 20+ and **MySQL 8.0+ or MariaDB 10.4+**. The schema and queries avoid
everything that exists in only one of them — no multi-valued indexes, no `JSON_OVERLAPS`,
no `SKIP LOCKED`, no row-alias upserts — so the same migrations install on either.

```bash
# 1. Database — create it once
mysql -h 127.0.0.1 -P 8889 -u root -proot \
  -e "CREATE DATABASE IF NOT EXISTS ecosystem
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

# utf8mb4_unicode_ci because both databases have it. Tables inherit the database's
# collation rather than naming their own — a table that says CHARSET without COLLATE
# takes the charset's default, which differs between the two, and foreign keys across
# that boundary are then rejected as incompatible.

# 2. API
cd apps/api
cp .env.example .env          # then set DATABASE_URL and DATA_ENCRYPTION_KEY
npm install
npm run migrate
npm run seed                  # prints an activation link for the first administrator
npm run build && npm start

# 3. Workers (second terminal) — mail, scheduled jobs, the outbox
cd apps/api && node dist/src/workers/index.js

# 4. Renderer (third terminal)
cd apps/web
npm install
npm run dev
```

Generate the encryption key with `openssl rand -hex 32`.

### The desktop app

```bash
cd apps/desktop
npm install
npm run dev                   # loads the Vite dev server inside Electron
```

`npm run dev` points the window at `http://localhost:4600` and the API at
`http://localhost:3500`. In a packaged build both are fixed at compile time — a desktop
client that can be repointed at another server is a phishing tool.

### The public website

```bash
cd apps/web
npm run dev:public            # http://localhost:5600
```

Its API origin must be allowed by the server. In development that means
`CORS_EXTRA_ORIGINS=http://localhost:5600` in `apps/api/.env`; in production
`PUBLIC_URL` is the public site, so nothing extra is needed.

## Building the desktop installers

```bash
cd apps/desktop
npm run package               # macOS .dmg (arm64 + x64) and Windows .exe
npm run feed > release/latest.json
```

Builds are **unsigned** by decision. Consequences, both documented in the deployment
guide: macOS needs a one-time Gatekeeper override per version and cannot self-update,
so that path notifies and hands off to the download page; Windows shows a SmartScreen
warning on first install but updates in place.

## Testing

The suite needs its own database, separate from the development one:

```bash
mysql -h 127.0.0.1 -P 8889 -u root -proot \
  -e "CREATE DATABASE IF NOT EXISTS ecosystem_test
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
```

```bash
cd apps/api
export TEST_DATABASE_URL=mysql://root:root@127.0.0.1:8889/ecosystem_test
npm test                      # unit + end-to-end (84 tests)
npm run test:unit             # unit only, no database
npm run test:e2e              # end-to-end only
```

Point `TEST_DATABASE_URL` at a database you are willing to lose — the suite creates and
removes its own company on every run. Without it the end-to-end tests warn loudly and
skip; in CI (`CI=true`) they refuse to start at all, because a suite that quietly skips
itself reports green while covering nothing.

The end-to-end suite runs against a real database and a real HTTP server, and asserts
behaviour rather than implementation: invite → activate → sign in → authorized dashboard,
suspension closing every session immediately, cross-tenant isolation, separation of
duties on expense payment, guest confinement, five-day desktop session ceilings, document
concurrency, working-day leave arithmetic, and equipment left with departed employees.

Typechecking:

```bash
cd apps/api && npm run typecheck
cd apps/web && npm run typecheck     # tsc -b — `tsc --noEmit` here checks nothing
cd apps/desktop && npm run typecheck
```

> `apps/web`'s root tsconfig is `"files": []` with project references, so
> `npx tsc --noEmit` silently checks zero files. Use the script.

## Recovering a locked-out account

This platform is the company's only system: there is no identity provider behind it and
nowhere else to sign in. Two routes back in.

**Self-service** — the sign-in screen's *Forgot password?* issues a single-use link valid
for an hour.

**Break-glass** — when every administrator is locked out:

```bash
cd apps/api
npm run recover -- --email you@iinfinityai.com --reason "locked out after laptop loss"
```

It needs shell access and the database credentials, which is the point. It generates the
passphrase rather than letting an operator under pressure choose one, prints it to the
terminal and nowhere else, revokes every session for that account, and records itself in
`break_glass_events` and the audit trail.

## Deploying

See [`docs/deployment.md`](docs/deployment.md) — a step-by-step guide for Ubuntu 24.04
with aaPanel and pm2, written for someone who has not deployed anything before.

```
ecosystem.config.cjs     pm2 process definitions (API clustered, worker single)
deploy/nginx-*.conf      nginx configuration for each of the three sites
```

## Before production

Two things still need configuring, and one needs deciding. Each has a working adapter and
a visible degraded mode until it is set up.

| Area | What is needed |
|---|---|
| **Object storage** | Cloudflare R2 credentials. The S3 driver presigns without an SDK and works with R2 unchanged — set `STORAGE_DRIVER=s3`, the endpoint, and `S3_REGION=auto`. Local disk is the development default. |
| **Malware scanning** | A ClamAV endpoint. Without it, uploads are recorded as `skipped` rather than silently assumed clean. |
| **Meetings** | LiveKit (or equivalent) credentials. Without them, meetings still schedule and join reports a clear reduced-mode state. |

Transactional mail is configured and sending through the company relay on port 587 with
STARTTLS. `NOTIFY_DRIVER=log` is refused in production, because a driver that accepts a
message and delivers nothing would swallow every activation invitation silently.

Also worth doing before anyone relies on the system:

- **Set the leave entitlements and the public holiday calendar.** The seeded values are
  placeholders, and a missing holiday quietly charges every employee a day of their own
  entitlement.
- **Take a database backup and restore it once.** This platform holds the only copy of
  the company's HR records, approvals, documents and expenses.

## Known gaps

Honest about what is not built:

- **No metrics or tracing.** Structured logs only — no latency histograms, no error-rate
  alerting, no traces across API → outbox → worker.
- **No retention policy management, legal hold, or per-subject data export.** Retention
  runs from configuration on a fixed schedule.
- **No integrations or webhooks.**
- **Fifteen capabilities are granted to roles and never checked**, some naming features
  that do not exist (`recording.read`, `transcript.read`, `backup.view`) and some naming
  controls enforced by a different capability (`company.manage`, `role.assign`). Worth
  resolving — a grant that implies a control it does not enforce is what gets waved
  through an access review.

Two deliberate deviations from the original blueprint, both recorded in
[`docs/security.md`](docs/security.md): PostgreSQL row-level security was lost in the
move to MySQL, and multi-factor authentication was removed at the owner's direction.

## Documentation

- [`docs/deployment.md`](docs/deployment.md) — deploying to a VPS with aaPanel and pm2
- [`docs/Infinity-Workspace-User-Guide.pdf`](docs/Infinity-Workspace-User-Guide.pdf) — every module and operation, for the people using it
- [`docs/architecture.md`](docs/architecture.md) — domains, data flow, key decisions
- [`docs/security.md`](docs/security.md) — the security model and how each control is enforced
- [`docs/operations.md`](docs/operations.md) — backup, incident response, launch checklist
- [`docs/api.md`](docs/api.md) — endpoint reference and conventions
