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

## 2c. Phase 3 — reliability (delivered)

Migration `0039_reliability`. Capabilities: `reliability.read` (all employees), `incident.declare` (staff and up), `incident.manage` (managers and up), `reliability.manage` (admins).

- **Services** with tier, owner, escalation policy and support queue. Status is derived, never typed: worst open incident impact, else maintenance, else operational; every change is kept in `service_status_history`, which availability is computed from (partial and major outages count as down).
- **On-call** (`core/oncall.ts`): daily or weekly rotations in a named timezone, cover overrides (rotation members may cover themselves; managers may assign anyone).
- **Escalation policies**: up to six levels of schedules or people, delays, repeats; the `incident-escalation` job pages the next level until someone acknowledges, then tells incident managers.
- **Incidents**: declare or open from an alert, page (notification + email + realtime), acknowledge, join, commander, severity, impact per service, internal notes and public updates (commander only), linked tickets, problem ticket, postmortem with a required root cause and action items created as tasks.
- **Alert integrations** — no probes, no outbound calls. Signed webhooks (`X-Infinity-Timestamp`, `X-Infinity-Signature: sha256=HMAC(secret, "ts.body")`, 5-minute window); the secret is shown once. Heartbeats, where the unguessable URL is the credential; the `heartbeat-check` job raises an alert when one is missed. Alerts dedupe by fingerprint; critical opens SEV2, warning opens SEV3 (configurable per integration).
- **Maintenance windows**, optionally linked to a change, public, and silencing paging (alerts are still recorded as suppressed).
- **Public status page** at `/status/:slug`, anonymous and rate-limited; shows only public services, public incidents and public updates, with no severity or internal ids.
- **Reports**: MTTA, MTTR, severity mix, alert volume and suppression, SEV1/2 postmortem coverage, availability per service.
- Command centre: reliability widget, and a "Needs you now" entry for incidents you are paged for and have not acknowledged. Navigation area **Engineering**.

### Phase 3 verification

- API: 9 e2e tests in "reliability" (permissions, paging, commander-only controls, escalation, public page, postmortem, signed alerts and suppression, heartbeats, overrides and tenant isolation); rotation unit tests. Full e2e run: 75 pass, the same 5 unrelated pre-existing failures.
- Electron, as admin against local data: schedule and edit, escalation policy, service, webhook integration; a bad signature is rejected; a signed critical alert opened INC-1 and paged the on-call admin (notification + command centre); acknowledge, commander, public update; public page viewed signed out; alert resolve; incident resolve; postmortem published with task ROLL-1; maintenance window suppressed a critical alert and showed on the page, then cancelled; cover added and removed; heartbeat integration received a beat, and an unknown key is refused; a backdated heartbeat was caught by the running scheduler within a minute (INC-2 opened, admin paged) and the next beat resolved the alert; report figures matched.
- Not verified: the paging email actually arriving (no mail delivery locally) and paging a second real person (single admin account by agreement).

## 2d. Phase 4 — engineering (delivered; teams and projects added in 0041)

Migration `0040_engineering`. Capabilities: `engineering.read` (all employees), `engineering.manage` (managers and up), `deployment.record` (staff and up), `scm.manage` (admins; connections hold webhook secrets). A service's owner may maintain its own catalogue entry.

- **Software catalogue** extends the Phase 3 `services` table (kind, lifecycle, language) — one list for health and for ownership. Entries carry owner, description, dependencies (cycles refused), runbooks and docs (a web link or a knowledge base article), environments, APIs, repositories, deployments and an onboarding checklist.
- **API catalogue**: protocol, version, audience, lifecycle, spec and docs links; searchable (`api` search type).
- **Source control by webhook, not OAuth**: a GitHub connection verifies `X-Hub-Signature-256`; GitLab compares `X-Gitlab-Token`. Delivery ids (or a body hash) make redeliveries no-ops. Repositories appear from their first event and are linked to a service by a manager or the service owner. Push, pull/merge request and deployment status events are recorded. No provider token is stored and no outbound call is made. OAuth apps were not built: they need a registered app per provider and add nothing the webhooks do not already give.
- **Deployments** from GitHub/GitLab (one row per provider deployment, updated as its status changes, environment created on first sight) or recorded by hand, optionally against a change. Change failure rate and deploys per week; production releases of critical/high services with no change record are flagged; a failed production release notifies the service owner; incidents list deployments to affected services in the preceding day.
- **Scorecards** computed from facts on every read (`core/scorecard.ts`): 11 rules, non-applicable rules left out of the score, gold/silver/bronze/needs work.
- **Templates** set kind, tier, environments and the onboarding checklist for new services.
- Command centre: "Services I own" widget and a "Needs you now" entry for a failed production release in the last day.

### Phase 4 verification

