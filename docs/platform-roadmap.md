# Infinity Workspace — platform audit and roadmap

Status as of 2026-09-13. This is the working map for evolving Workspace into the company
operating platform. It records what exists, what Phase 1 changed, and what each later
phase must reuse instead of rebuilding.

## 1. What exists today

| Layer | Contents |
|---|---|
| API (`apps/api`) | Fastify + TypeScript, MySQL 8 / MariaDB. 33 migrations, ~87 tables, ~260 routes in 15 route files. Deny-by-default `core/authz.ts` (tenant → lifecycle → capability → resource → policy), audit trail, outbox + workers, realtime gateway. |
| Renderer (`apps/web`) | React 19 + React Router 7 + Vite. One codebase builds the desktop renderer and a slim public bundle (share links, activation, reset, client portal). |
| Desktop (`apps/desktop`) | Electron. Keystore-backed session, validated in-app deep links (`ipc.ts` only accepts `/route` paths), OS notifications, dock badge, updater. |

### API route groups

| File | Groups (route count) |
|---|---|
| `collaboration.ts` | announcements 7, approvals 6, calendar 10, chat 14, files 15, messages 2, projects 8, search 1, shares 4, tasks 4 |
| `finance.ts` | assets 6, billing 2, budgets 4, expenses 8, invoices 10, quotations 8, signatures 5, vendors 4 |
| `external.ts` / `portal.ts` | guests & organisations 11, share links 6, client portal 15 |
| `leave.ts`, `hr.ts`, `attendance.ts`, `reminders.ts`, `reports.ts`, `documents.ts` | 17, 11, 7, 7, 6, 13 |
| `auth.ts`, `me.ts`, `users.ts`, `admin.ts` | 10, 10, 10, 14 |

### Roles and capabilities

Access levels: `super_admin`, `admin`, `manager`, `staff`, `auditor`, `guest`, `service`.
Capabilities live in `role_capabilities` (see `migrations/0003` onward); the renderer
reads them from `/me/capabilities` only to hide entries. The server re-checks every call.
`test/ui-coverage.test.ts` fails if a write route has no caller in the interface.

### Capabilities later phases must reuse, not duplicate

- **Assets and vendors** already exist (`asset.*`, `vendor.manage`, `/assets`, `/vendors`). Service-management inventory, warranties and contracts should extend these tables.
- **Approvals** (`approvals.ts`, manager fallback, delegation) are the approval engine for change requests and access requests.
- **Search** (`search_documents` with ACL tokens) — new domains index into it; do not add a second index.
- **Notifications, outbox, realtime** — incidents, SLA breaches and escalations must go through these.
- **Clients / guests / portal** — the client support portal is an extension of `portal.ts`, reusing guest confinement.
- **Offboarding** (`POST /users/:id/offboard`, migration 0008) — exists in the API without UI; access governance should build the UI on it.
- **Transactional mail** (`adapters/notifier.ts`) sends system mail only. Infinity Mail is a separate application; there is currently **no** integration contract with it in this repository (no URL, API, or unread endpoint). Mail deep links and unread counts need that contract defined first.

## 2. Phase 1 — delivered in this change

No permission or route changes; every existing URL still resolves. API additions: one dashboard widget and one data migration (below).

- **Navigation registry** — `apps/web/src/lib/navigation.ts`. One list of areas → modules, with capability, badge and search keywords. Shell, palette, breadcrumbs, favourites and recents all read it.
- **Area rail + contextual sidebar** — `components/Shell.tsx`, `styles/shell.css`. Rail shows only areas with at least one permitted module. Selecting an area previews its modules; the sidebar follows the page again on navigation. Collapsed mode leaves the rail only (clicking an area opens its first module). Collapse state keeps the previous `infinity:sidebar-collapsed` key.
- **Favourites and recently visited** — `lib/nav-preferences.ts`; per user id, local storage, failure-tolerant. Recents keep the full deep link (e.g. `/tasks/abc`).
- **Command palette** — `components/CommandPalette.tsx`. Cmd/Ctrl+K. Recents, permitted modules (favourites first), sidebar toggle, and live workspace search that deep-links to records via the existing server-filtered `/search` endpoint.
- **Breadcrumbs** — area › module above the page title, module linked when inside a record.
- **Keyboard / a11y** — Cmd/Ctrl+K palette, Cmd/Ctrl+\ sidebar, `/` search (unchanged). Combobox/listbox semantics in the palette, focus returned on close, `aria-current`, `aria-pressed`, labelled badges, reduced-motion rules. Narrow windows turn the nav into a drawer.

Area mapping:

| Area | Modules |
|---|---|
| Command | Command centre, Reminders |
| Communication | Chat, Meetings, Announcements, Messages |
| Work | Tasks, Documents, Files, Approvals, Search, Reports |
| Company | People, Attendance, Leave, Clients, Finance, Growth |
| Administration | Admin, My settings |

