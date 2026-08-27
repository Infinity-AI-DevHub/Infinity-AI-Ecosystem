# Operations

## Environments

Development, staging and production use separate databases, buckets, keys, domains and
credentials. Production personal data is never copied into a lower environment without
approved masking.

## Configuration

Everything comes from the environment; see `apps/api/.env.example`. Required in production:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Managed PostgreSQL with multi-zone HA and PITR |
| `DATA_ENCRYPTION_KEY` | ≥32 characters. Move to a managed KMS and rotate on a schedule. The process refuses to start without it in production. |
| `NOTIFY_DRIVER` | `smtp` or `provider`. `log` is refused in production, because invitations would then silently never arrive. |
| `STORAGE_DRIVER` | `s3` for anything beyond a single node |
| `PUBLIC_URL`, `API_URL` | Used for CORS, cookies and invitation links |
| `TRUST_PROXY` | Enable behind a load balancer so client IPs in the audit trail are real |

## Deployment

Two deployable units from the same image:

```bash
# API instances (stateless, scale horizontally)
WORKERS_ENABLED=false node dist/src/index.js

# Worker instances (scale on queue depth)
node dist/src/workers/index.js
```

Running workers inside the API (`WORKERS_ENABLED=true`) is fine for a small installation
and is the default. Scheduled jobs take a PostgreSQL advisory lock, so running several
instances never duplicates work.

Migrations follow expand → migrate → contract so an old and a new application version can
overlap safely during a rolling deploy. Applied migrations are checksum-guarded: editing
one that has already run is a hard error, because it would silently diverge environments.

- **Liveness**: `GET /health` — process is up, touches nothing.
- **Readiness**: `GET /ready` — dependencies are reachable. Gate traffic on this one.

Shutdown is graceful: the listener stops accepting, in-flight requests finish, workers
stop, then the pool closes, with a hard timeout so a stuck process cannot hang a rollout.

## Monitoring

`GET /api/v1/admin/operations` backs the admin console and exposes what matters:

- Outbox depth and the age of the oldest unprocessed event
- Dead letters in the last 7 days
- Account counts, live sessions, realtime connections
- Which providers are configured — anything reading `log` or `not configured` is a
  development placeholder and is highlighted as such

Alert on user-visible impact rather than isolated errors:

| Signal | Threshold |
|---|---|
| Outbox oldest event age | > 300s |
| Dead letters | any new one |
| Authentication failures | unusual spike (credential stuffing) |
| Backup or restore failure | any |
| `/ready` failing | any instance |

Every alert should link to a dashboard and a runbook and have a named owning team.

## Backup and recovery

The blueprint's targets: **RPO 15 minutes**, **RTO 4 hours**.

- Automated encrypted PostgreSQL backups plus point-in-time recovery.
- Object storage versioning and deletion protection.
- Configuration, infrastructure code and key-recovery procedures are part of the backup —
  a database dump alone is not a system backup.
- Backups are isolated from normal administrator credentials so a compromised admin
  account cannot destroy them.
- **Restore drills are scheduled and timed.** A backup that has never been restored is a
  hypothesis, not a backup. Record the actual recovery time and any data validation gaps.

## Retention

Configured via `RETENTION_*` and enforced by the scheduler:

- Recycled files are purged from object storage after the retention window, unless under
  legal hold. Storage deletion happens before the database record is dropped, so a storage
  failure cannot orphan an object.
- Notifications are cleared on schedule.
- Legal hold blocks deletion outright and is capability-gated.

## Incident response

The application supports the containment actions the blueprint requires:

| Action | How |
|---|---|
| Revoke a user's access instantly | Suspend the account — sessions, tokens and sockets close immediately |
| Revoke one session | Settings → signed-in devices, or the admin API |
| Stop outbound notifications | Unset the provider credential; queued events retry and then dead-letter visibly |
| Disable a provider | Change the driver to `none`; modules degrade visibly instead of failing |
| Preserve evidence | Legal hold on files; the audit trail cannot be edited |

After an incident, record timeline, impact, root cause, corrective actions, owners and
deadlines — without blame.

## Launch checklist

- [ ] Sending domain with SPF, DKIM and DMARC aligned; a test invitation reaches a real inbox
- [ ] `DATA_ENCRYPTION_KEY` in a managed KMS with a rotation schedule
- [ ] Notification sender configured; `NOTIFY_DRIVER` is not `log`
- [ ] Meeting provider credentials in place, or reduced mode accepted in writing
- [ ] Malware scanner reachable; uploads are not recording `skipped`
- [ ] Object storage private, versioned, with deletion protection
- [ ] Backups running; **a timed restore drill has actually been performed**
- [ ] Dashboards, alert routing and on-call rota live and tested
- [ ] Penetration test complete and findings remediated or formally risk-accepted
- [ ] All administrators enrolled in MFA
- [ ] Migration reconciliation signed off; source, imported and skipped counts agree
- [ ] Training delivered, helpdesk scripts and escalation route ready