- API: 9 unit tests (payload mapping incl. unsafe links, environment kinds, scorecard scoring) and 6 e2e tests in "engineering" (template to checklist and environments, owner vs manager edits, cycles, link validation, API conflicts, signed GitHub events with replay and secret rotation, GitLab token and pause, deployment status updates, owner notification, change failure rate, incident correlation, tenant isolation, guests). Full e2e: 81 pass, the same 5 unrelated pre-existing failures.
- Electron, as admin against local data: template created; Payments API created from it (checklist and environments seeded); knowledge base article linked as runbook; dependency on Customer portal; checklist ticked; API v1 added; GitHub connection created in the UI with setup instructions; signed ping, push, duplicate delivery (ignored), pull request opened and merged, deployment ignored until linked, repository linked in the UI, failed and successful production deployments recorded and the owner notified; a manual deployment recorded; incident declared showing the deployments before it; scorecards, API catalogue, deployments feed, search and command centre checked.
- Not verified: a real GitHub or GitLab instance sending to this machine (payloads were built to the providers' documented formats and signed the same way), the GitLab flow in the desktop app (covered by e2e only), and a non-admin owner using the UI (single admin account by agreement; owner rules are covered by e2e).

## 2e. Phase 5 — academy and access governance (delivered)

Migrations `0041_service_teams_and_projects` (closes the Phase 4 gap: services belong to a team and a project) and `0042_academy_and_access`. Capabilities: `academy.learn` (employees), `academy.manage` (managers and up), `policy.manage`, `access.manage` (admins), `access.request` (employees), `access.audit` (admins and auditors, read only). System owners approve and carry out access for their own systems without `access.manage`.

**Academy**
- Courses with lessons and an optional quiz. Answers are marked on the server and never sent to learners. A course completes only when every lesson is done and the quiz is passed.
- Completing a certifying course issues the certification, with an expiry counted in calendar months, and confirms the skills the course develops. It never lowers a level someone already has. Someone can retake a course within 60 days of their certification expiring.
- Assigning a course to people or a group with a due date; per-course progress report; reminders for training due soon and overdue, and for certifications expiring within 30 days.
- Outside certifications, verified by an academy manager who is not the holder.
- Skills register: people assess themselves, and their manager (or an academy manager) confirms it. Changing a level clears the earlier confirmation.
- Policies are versioned. An acknowledgement is of one exact published text, and a new version asks the audience (everyone, or one group) again. Coverage report and weekly reminders once overdue.

**Access governance**
- Systems catalogue: roles, risk, owner, linked service, longest allowed grant, and an optional required course that must be complete and not expired.
- Requests go through the existing approvals system. The route is the requester's manager, then the system owner, then an administrator for high-risk systems (falling back to a super administrator when no admin exists).
  - The approvals system gained a `request_user` approver type, which takes the approver from the request itself. That is how a request reaches the right owner.
  - Owners without `decision.make` may decide access requests only, and only when a step names them. No other request type's permissions changed.
- Grants record what was done, not only what was approved:
  - pending_grant → active only when the owner confirms it is set up (a temporary grant's clock starts then);
  - active → pending_removal when it expires, is revoked, is revoked in review, or the person is offboarded;
  - pending_removal → removed only when the owner confirms.
  - Existing access can be recorded so it can be reviewed.
- Access reviews: each grant goes to the system owner, or to the person's manager when the owner holds it. Nobody reviews their own access, revoking needs a reason, and a review closes only when every grant has a decision.
- Offboarding (the existing flow in People) now also, through the outbox:
  - turns the person's access into removal tasks for each system owner, and their assigned equipment into collection tasks;
  - moves ownership of services, systems, courses and policies to the successor;
  - reassigns their open review items and cancels their pending access requests.
  Custom tasks can be added.
- Command centre: training and policies widget; "Needs you now" for overdue training, policies, access to carry out, reviews and offboarding tasks.

**Secrets management** is not built. `docs/secrets-vault-threat-model.md` is the threat model and go/no-go for a separate, security-reviewed milestone. It recommends starting by integrating an existing vault rather than storing secret values.

### Phase 5 verification

- API: 4 unit tests (quiz marking, certification expiry across short months and leap years, temporary grant end, reviewer choice) and 9 end-to-end tests in "academy and access governance". They cover:
  - drafts and answers hidden from learners, group assignment, earned completion with certification and skill;
  - outside certifications and skills verified by someone else, policy versions;
  - manager-then-owner approval with the training gate, high-risk third step, temporary expiry and owner-confirmed removal;
  - review rules, offboarding tasks and ownership transfer through the real outbox handler;
  - tenant isolation, guests, and services linked to teams and projects.
  Full end-to-end run: 90 pass, the same 5 unrelated pre-existing failures.
- Electron, as admin against local data:
  - skill added; certifying course built with lessons and a quiz, then published; taken with one failed and one passed attempt; completed with the certification and skill issued;
  - policy written, published, acknowledged, and a second version asked everyone again;
  - outside certification added; skill self-assessed;
  - two systems added; an access request with too long a duration was refused; a valid one was routed to the admin's manager, then the owner;
  - existing access recorded, revoked and confirmed removed; review revoked a grant with a reason and closed;
  - a test employee was offboarded in People, the running dispatcher created the removal and collection tasks and moved service ownership, and all tasks were completed;
  - command centre items and 1000px layout checked.
- Found and fixed while verifying:
  - the quiz result disappeared because a data reload remounted the player;
  - skills confirmed by a course showed as self-assessed;
  - the request confirmation wording.
- Not verified: approving or deciding as a non-admin owner or manager in the desktop app (single admin account by agreement; covered by end-to-end tests).

### Closing pass

- The 5 end-to-end failures that predated this work are fixed; they were stale tests, not product faults:
  - group membership now uses PATCH with `addUserIds`;
  - the suspension test signs the shared staff account back in;
  - per-IP activation counters are reset before activation-heavy tests;
  - guests are deliberately denied `/tasks` (clients reach work through the portal).
  Full run: 95 pass, 0 fail.
- Reminders on the real scheduler: back-dated data in the local database, restarted the API, and within 30 seconds the running jobs sent the training-due, certification-expiring and policy-overdue reminders, and expired a temporary grant.
- That run exposed a flaw, now fixed and tested: an owner holding access to their own system was asked to confirm its removal. That work now goes to administrators, and nobody can confirm removal of their own access.
- Email: the configured relay (`mail.iinfinityai.com:587`) accepts STARTTLS, authentication, the sender and the recipient. The check stops at RSET, so nothing was sent. Paging outbox events for unacknowledged incidents were processed without error, so those emails were submitted. Arrival in an inbox was not observed.
- Keyboard: six dialogs did not move focus into themselves, so Escape could not close them. Fixed and re-checked in Electron.
- Dark mode: the desktop visual system is light only, but with macOS in dark mode the shared tokens turned dark under a light canvas and headings became unreadable on every page. The desktop surface now pins the light theme; checked in Electron with dark mode emulated.


## 3. Later phases — required shape

Each new domain gets: its own migration(s), `src/domains/<domain>/` service, a route file registered independently (a failing domain must not stop core routes from registering), new capabilities seeded per role, audit events on sensitive writes, search indexing, lazy-loaded renderer routes, an entry in `navigation.ts`, and e2e tests covering tenant isolation and the role matrix.

- **Phase 2 Service** — tickets, queues, request types, SLA policies (worker-driven breach detection via scheduler), knowledge base, extending assets/vendors; email-to-ticket requires an inbound-mail decision (Infinity Mail webhook vs. dedicated mailbox).
- **Phase 3 Reliability** — delivered, see 2c.
- **Phase 4 Engineering** — delivered, see 2d.
- **Phase 5 Academy and access governance** — delivered, see 2e. Secrets vault: threat model only (`docs/secrets-vault-threat-model.md`).

## Verification pass (2026-09-14)

Every module across the five phases was exercised in the running Electron app, signed in as the local admin, through create, read, update and delete where the record allows it.

Delete was added wherever it was missing. Records with history still refuse deletion, and the error names the alternative (archive, cancel or retire).

### Bugs found and fixed

**Shared query cache**
- Screens remounted mid-refresh and lost confirmations and quiz results.
- A page title stayed stale after saving.

**Edits that failed or were ignored**
- A group rename with an empty description was rejected.
- Expense category edits were rejected: yes/no values were sent as text.
- Cleared vendor, asset and category fields were ignored.

**Lists that didn't refresh**
- Share links didn't refresh after one was created.
- A new access request didn't appear under My requests.

**Other fixes**
- Deactivated expense categories disappeared from settings, so they could never be turned back on. Budget managers now see them.
- Organisation status "Upcoming" and "Completed" failed with 422. The page swallowed the error and deleted organisations without asking.
- The organisation edit dialog stayed open after leaving the organisation.
- The Docs page stuck on "Loading" when there were no spaces.
- Guest grants accepted any capability or resource.
- An attendance session closed automatically could end before it started.

### Results
- **Tests:** API unit and e2e suites 213/213, plus regression tests for the fixes above.
- **Builds:** web and public builds pass.
- **Route sweep:** clean apart from the intentional not-found checks.

### Not verified in the UI
- **Other roles:** only the admin account was used. Staff, manager, auditor and guest behaviour, including the client portal, is covered by e2e tests only.
- **Actions that would contact someone:** invitations and account suspension were left untested so no real email was sent.
- **Approvals needing a second person:** access requests route to someone other than the requester, so that step is covered by e2e only.