**Service, Engineering and Security are intentionally absent** from the rail until they contain working modules.

- **Command centre** — `routes/Command.tsx`, `styles/command.css`. "Needs you now" queue (decisions awaiting you, overdue tasks, meetings starting within the hour or needing a reply, overdue client invoices, clock-in on working days) above per-person customisable sections (show/hide/reorder, saved per user). Staff keep `EmployeeHome`. `/me/dashboard` gained a `clients` widget (recent portal uploads; invoice counts need `invoice.read`), omitted entirely for roles without `external_org.read` — covered by an e2e test.
- **Deep-link fixes found in Electron testing** — client contacts in search now link to their organisation (handler + migration `0034_guest_search_links.sql`); `/people/:id` loads a person outside the first page of the list, and routes a client contact to Clients instead of showing staff controls.
- **Retired shell CSS removed** — ~560 lines of `.sidebar`/`.nav-item` rules from `App.css`, `redesign.css`, `desktop.css`; all 1,634 remaining rules verified unchanged and in order.

### Phase 1 verification

Tested in the Electron dev client against the local API as `super_admin`: navigation, palette search → record deep links, breadcrumbs, recents, collapse (⌘\), customisation persistence across reload, 1440×900 and 960×600. The desktop surface is light-only in practice (`redesign.css` pins light tokens; nothing sets `data-theme`). Not exercised: the clock-in priority (testing day was a Sunday), other roles, Windows.

Known pre-existing e2e failures (unchanged by this work): groups membership, restricted document spaces, document attachment upload, guest confinement, offboarding successor hand-over.

### Phase 1 gaps closed (second pass)

- **Notification centre** — `/notifications` (Communication): full history, unread/kind filters, day grouping, cursor paging, mark read / clear individually or all; "View all" from the bell panel.
- **Clients in search** — `client` doc type indexed on create/update/delete (migration `0035` backfills). Search now gates result types by capability (`CAPABILITY_GATED` in `domains/search.ts`): `client` needs `external_org.read`, `ticket` needs `ticket.read`.
- **Infinity Mail** — desktop-only "Infinity Mail" entry (Communication sidebar and palette) launches the installed app through a fixed IPC target (`shell:open-mail`: bundle id `com.iinfinityai.mail` on macOS, installer paths on Windows). Unread counts and deep links into conversations are **not** possible yet: Mail holds IMAP credentials and exposes no URL scheme or API. Required contract: an `infinity-mail://` protocol handler (`/message/<id>`, `/compose?to=`) and, for counts, a local IPC or a server-side unread endpoint that does not require Workspace to hold mailbox passwords.
- **Not done:** visual refresh of individual legacy module pages (outside the new shell, command centre and service pages).

## 2b. Phase 2 — service desk (delivered)

Migration `0036_service_desk.sql`; domain `apps/api/src/domains/service.ts`; routes `http/routes/service.ts`; UI `apps/web/src/routes/service/*`, portal `routes/portal/PortalTickets.tsx`.

- Queues (employee or client audience), queue membership as the technician model, categories, escalation contact.
- Tickets with per-company numbers (`SD-n`), type, priority, status workflow (new → open → pending → resolved → closed, reopen), assignment restricted to people who work the queue, optimistic concurrency (If-Match).
- SLA policies per priority (defaults until configured); first-response and resolution due times; `service-sla` scheduler job flags breaches once, notifies assignee/queue, and escalates resolution breaches to the queue's escalation contact.
- Conversation with public replies and internal notes; attachments through the scanned files domain with ticket-scoped downloads; timeline of every change; requester satisfaction (1–5) once resolved.
- Links: requester (employee or client contact), client organisation, one-click task creation in a project, search indexing, command-centre "Support tickets" section and "Needs you now" items, realtime refresh.
- Client portal: raise, follow, reply, attach, close/reopen and rate; clients see their organisation's tickets and public content only, never internal notes or queue names; email on staff public replies via the outbox.
- Permissions: `ticket.create` (all employee roles), `ticket.read` (admin, super_admin, auditor), `ticket.work` (admin, super_admin), `service.manage` (admin, super_admin); queue members work their queues without a role change. Audit events on every write.
- Analytics: open/unassigned/breached, raised/resolved, average first response and resolution, first-response SLA rate, by queue and priority, CSAT.

**Verification.** 10 end-to-end tests (configuration permissions, SLA due times, visibility to bystanders, internal-note isolation, assignment rules, stale-edit refusal, reopen on requester reply, one-time breach alerts, client confinement and email, role-gated search, cross-tenant 404s). Tested in the Electron dev client as `super_admin`: queue setup, members, categories, escalation, SLA edit, ticket creation on behalf of an employee, take/assign, internal note, public reply, file attach + download, task link, resolve, timeline, notifications, list view, command-centre section, analytics. Fixed during testing: resolve/close timestamps not recorded (MySQL SET ordering), company deletion blocked by ticket foreign keys, requester notified of their own ticket. **Not exercised in the UI:** the client portal pages (no client credentials used; covered by e2e only), roles other than super_admin, MariaDB (MySQL 8 only was available).

