# Architecture

## Shape

A modular monolith plus workers, exactly as the blueprint's risk register recommends:
premature microservices would slow delivery and create distributed failure modes without
a measured need. Domains have hard internal boundaries, so any one can be extracted
later when scale or ownership actually justifies it.

```
Browser (React SPA)
   │  HTTPS  ── JSON over /api/v1, session cookie + CSRF header
   │  WSS    ── authorized channel subscriptions
   ▼
Fastify API  ──────────────┐
   │                       │  emits domain events in the same transaction
   ├── domains/            ▼
   │     identity      outbox_events (PostgreSQL)
   │     calendar           │
   │     chat               │  claimed with SKIP LOCKED
   │     tasks              ▼
   │     files         Worker: dispatcher + scheduler
   │     approvals          │
   │     announcements      ├── activation invitations
   │     search             ├── notification fan-out
   │     admin              ├── search indexing
   │                        └── reminders, retention, escalation
   ▼
PostgreSQL          Object storage (S3-compatible or local)
                    Notification sender · Meeting provider · Malware scanner
```

## Why the outbox

A state change and the work it triggers must not be able to diverge. Creating an account,
for example, writes the user row, the invitation and an `outbox_events` row in one
transaction. If the notification provider is down, the account and its invitation still
exist and delivery is retried with backoff; the invitation cannot be silently lost.
Handlers are written to be idempotent because an event can be delivered more than once
after a crash.

## Authorization

`src/core/authz.ts` is the single decision point. Every request evaluates, in order:

1. **Tenant scope** — actor and resource must share a company.
2. **Lifecycle** — suspended or offboarded accounts are denied before anything else.
3. **Capability** — the role must grant the action category (see appendix A of the blueprint).
4. **Resource authorization** — membership, ownership or an explicit grant on the target.
5. **Policy conditions** — step-up MFA for destructive actions, separation of duties.

A role name never grants access to a specific record on its own. An explicit `deny` grant
always beats an `allow`. Administrators may reach company resources they do not belong
to, but only for capabilities their role already carries, and every such access is audited.

**Step-up** is a property of the *session*, not the role: an administrator signed in with a
password only cannot create users, change roles or export the audit trail until they have
satisfied a second factor. This is enforced server-side and covered by tests.

## Data model notes

- Every business table carries `company_id`; every tenant-scoped query filters on it.
- Concurrent edits use a `version` column with `If-Match` / ETag preconditions, returning
  `412` rather than silently overwriting someone else's work.
- `audit_events` and `approval_decisions` are append-only, enforced by a database trigger.
  `UPDATE` is refused unconditionally; `DELETE` is refused unless a transaction explicitly
  opts in via `infinity.purge`, which only tenant removal and approved retention do.
- Lifecycle states are explicit (`processing`, `quarantined`, `active`, `recycled`,
  `legal_hold`, `expired`) rather than a boolean `deleted` flag, because the difference
  between them carries legal meaning.

## Realtime

WebSocket channels are authorized at subscribe time against the database, not at publish
time. Naming a channel is not enough to join it. Suspension closes a user's sockets
immediately rather than waiting for a token to expire, and a reconnecting client is
re-authorized from scratch — so access revoked while offline is not restored.

The database stays authoritative: frames announce that something changed, and the client
reconciles by refetching. Chat messages carry a monotonic per-room sequence so a
reconnecting client catches up exactly, with no gaps or duplicates.

## Provider boundaries

Transactional email, meeting media and malware scanning sit behind adapter interfaces
(`src/adapters/`). The blueprint is explicit that building mail hosting or WebRTC media
infrastructure from scratch is the wrong trade. Employee mailboxes now live in a separate
application entirely, and what remains here is the workspace's own outbound notifications.
Every adapter has a degraded mode that is visible in the interface rather than silently
failing.

Removing the mail module was also a privacy improvement: the workspace is no longer a
second copy of everyone's correspondence, which shrinks both the breach blast radius and
the retention obligation.

## Frontend

- `lib/api.ts` — one place owns credentials, CSRF, the error envelope and version
  preconditions.
- `lib/query.ts` — a small keyed cache with deduplication, explicit invalidation and
  realtime reconciliation. Server state and local UI state stay separate.
- `lib/session.tsx` — current user and capabilities, fetched at startup and refreshed
  after changes. Route guards are a navigation convenience; the API remains authoritative.
- No credentials or message content are ever written to `localStorage`. The session lives
  in an HttpOnly cookie the script cannot read.
