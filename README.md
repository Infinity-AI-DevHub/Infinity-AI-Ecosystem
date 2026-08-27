# Infinity Workspace

An internal company workspace: calendar and meetings, chat, tasks, files, approvals,
announcements, directory, search and administration — built to the *Infinity Workspace
Complete System Blueprint*.

Employee email is deliberately **not** part of this system; a separate email application
owns that. The workspace still sends its own transactional messages (activation
invitations and security notices), which is what `NOTIFY_DRIVER` configures.

This is a working full-stack application, not a prototype. Identity, authorization,
audit and retention are enforced on the server; the browser is never trusted.

---

## What is here

```
apps/
  api/         Node + TypeScript + Fastify + MySQL 8
    migrations/  Versioned, checksum-guarded SQL migrations
    src/core/    Config, database, authorization, audit, outbox, crypto, realtime
    src/domains/ Identity, calendar, chat, tasks, files, approvals, announcements, search…
    src/http/    Server, routes, WebSocket gateway
    src/workers/ Outbox dispatcher and scheduled jobs
    test/        Unit + end-to-end / authorization-matrix tests
  web/         React + TypeScript + Vite single-page application
docs/          Architecture, security, operations and API reference
```

## Running it locally

You need Node 20+ and MySQL 8.0+ (8.0 is required for `SKIP LOCKED`, JSON functions,
CHECK constraints and multi-valued indexes).

```bash
# 1. Database — create it once
mysql -h 127.0.0.1 -P 8889 -u root -proot \
  -e "CREATE DATABASE IF NOT EXISTS ecosystem
      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"

# 2. API
cd apps/api
cp .env.example .env          # then set DATABASE_URL and DATA_ENCRYPTION_KEY
npm install
npm run migrate
npm run seed                  # prints an activation link for the first administrator
npm run build && npm start

# 3. Web (second terminal)
cd apps/web
npm install
npm run dev
```

Open the activation link the seed printed, set a password, then sign in at
<http://localhost:5173>.

Generate the encryption key with:

```bash
openssl rand -hex 32
```

### With Docker

```bash
docker compose up -d          # mysql, minio, clamav
```

## Testing

```bash
cd apps/api
npm test                      # unit + end-to-end, needs TEST_DATABASE_URL
```

The end-to-end suite runs against a real database and a real HTTP server, and asserts
the blueprint's acceptance criteria directly: invite → activate → sign in →
authorized dashboard, suspension closing every session immediately, cross-tenant
isolation, separation of duties, optimistic concurrency and idempotent retries.

## Before production

The application is complete, but three things are deployment decisions only you can
make. Each has a working adapter and a visible degraded mode until configured:

| Area | What is needed |
|---|---|
| **Transactional email** | An SMTP relay or provider so activation invitations actually arrive, with SPF, DKIM and DMARC aligned on your sending domain. `NOTIFY_DRIVER=log` is refused in production. |
| **Meetings** | LiveKit (or equivalent) credentials. Without them, meetings still schedule and join reports a clear reduced-mode state. |
| **Malware scanning** | A ClamAV endpoint. Without it, uploads are recorded as `skipped` rather than silently assumed clean. |

See `docs/operations.md` for the full launch checklist.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — domains, data flow, key decisions
- [`docs/security.md`](docs/security.md) — the security model and how each control is enforced
- [`docs/operations.md`](docs/operations.md) — deployment, backup, incident response, launch checklist
- [`docs/api.md`](docs/api.md) — endpoint reference and conventions
