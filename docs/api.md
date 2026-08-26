# API reference

Base path `/api/v1`. All responses are JSON. Health endpoints are unversioned.

## Conventions

**Authentication** — an HttpOnly session cookie, or `X-API-Token` for service integrations.
A service token is additionally narrowed to its own capability scope and can never perform
step-up-protected actions, because it has no interactive session.

**CSRF** — every cookie-authenticated state change must echo the readable `iw_csrf` cookie
in an `X-CSRF-Token` header.

**Errors** — one envelope everywhere:

```json
{
  "error": {
    "code": "unprocessable",
    "message": "Request validation failed",
    "fields": [{ "field": "email", "message": "Must be a valid email address" }],
    "correlationId": "0f5c…"
  }
}
```

| Status | Meaning |
|---|---|
| 400 / 422 | Malformed request / validation failed (`fields` explains which) |
| 401 | Not authenticated, or the session was revoked |
| 403 | Authenticated but not permitted, or step-up MFA required |
| 404 | Not found — also returned for another tenant's records, deliberately |
| 409 | Conflict (double booking, already decided, dependency open) |
| 412 | `If-Match` version precondition failed |
| 429 | Rate limited; see `Retry-After` |
| 503 | A dependent provider is unavailable |

**Concurrency** — reads return an `ETag`; send it back as `If-Match` to avoid overwriting
a concurrent edit.

**Idempotency** — retry-sensitive commands accept `Idempotency-Key`; a replay returns the
original response with `Idempotent-Replay: true`. Required in production.

**Pagination** — opaque cursors: `?limit=25&cursor=…`, response carries `nextCursor`.

## Endpoints

### Authentication
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | Returns `authenticated`, or `mfa_required` with a challenge token |
| POST | `/auth/mfa/verify` | Authenticator code or a single-use recovery code |
| POST | `/auth/activate` | Consumes an invitation; returns the MFA secret and recovery codes **once** |
| POST | `/auth/mfa/confirm` | Confirms enrolment |
| POST | `/auth/logout` · `/auth/password` | Password change revokes all sessions |
| GET/DELETE | `/auth/sessions` · `/auth/sessions/:id` | List and revoke your own sessions |

### Current user
`GET /me` · `GET /me/capabilities` · `GET /me/dashboard` · `PATCH /me`
`GET /me/notifications` · `POST /me/notifications/:id/read` · `POST /me/notifications/read-all`

### People
`GET /users` · `GET /users/:id` · `POST /users` *(step-up)* · `PATCH /users/:id`
`POST /users/:id/suspend` *(step-up)* · `POST /users/:id/reactivate` *(step-up)*
`POST /users/:id/invitation` · `GET /departments`

### Mail
`GET /mail/mailboxes` · `GET /mail/messages` · `GET /mail/messages/:id`
`POST /mail/messages` *(idempotent)* · `PATCH /mail/messages/:id` · `POST /mail/messages/:id/move`

### Calendar and meetings
`GET|POST /calendar/events` · `GET|PATCH|DELETE /calendar/events/:id`
`POST /calendar/events/:id/rsvp` · `POST /calendar/events/:id/join` · `GET /calendar/freebusy` · `GET /calendar/rooms`

### Chat
`GET|POST /chat/rooms` · `POST /chat/direct` · `GET|POST /chat/rooms/:id/messages`
`PATCH|DELETE /chat/rooms/:id/messages/:messageId` · `POST /chat/rooms/:id/read`
`GET|POST /chat/rooms/:id/members` · `POST /chat/rooms/:id/messages/:messageId/reactions`

### Tasks
`GET|POST /projects` · `GET /tasks` · `POST /projects/:id/tasks`
`GET|PATCH /tasks/:id` · `POST /tasks/:id/comments`

### Files
`GET /files` · `GET|POST /files/folders` · `POST /files/uploads` → `POST /files/uploads/:id/content`
`GET /files/:id/download` (short-lived signed URL) · `GET /files/:id/versions`
`POST /files/:id/share` · `DELETE /files/:id` · `POST /files/:id/restore` · `POST /files/:id/legal-hold`

### Approvals
`GET /approvals/definitions` · `GET|POST /approvals` *(idempotent)* · `GET /approvals/:id`
`POST /approvals/:id/decisions` *(idempotent)* · `POST /approvals/:id/cancel`

### Announcements, search, administration
`GET|POST /announcements` · `POST /announcements/:id/read` · `GET /announcements/:id/stats`
`GET /search?q=&types=&limit=`
`GET|PATCH /admin/company` · `POST /admin/company/domains` *(step-up)*
`GET|POST /admin/groups` · `PUT /admin/groups/:id/members` · `GET /admin/operations`
`GET /audit/events` · `GET /audit/export` *(step-up)*

### Realtime
`GET /api/v1/ws` — authenticate, then `{"action":"subscribe","channel":"room:<uuid>"}`.
Channels are authorized server-side at subscribe time; naming one is not enough.
Frames: `{ channel, type, data, at }`.

### Webhooks
`POST /webhooks/mail` — requires `X-Webhook-Signature` (HMAC-SHA256 over
`timestamp.body`) and `X-Webhook-Timestamp` inside a 5-minute replay window.