### Phase 2 — service management (second pass, delivered)

Migration `0037_service_management.sql`; domains `knowledge.ts`, `changes.ts`, `itam.ts`, `inbound-email.ts` (plus extensions in `service.ts`); routes `http/routes/service-management.ts`; UI `routes/service/Knowledge.tsx`, `Changes.tsx`, `ServiceAssets.tsx`, additions to the ticket page, new-ticket dialog and settings; portal "Help articles".

- **Knowledge base** — internal and client-visible articles, draft → published → archived, sanitized rich text (document allow-list), one vote per person, full-text search, suggestions while raising a ticket, linking articles to tickets. Writers: `kb.write`, `ticket.work`, or any queue member.
- **Request forms** — up to 20 typed fields per category (text, long text, number, date, choice, yes/no; required and help text), validated server-side; answers stored on the ticket and shown as request details. Builder in Desk settings.
- **Problem management** — incidents link to one problem ticket; root cause and workaround recorded on the problem; both sides shown on each ticket.
- **Change management** — standard (pre-approved), normal and emergency changes with risk, impact, implementation/rollback/test plans and a planned window. Submission raises an ordinary request on the existing approvals engine (`change` definition: manager with admin fallback; high risk adds an administrator step via risk-as-amount); the `approval.completed` handler settles the change. Then schedule → start → outcome (successful / failed / rolled back) → close, or cancel (withdraws a pending approval). Changes link to tickets. Readable by everyone with `change.create`; steered by requester, owner or `change.manage`.
- **Assets, licences, contracts** — the Finance equipment and vendor screens are reused, not copied. Software licences (seats enforced, renewal date, cost, where the key is managed — keys are deliberately not stored), holders, vendor contracts with notice periods and a signed document (download authorised by the contract), devices linked to tickets, an "Expiring soon" view, and an hourly job reminding owners 30 and 7 days before warranty end, licence renewal and contract notice deadlines.
- **Email-to-ticket** — a signed webhook (`POST /api/v1/service/inbound-email/:key`, HMAC-SHA256 of `timestamp.body`, 5-minute window, Message-ID idempotency). Known senders open tickets (clients land with their organisation); `[SD-n]` in the subject threads a reply and quoted history is stripped; unknown senders are refused and logged. Secret generated server-side, shown once, stored encrypted, identified by fingerprint; rotate and pause from settings. This is the integration point for Infinity Mail's server or any mail system — Workspace does not receive SMTP itself.

**Verification.** 6 further end-to-end tests (knowledge visibility, sanitising and voting; form validation; problem linking; change routing through the real approvals engine including a genuine step-2 admin, settlement, lifecycle and bystander refusal; licence seats and contract dates; signed/unsigned/replayed/duplicate/unknown-sender email). Full suite 152/157 with the same 5 pre-existing failures. Exercised in the Electron client as super_admin: article write/publish/vote, form builder, ticket with form answers and article suggestion, article and device linking, equipment and vendor creation through the reused screens, standard change full lifecycle, normal change submission refusal message, licence seat limit, contract with uploaded document and download, expiring view, email-to-ticket setup and real signed webhook calls (create, reply threading, refusal, bad signature, replay). **Not exercised in the UI:** approving a normal change (no second active approver exists locally; covered by e2e), portal help articles (no client login), other roles, MariaDB.

**Known limitations / not built:** SLA business-hours calendars and pausing while waiting on the requester; article view counts include the reader's own refreshes; no bulk ticket actions; the ticket side column is long on problem/device-heavy tickets; Infinity Mail itself still needs to call the webhook and expose a URL scheme for deep links.

## 3. Later phases — required shape

Each new domain gets: its own migration(s), `src/domains/<domain>/` service, a route file registered independently (a failing domain must not stop core routes from registering), new capabilities seeded per role, audit events on sensitive writes, search indexing, lazy-loaded renderer routes, an entry in `navigation.ts`, and e2e tests covering tenant isolation and the role matrix.

- **Phase 2 Service** — tickets, queues, request types, SLA policies (worker-driven breach detection via scheduler), knowledge base, extending assets/vendors; email-to-ticket requires an inbound-mail decision (Infinity Mail webhook vs. dedicated mailbox).
- **Phase 3 Reliability** — integrate external monitors (webhook ingestion with signed payloads) rather than building probes; incidents, on-call, status pages, postmortems.
- **Phase 4 Engineering** — service catalogue; GitHub/GitLab via OAuth app / webhooks, tokens encrypted with `core/crypto.ts`.
- **Phase 5 Academy and access governance** — access requests on the approvals engine; secrets vault only after a written threat model.
