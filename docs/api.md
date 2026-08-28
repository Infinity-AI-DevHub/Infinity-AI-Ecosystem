# API reference

Base path `/api/v1`. All responses are JSON. Health endpoints are unversioned.

## Conventions

**Authentication** — an HttpOnly session cookie, or `X-API-Token` for service integrations.
A service token is additionally narrowed to its own capability scope.

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
| 403 | Authenticated but not permitted |
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
| POST | `/auth/login` | Password only; returns an authenticated session |
| POST | `/auth/activate` | Consumes a single-use invitation and sets the password |
| POST | `/auth/logout` · `/auth/password` | Password change revokes all sessions |
| GET/DELETE | `/auth/sessions` · `/auth/sessions/:id` | List and revoke your own sessions |

### Current user
`GET /me` · `GET /me/capabilities` · `GET /me/dashboard` · `PATCH /me`
`GET /me/notifications` · `POST /me/notifications/:id/read` · `POST /me/notifications/read-all`

### People
`GET /users` · `GET /users/:id` · `POST /users` · `PATCH /users/:id`
`POST /users/:id/suspend` · `POST /users/:id/reactivate`
`POST /users/:id/invitation` · `GET /departments`

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
`GET /files` (`?recycled=true` for the recycle bin) · `GET|POST /files/folders` · `POST /files/uploads` → `POST /files/uploads/:id/content`
`GET /files/:id/download` (short-lived signed URL) · `GET /files/:id/versions`
`POST /files/:id/share` · `DELETE /files/:id` · `POST /files/:id/restore` · `POST /files/:id/legal-hold`

### Approvals
`GET /approvals/definitions` · `GET|POST /approvals` *(idempotent)* · `GET /approvals/:id`
`POST /approvals/:id/decisions` *(idempotent)* · `POST /approvals/:id/cancel`

### Announcements, search, administration
`GET|POST /announcements` · `POST /announcements/:id/read` · `GET /announcements/:id/stats`
`DELETE /announcements/:id` *(withdraw)*
`GET /search?q=&types=&limit=`
`GET|PATCH /admin/company` (name, legal name, settings) · `POST /admin/company/domains`
`GET|POST /admin/groups` · `PUT /admin/groups/:id/members` · `GET /admin/operations`
`GET /audit/events` · `GET /audit/export`

### Realtime
`GET /api/v1/ws` — authenticate, then `{"action":"subscribe","channel":"room:<uuid>"}`.
Channels are authorized server-side at subscribe time; naming one is not enough.
Frames: `{ channel, type, data, at }`.

### Not present
There are no mail endpoints. Employee email lives in a separate application; this system
only sends its own transactional notifications, which have no inbound API surface and no
provider webhook.
