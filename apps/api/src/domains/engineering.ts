/**
 * Engineering: the software catalogue, its APIs, environments and deployments, the link to
 * source control, onboarding templates and scorecards.
 *
 * The catalogue is the Phase 3 `services` table. Reliability owns health and paging; this
 * module owns what a service is, who owns it, where its code and docs are, and how it
 * ships. A service's owner may maintain its entry; engineering managers may maintain any.
 *
 * Source control arrives by webhook from GitHub or GitLab (see core/scm.ts for what each
 * event means). Nothing here calls a provider, so no provider token is held.
 */
import { randomBytes } from 'node:crypto';
import { many, newId, one, parseJson, pool, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, unauthenticated, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { decryptField, encryptField, generateToken, hmacSignature, safeEqual, sha256 } from '../core/crypto.js';
import { environmentKind, githubEvent, gitlabEvent, type ScmEvent } from '../core/scm.js';
import { evaluateScorecard, SCORECARD_RULES, type Scorecard, type ScorecardFacts } from '../core/scorecard.js';
import * as notifications from './notifications.js';
import * as searchIndex from './search.js';
import { saveService } from './reliability.js';

type Kind = 'service' | 'website' | 'library' | 'job' | 'data' | 'mobile';
type Lifecycle = 'experimental' | 'production' | 'deprecated';
type Tier = 'critical' | 'high' | 'standard';
type DeploymentStatus = 'in_progress' | 'succeeded' | 'failed' | 'rolled_back';

const placeholders = (n: number, start = 1) => Array.from({ length: n }, (_, i) => `$${i + start}`).join(',');

function requireRead(actor: Actor) {
  if (actor.accessLevel === 'guest') throw forbidden();
  return authorize({ actor, capability: 'engineering.read', resourceless: true });
}

type ServiceRow = {
  id: string; company_id: string; name: string; slug: string; description: string | null; tier: Tier; kind: Kind; lifecycle: Lifecycle;
  language: string | null; owner_user_id: string | null; escalation_policy_id: string | null; status: string; is_active: number;
  team_group_id: string | null; project_id: string | null;
};

async function loadService(actor: Actor, id: string): Promise<ServiceRow> {
  await requireRead(actor);
  const row = await one<ServiceRow>('SELECT * FROM services WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!row) throw notFound('Service not found');
  return row;
}

const canEdit = (actor: Actor, svc: { owner_user_id: string | null }) => hasCapability(actor, 'engineering.manage') || (svc.owner_user_id !== null && svc.owner_user_id === actor.userId);

async function loadEditable(actor: Actor, id: string): Promise<ServiceRow> {
  const svc = await loadService(actor, id);
  if (!canEdit(actor, svc)) throw forbidden('Only the service owner or an engineering manager can change this');
  return svc;
}

async function assertEmployee(companyId: string, userId: string | null | undefined, field: string) {
  if (userId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND access_level <> 'guest' AND status = 'active'", [userId, companyId]))) {
    throw unprocessable('Person not found', [{ field, message: 'Choose an active employee' }]);
  }
}

async function assertTeamAndProject(companyId: string, input: { teamGroupId?: string | null; projectId?: string | null }) {
  if (input.teamGroupId && !(await one('SELECT 1 FROM `groups` WHERE id = $1 AND company_id = $2', [input.teamGroupId, companyId]))) {
    throw unprocessable('Team not found', [{ field: 'teamGroupId', message: 'Choose a team' }]);
  }
  if (input.projectId && !(await one("SELECT 1 FROM projects WHERE id = $1 AND company_id = $2 AND status = 'active'", [input.projectId, companyId]))) {
    throw unprocessable('Project not found', [{ field: 'projectId', message: 'Choose an active project' }]);
  }
}

/** Teams a service can belong to: the company's groups. */
export async function listTeams(actor: Actor) {
  await requireRead(actor);
  return many<{ id: string; name: string }>('SELECT id, name FROM `groups` WHERE company_id = $1 ORDER BY name', [actor.companyId]);
}

function httpUrl(value: string | null | undefined, field: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(v)) throw unprocessable('Links must start with http:// or https://', [{ field, message: 'Enter a web address' }]);
  return v.slice(0, 500);
}

/* --------------------------------------------------------------- scorecards */

async function scorecards(companyId: string, serviceIds: string[]): Promise<Map<string, Scorecard>> {
  const out = new Map<string, Scorecard>();
  if (serviceIds.length === 0) return out;
  const ids = placeholders(serviceIds.length, 2);
  const count = async (sql: string) => new Map((await many<{ id: string; n: number }>(sql, [companyId, ...serviceIds])).map((r) => [r.id, Number(r.n)]));
  const services = await many<ServiceRow>(`SELECT * FROM services WHERE company_id = $1 AND id IN (${ids})`, [companyId, ...serviceIds]);
  const integrations = await count(`SELECT service_id AS id, COUNT(*) AS n FROM alert_integrations WHERE company_id = $1 AND is_active = 1 AND service_id IN (${ids}) GROUP BY service_id`);
  const runbooks = await count(`SELECT service_id AS id, COUNT(*) AS n FROM service_links WHERE company_id = $1 AND kind = 'runbook' AND service_id IN (${ids}) GROUP BY service_id`);
  const repos = await count(`SELECT service_id AS id, COUNT(*) AS n FROM repositories WHERE company_id = $1 AND service_id IN (${ids}) GROUP BY service_id`);
  const prodEnvs = await count(`SELECT service_id AS id, COUNT(*) AS n FROM service_environments WHERE company_id = $1 AND kind = 'production' AND service_id IN (${ids}) GROUP BY service_id`);
  const apis = await count(`SELECT service_id AS id, COUNT(*) AS n FROM service_apis WHERE company_id = $1 AND lifecycle = 'active' AND service_id IN (${ids}) GROUP BY service_id`);
  const apiSpecs = await count(`SELECT service_id AS id, COUNT(*) AS n FROM service_apis WHERE company_id = $1 AND lifecycle = 'active' AND spec_url IS NOT NULL AND service_id IN (${ids}) GROUP BY service_id`);
  const checklist = await count(`SELECT service_id AS id, COUNT(*) AS n FROM service_checklist WHERE company_id = $1 AND service_id IN (${ids}) GROUP BY service_id`);
  const checklistDone = await count(`SELECT service_id AS id, COUNT(*) AS n FROM service_checklist WHERE company_id = $1 AND done_at IS NOT NULL AND service_id IN (${ids}) GROUP BY service_id`);
  const majors = await count(
    `SELECT x.service_id AS id, COUNT(DISTINCT i.id) AS n FROM incident_services x JOIN incidents i ON i.id = x.incident_id
      WHERE i.company_id = $1 AND i.severity IN ('sev1','sev2') AND i.status = 'resolved' AND i.resolved_at > DATE_SUB(NOW(3), INTERVAL 90 DAY) AND x.service_id IN (${ids}) GROUP BY x.service_id`);
  const published = await count(
    `SELECT x.service_id AS id, COUNT(DISTINCT i.id) AS n FROM incident_services x JOIN incidents i ON i.id = x.incident_id JOIN postmortems p ON p.incident_id = i.id
      WHERE i.company_id = $1 AND i.severity IN ('sev1','sev2') AND i.status = 'resolved' AND p.status = 'published' AND i.resolved_at > DATE_SUB(NOW(3), INTERVAL 90 DAY) AND x.service_id IN (${ids}) GROUP BY x.service_id`);
  const deploys = new Map((await many<{ id: string; at: Date }>(
    `SELECT d.service_id AS id, MAX(d.started_at) AS at FROM deployments d JOIN service_environments e ON e.id = d.environment_id
      WHERE d.company_id = $1 AND e.kind = 'production' AND d.status = 'succeeded' AND d.service_id IN (${ids}) GROUP BY d.service_id`, [companyId, ...serviceIds])).map((r) => [r.id, r.at ? new Date(r.at) : null]));
  for (const s of services) {
    const facts: ScorecardFacts = {
      tier: s.tier, kind: s.kind, lifecycle: s.lifecycle, hasOwner: Boolean(s.owner_user_id), hasDescription: Boolean(s.description?.trim()),
      hasEscalationPolicy: Boolean(s.escalation_policy_id), alertIntegrations: integrations.get(s.id) ?? 0, runbooks: runbooks.get(s.id) ?? 0,
      repositories: repos.get(s.id) ?? 0, productionEnvironments: prodEnvs.get(s.id) ?? 0, lastProductionDeployAt: deploys.get(s.id) ?? null,
      activeApis: apis.get(s.id) ?? 0, activeApisWithSpec: apiSpecs.get(s.id) ?? 0, checklistTotal: checklist.get(s.id) ?? 0,
      checklistDone: checklistDone.get(s.id) ?? 0, majorIncidentsResolved: majors.get(s.id) ?? 0, majorPostmortemsPublished: published.get(s.id) ?? 0,
    };
    out.set(s.id, evaluateScorecard(facts));
  }
  return out;
}

export async function listScorecards(actor: Actor) {
  await requireRead(actor);
  const services = await many<{ id: string; name: string; tier: string; kind: string; owner_name: string | null; owner_user_id: string | null }>(
    `SELECT s.id, s.name, s.tier, s.kind, s.owner_user_id, u.display_name AS owner_name FROM services s LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE s.company_id = $1 AND s.is_active = 1 ORDER BY FIELD(s.tier,'critical','high','standard'), s.name`, [actor.companyId]);
  const cards = await scorecards(actor.companyId, services.map((s) => s.id));
  const items = services.map((s) => ({ id: s.id, name: s.name, tier: s.tier, kind: s.kind, ownerName: s.owner_name, mine: s.owner_user_id === actor.userId, scorecard: cards.get(s.id)! }));
  const scored = items.filter((i) => i.scorecard.percent !== null);
  return {
    rules: SCORECARD_RULES.map((r) => ({ id: r.id, label: r.label, passing: items.filter((i) => i.scorecard.rules.find((x) => x.id === r.id)?.passed).length, applicable: items.filter((i) => i.scorecard.rules.find((x) => x.id === r.id)?.applies).length })),
    average: scored.length ? Math.round(scored.reduce((a, i) => a + i.scorecard.percent!, 0) / scored.length) : null,
    items,
  };
}

/* ---------------------------------------------------------------- catalogue */

export async function listCatalogue(actor: Actor, filter: { q?: string; kind?: Kind; lifecycle?: Lifecycle; mine?: boolean; teamId?: string; includeInactive?: boolean }) {
  await requireRead(actor);
  const where = ['s.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  if (!filter.includeInactive) where.push('s.is_active = 1');
  if (filter.kind) { params.push(filter.kind); where.push(`s.kind = $${params.length}`); }
  if (filter.lifecycle) { params.push(filter.lifecycle); where.push(`s.lifecycle = $${params.length}`); }
  if (filter.mine) { params.push(actor.userId); where.push(`s.owner_user_id = $${params.length}`); }
  if (filter.teamId) { params.push(filter.teamId); where.push(`s.team_group_id = $${params.length}`); }
  if (filter.q?.trim()) { params.push(`%${filter.q.trim().replace(/[%_\\]/g, '\\$&')}%`); where.push(`(s.name LIKE $${params.length} OR s.description LIKE $${params.length} OR s.language LIKE $${params.length})`); }
  const rows = await many<ServiceRow & { owner_name: string | null; team_name: string | null; repos: number; open_prs: number }>(
    `SELECT s.*, u.display_name AS owner_name, g.name AS team_name,
            (SELECT COUNT(*) FROM repositories r WHERE r.service_id = s.id) AS repos,
            (SELECT COUNT(*) FROM pull_requests p JOIN repositories r ON r.id = p.repository_id WHERE r.service_id = s.id AND p.state = 'open') AS open_prs
       FROM services s LEFT JOIN users u ON u.id = s.owner_user_id LEFT JOIN \`groups\` g ON g.id = s.team_group_id
      WHERE ${where.join(' AND ')} ORDER BY FIELD(s.tier,'critical','high','standard'), s.name LIMIT 500`, params);
  const ids = rows.map((r) => r.id);
  const cards = await scorecards(actor.companyId, ids);
  const latest = ids.length ? await many<{ service_id: string; status: DeploymentStatus; started_at: Date; version: string | null; env: string }>(
    `SELECT d.service_id, d.status, d.started_at, d.version, e.name AS env FROM deployments d JOIN service_environments e ON e.id = d.environment_id
      WHERE d.id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY service_id ORDER BY started_at DESC) AS rn FROM deployments WHERE company_id = $1 AND service_id IN (${placeholders(ids.length, 2)})) t WHERE rn = 1)`,
    [actor.companyId, ...ids]) : [];
  return rows.map((r) => {
    const d = latest.find((l) => l.service_id === r.id);
    const card = cards.get(r.id)!;
    return {
      id: r.id, name: r.name, description: r.description, tier: r.tier, kind: r.kind, lifecycle: r.lifecycle, language: r.language,
      status: r.status, isActive: Boolean(r.is_active), owner: r.owner_user_id ? { id: r.owner_user_id, name: r.owner_name } : null,
      team: r.team_group_id ? { id: r.team_group_id, name: r.team_name } : null,
      repositories: Number(r.repos), openPullRequests: Number(r.open_prs),
      lastDeployment: d ? { status: d.status, environment: d.env, version: d.version, at: d.started_at } : null,
      score: { percent: card.percent, level: card.level },
    };
  });
}

export async function getCatalogueEntry(actor: Actor, id: string) {
  const s = await loadService(actor, id);
  const owner = s.owner_user_id ? await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [s.owner_user_id]) : null;
  const team = s.team_group_id ? await one<{ id: string; name: string }>('SELECT id, name FROM `groups` WHERE id = $1', [s.team_group_id]) : null;
  const project = s.project_id
    ? await one<{ id: string; name: string; key: string; open_tasks: number }>(
      "SELECT p.id, p.name, p.`key`, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks FROM projects p WHERE p.id = $1", [s.project_id])
    : null;
  const dependsOn = await many<{ id: string; name: string; status: string; tier: string; note: string | null }>(
    'SELECT t.id, t.name, t.status, t.tier, d.note FROM service_dependencies d JOIN services t ON t.id = d.depends_on_id WHERE d.service_id = $1 ORDER BY t.name', [id]);
  const dependents = await many<{ id: string; name: string; status: string; tier: string; note: string | null }>(
    'SELECT t.id, t.name, t.status, t.tier, d.note FROM service_dependencies d JOIN services t ON t.id = d.service_id WHERE d.depends_on_id = $1 ORDER BY t.name', [id]);
  const links = await many<{ id: string; kind: string; title: string; url: string | null; article_id: string | null; article_status: string | null }>(
    'SELECT l.id, l.kind, l.title, l.url, l.article_id, a.status AS article_status FROM service_links l LEFT JOIN kb_articles a ON a.id = l.article_id WHERE l.service_id = $1 ORDER BY FIELD(l.kind,\'runbook\',\'docs\',\'dashboard\',\'design\',\'other\'), l.title', [id]);
  const environments = await many<{ id: string; name: string; kind: string; url: string | null }>(
    "SELECT id, name, kind, url FROM service_environments WHERE service_id = $1 ORDER BY FIELD(kind,'production','staging','development','other'), name", [id]);
  const envLatest = environments.length ? await many<{ environment_id: string; status: DeploymentStatus; version: string | null; commit_sha: string | null; started_at: Date }>(
    `SELECT environment_id, status, version, commit_sha, started_at FROM deployments WHERE id IN (
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY environment_id ORDER BY started_at DESC) AS rn FROM deployments WHERE service_id = $1) t WHERE rn = 1)`, [id]) : [];
  const apis = await many<{ id: string; name: string; protocol: string; version: string | null; lifecycle: string; visibility: string; spec_url: string | null; docs_url: string | null; description: string | null }>(
    'SELECT id, name, protocol, version, lifecycle, visibility, spec_url, docs_url, description FROM service_apis WHERE service_id = $1 ORDER BY name, version', [id]);
  const repositories = await many<{ id: string; provider: string; full_name: string; url: string | null; default_branch: string | null; last_push_at: Date | null; last_commit_sha: string | null; last_commit_message: string | null; last_pusher: string | null; open_prs: number }>(
    `SELECT r.id, r.provider, r.full_name, r.url, r.default_branch, r.last_push_at, r.last_commit_sha, r.last_commit_message, r.last_pusher,
            (SELECT COUNT(*) FROM pull_requests p WHERE p.repository_id = r.id AND p.state = 'open') AS open_prs
       FROM repositories r WHERE r.service_id = $1 ORDER BY r.full_name`, [id]);
  const pulls = repositories.length ? await many<{ id: string; number: number; title: string; author: string | null; url: string | null; opened_at: Date; full_name: string }>(
    `SELECT p.id, p.number, p.title, p.author, p.url, p.opened_at, r.full_name FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
      WHERE r.service_id = $1 AND p.state = 'open' ORDER BY p.opened_at LIMIT 20`, [id]) : [];
  const checklist = await many<{ id: string; title: string; done_at: Date | null; done_by_name: string | null }>(
    'SELECT c.id, c.title, c.done_at, u.display_name AS done_by_name FROM service_checklist c LEFT JOIN users u ON u.id = c.done_by WHERE c.service_id = $1 ORDER BY c.position, c.title', [id]);
  const scorecard = (await scorecards(actor.companyId, [id])).get(id)!;
  return {
    id: s.id, name: s.name, slug: s.slug, description: s.description, tier: s.tier, kind: s.kind, lifecycle: s.lifecycle, language: s.language,
    status: s.status, isActive: Boolean(s.is_active), owner: s.owner_user_id ? { id: s.owner_user_id, name: owner?.display_name ?? 'Former member' } : null,
    team, project: project ? { id: project.id, name: project.name, key: project.key, openTasks: Number(project.open_tasks) } : null,
    dependsOn, dependents,
    links: links.map((l) => ({ id: l.id, kind: l.kind, title: l.title, url: l.url, articleId: l.article_id, articlePublished: l.article_id ? l.article_status === 'published' : null })),
    environments: environments.map((e) => {
      const d = envLatest.find((x) => x.environment_id === e.id);
      return { ...e, current: d ? { status: d.status, version: d.version, commitSha: d.commit_sha, at: d.started_at } : null };
    }),
    apis: apis.map((a) => ({ id: a.id, name: a.name, protocol: a.protocol, version: a.version, lifecycle: a.lifecycle, visibility: a.visibility, specUrl: a.spec_url, docsUrl: a.docs_url, description: a.description })),
    repositories: repositories.map((r) => ({ id: r.id, provider: r.provider, fullName: r.full_name, url: r.url, defaultBranch: r.default_branch, lastPushAt: r.last_push_at, lastCommitSha: r.last_commit_sha, lastCommitMessage: r.last_commit_message, lastPusher: r.last_pusher, openPullRequests: Number(r.open_prs) })),
    pullRequests: pulls.map((p) => ({ id: p.id, number: p.number, title: p.title, author: p.author, url: p.url, openedAt: p.opened_at, repository: p.full_name })),
    deployments: (await listDeployments(actor, { serviceId: id, days: 365, limit: 20 })).items,
    checklist: checklist.map((c) => ({ id: c.id, title: c.title, doneAt: c.done_at, doneBy: c.done_by_name })),
    scorecard,
    permissions: { canEdit: canEdit(actor, s), canManage: hasCapability(actor, 'engineering.manage'), canRecordDeployment: hasCapability(actor, 'deployment.record') },
  };
}

type CatalogueInput = { description?: string | null; tier?: Tier; kind?: Kind; lifecycle?: Lifecycle; language?: string | null; ownerUserId?: string | null; teamGroupId?: string | null; projectId?: string | null };

export async function createService(actor: Actor, input: CatalogueInput & { name: string; templateId?: string | null }) {
  await authorize({ actor, capability: 'engineering.manage', resourceless: true });
  await assertEmployee(actor.companyId, input.ownerUserId, 'ownerUserId');
  await assertTeamAndProject(actor.companyId, input);
  const template = input.templateId
    ? await one<{ kind: Kind; tier: Tier; checklist: unknown; environments: unknown; name: string }>('SELECT kind, tier, checklist, environments, name FROM service_templates WHERE id = $1 AND company_id = $2', [input.templateId, actor.companyId])
    : null;
  if (input.templateId && !template) throw unprocessable('Template not found', [{ field: 'templateId', message: 'Choose a template' }]);
  const tier = input.tier ?? template?.tier ?? 'standard';
  const { id } = await saveService(actor, null, { name: input.name, description: input.description ?? null, tier, ownerUserId: input.ownerUserId ?? null });
  await transaction(async (tx) => {
    await tx.query('UPDATE services SET kind = $2, lifecycle = $3, language = $4, team_group_id = $5, project_id = $6 WHERE id = $1',
      [id, input.kind ?? template?.kind ?? 'service', input.lifecycle ?? 'experimental', input.language?.trim() || null, input.teamGroupId ?? null, input.projectId ?? null]);
    if (template) {
      for (const [n, title] of parseJson<string[]>(template.checklist, []).entries()) {
        await tx.query('INSERT INTO service_checklist (id, company_id, service_id, title, position) VALUES ($1,$2,$3,$4,$5)', [newId(), actor.companyId, id, title, n]);
      }
      for (const name of parseJson<string[]>(template.environments, [])) {
        await tx.query('INSERT INTO service_environments (id, company_id, service_id, name, kind) VALUES ($1,$2,$3,$4,$5)', [newId(), actor.companyId, id, name, environmentKind(name)]);
      }
    }
    await auditFromActor(actor, 'engineering.service.create', { resourceType: 'service', resourceId: id, metadata: { template: template?.name ?? null } }, tx);
  });
  return { id };
}

export async function updateService(actor: Actor, id: string, input: CatalogueInput) {
  const s = await loadEditable(actor, id);
  await assertEmployee(actor.companyId, input.ownerUserId, 'ownerUserId');
  await assertTeamAndProject(actor.companyId, input);
  const next = {
    description: input.description === undefined ? s.description : input.description?.trim() || null,
    tier: input.tier ?? s.tier, kind: input.kind ?? s.kind, lifecycle: input.lifecycle ?? s.lifecycle,
    language: input.language === undefined ? s.language : input.language?.trim() || null,
    owner: input.ownerUserId === undefined ? s.owner_user_id : input.ownerUserId,
    team: input.teamGroupId === undefined ? s.team_group_id : input.teamGroupId,
    project: input.projectId === undefined ? s.project_id : input.projectId,
  };
  await pool.query('UPDATE services SET description = $3, tier = $4, kind = $5, lifecycle = $6, language = $7, owner_user_id = $8, team_group_id = $9, project_id = $10 WHERE id = $1 AND company_id = $2',
    [id, actor.companyId, next.description, next.tier, next.kind, next.lifecycle, next.language, next.owner, next.team, next.project]);
  await auditFromActor(actor, 'engineering.service.update', { resourceType: 'service', resourceId: id, metadata: { changes: Object.keys(input) } });
  await searchIndex.index({ companyId: actor.companyId, docType: 'service', resourceId: id, title: s.name, body: `${s.name} ${next.description ?? ''} ${next.language ?? ''}`, aclCompanyWide: true, link: `/engineering/services/${id}` });
  return { id };
}

/* ------------------------------------------------------------- dependencies */

export async function addDependency(actor: Actor, id: string, input: { dependsOnId: string; note?: string | null }) {
  await loadEditable(actor, id);
  if (input.dependsOnId === id) throw unprocessable('A service cannot depend on itself', [{ field: 'dependsOnId', message: 'Choose another service' }]);
  if (!(await one('SELECT 1 FROM services WHERE id = $1 AND company_id = $2', [input.dependsOnId, actor.companyId]))) throw unprocessable('Service not found', [{ field: 'dependsOnId', message: 'Choose a service' }]);
  // Refuse a cycle: walk what the target already depends on and see whether it reaches back.
  const edges = await many<{ service_id: string; depends_on_id: string }>('SELECT service_id, depends_on_id FROM service_dependencies WHERE company_id = $1', [actor.companyId]);
  const seen = new Set<string>();
  const stack = [input.dependsOnId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === id) throw conflict('That would make a circular dependency');
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.service_id === cur) stack.push(e.depends_on_id);
  }
  await pool.query('INSERT INTO service_dependencies (service_id, depends_on_id, company_id, note) VALUES ($1,$2,$3,$4) ON DUPLICATE KEY UPDATE note = VALUES(note)',
    [id, input.dependsOnId, actor.companyId, input.note?.trim() || null]);
  await auditFromActor(actor, 'engineering.dependency.add', { resourceType: 'service', resourceId: id, metadata: { dependsOnId: input.dependsOnId } });
}

export async function removeDependency(actor: Actor, id: string, dependsOnId: string) {
  await loadEditable(actor, id);
  await pool.query('DELETE FROM service_dependencies WHERE service_id = $1 AND depends_on_id = $2', [id, dependsOnId]);
  await auditFromActor(actor, 'engineering.dependency.remove', { resourceType: 'service', resourceId: id, metadata: { dependsOnId } });
}

/* ------------------------------------------------------------ links, envs */

export async function addLink(actor: Actor, id: string, input: { kind: 'runbook' | 'docs' | 'dashboard' | 'design' | 'other'; title: string; url?: string | null; articleId?: string | null }) {
  await loadEditable(actor, id);
  const url = httpUrl(input.url, 'url');
  if (input.articleId && !(await one('SELECT 1 FROM kb_articles WHERE id = $1 AND company_id = $2', [input.articleId, actor.companyId]))) {
    throw unprocessable('Article not found', [{ field: 'articleId', message: 'Choose an article' }]);
  }
  if (!url && !input.articleId) throw unprocessable('Link to a web address or a knowledge base article', [{ field: 'url', message: 'Required' }]);
  const linkId = newId();
  await pool.query('INSERT INTO service_links (id, company_id, service_id, kind, title, url, article_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [linkId, actor.companyId, id, input.kind, input.title.trim(), input.articleId ? null : url, input.articleId ?? null, actor.userId]);
  await auditFromActor(actor, 'engineering.link.add', { resourceType: 'service', resourceId: id, metadata: { kind: input.kind } });
  return { id: linkId };
}

export async function removeLink(actor: Actor, linkId: string) {
  const l = await one<{ service_id: string }>('SELECT service_id FROM service_links WHERE id = $1 AND company_id = $2', [linkId, actor.companyId]);
  if (!l) throw notFound('Link not found');
  await loadEditable(actor, l.service_id);
  await pool.query('DELETE FROM service_links WHERE id = $1', [linkId]);
  await auditFromActor(actor, 'engineering.link.remove', { resourceType: 'service', resourceId: l.service_id });
}

export async function saveEnvironment(actor: Actor, serviceId: string, envId: string | null, input: { name: string; kind: 'production' | 'staging' | 'development' | 'other'; url?: string | null }) {
  await loadEditable(actor, serviceId);
  const url = httpUrl(input.url, 'url');
  const name = input.name.trim();
  if (await one('SELECT 1 FROM service_environments WHERE service_id = $1 AND name = $2 AND id <> $3', [serviceId, name, envId ?? ''])) throw conflict('This service already has an environment with that name');
  const id = envId ?? newId();
  if (envId) {
    const res = await pool.query('UPDATE service_environments SET name = $3, kind = $4, url = $5 WHERE id = $1 AND service_id = $2', [envId, serviceId, name, input.kind, url]);
    if (res.rowCount === 0) throw notFound('Environment not found');
  } else {
    await pool.query('INSERT INTO service_environments (id, company_id, service_id, name, kind, url) VALUES ($1,$2,$3,$4,$5,$6)', [id, actor.companyId, serviceId, name, input.kind, url]);
  }
  await auditFromActor(actor, envId ? 'engineering.environment.update' : 'engineering.environment.create', { resourceType: 'service', resourceId: serviceId, metadata: { name } });
  return { id };
}

export async function removeEnvironment(actor: Actor, envId: string) {
  const e = await one<{ service_id: string; name: string }>('SELECT service_id, name FROM service_environments WHERE id = $1 AND company_id = $2', [envId, actor.companyId]);
  if (!e) throw notFound('Environment not found');
  await loadEditable(actor, e.service_id);
  // Deployment history is evidence; an environment that has any stays.
  if (await one('SELECT 1 FROM deployments WHERE environment_id = $1 LIMIT 1', [envId])) throw conflict('This environment has deployment history and cannot be removed');
  await pool.query('DELETE FROM service_environments WHERE id = $1', [envId]);
  await auditFromActor(actor, 'engineering.environment.remove', { resourceType: 'service', resourceId: e.service_id, metadata: { name: e.name } });
}

/* --------------------------------------------------------------------- APIs */

type ApiInput = { name: string; protocol: string; version?: string | null; lifecycle: string; visibility: string; description?: string | null; specUrl?: string | null; docsUrl?: string | null };

export async function listApis(actor: Actor, filter: { q?: string; protocol?: string; lifecycle?: string; visibility?: string }) {
  await requireRead(actor);
  const where = ['a.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  for (const [col, v] of [['protocol', filter.protocol], ['lifecycle', filter.lifecycle], ['visibility', filter.visibility]] as const) {
    if (v) { params.push(v); where.push(`a.${col} = $${params.length}`); }
  }
  if (filter.q?.trim()) { params.push(`%${filter.q.trim().replace(/[%_\\]/g, '\\$&')}%`); where.push(`(a.name LIKE $${params.length} OR a.description LIKE $${params.length} OR s.name LIKE $${params.length})`); }
  const rows = await many<{ id: string; name: string; protocol: string; version: string | null; lifecycle: string; visibility: string; description: string | null; spec_url: string | null; docs_url: string | null; service_id: string; service_name: string; owner_name: string | null; updated_at: Date }>(
    `SELECT a.*, s.name AS service_name, u.display_name AS owner_name FROM service_apis a JOIN services s ON s.id = a.service_id LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE ${where.join(' AND ')} ORDER BY FIELD(a.lifecycle,'active','draft','deprecated','retired'), a.name LIMIT 500`, params);
  return rows.map((a) => ({ id: a.id, name: a.name, protocol: a.protocol, version: a.version, lifecycle: a.lifecycle, visibility: a.visibility, description: a.description, specUrl: a.spec_url, docsUrl: a.docs_url, service: { id: a.service_id, name: a.service_name }, ownerName: a.owner_name, updatedAt: a.updated_at }));
}

export async function saveApi(actor: Actor, serviceId: string, apiId: string | null, input: ApiInput) {
  const svc = await loadEditable(actor, serviceId);
  const specUrl = httpUrl(input.specUrl, 'specUrl');
  const docsUrl = httpUrl(input.docsUrl, 'docsUrl');
  const version = input.version?.trim() || null;
  if (await one('SELECT 1 FROM service_apis WHERE service_id = $1 AND name = $2 AND version <=> $3 AND id <> $4', [serviceId, input.name.trim(), version, apiId ?? ''])) {
    throw conflict('This service already lists that API and version');
  }
  const id = apiId ?? newId();
  if (apiId) {
    const res = await pool.query(
      `UPDATE service_apis SET name = $3, protocol = $4, version = $5, lifecycle = $6, visibility = $7, description = $8, spec_url = $9, docs_url = $10 WHERE id = $1 AND service_id = $2`,
      [apiId, serviceId, input.name.trim(), input.protocol, version, input.lifecycle, input.visibility, input.description?.trim() || null, specUrl, docsUrl]);
    if (res.rowCount === 0) throw notFound('API not found');
  } else {
    await pool.query(
      `INSERT INTO service_apis (id, company_id, service_id, name, protocol, version, lifecycle, visibility, description, spec_url, docs_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, actor.companyId, serviceId, input.name.trim(), input.protocol, version, input.lifecycle, input.visibility, input.description?.trim() || null, specUrl, docsUrl, actor.userId]);
  }
  await auditFromActor(actor, apiId ? 'engineering.api.update' : 'engineering.api.create', { resourceType: 'service_api', resourceId: id, metadata: { serviceId } });
  await searchIndex.index({ companyId: actor.companyId, docType: 'api', resourceId: id, title: `${input.name.trim()}${version ? ` ${version}` : ''}`, body: `${input.name} ${input.protocol} ${svc.name} ${input.description ?? ''}`, aclCompanyWide: true, link: `/engineering/services/${serviceId}#apis` });
  return { id };
}

export async function deleteApi(actor: Actor, apiId: string) {
  const a = await one<{ service_id: string }>('SELECT service_id FROM service_apis WHERE id = $1 AND company_id = $2', [apiId, actor.companyId]);
  if (!a) throw notFound('API not found');
  await loadEditable(actor, a.service_id);
  await pool.query('DELETE FROM service_apis WHERE id = $1', [apiId]);
  await searchIndex.remove('api', apiId);
  await auditFromActor(actor, 'engineering.api.delete', { resourceType: 'service_api', resourceId: apiId, metadata: { serviceId: a.service_id } });
}

/* ---------------------------------------------------------------- checklist */

export async function addChecklistItem(actor: Actor, serviceId: string, title: string) {
  await loadEditable(actor, serviceId);
  const pos = await one<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM service_checklist WHERE service_id = $1', [serviceId]);
  const id = newId();
  await pool.query('INSERT INTO service_checklist (id, company_id, service_id, title, position) VALUES ($1,$2,$3,$4,$5)', [id, actor.companyId, serviceId, title.trim(), Number(pos?.n ?? 0)]);
  return { id };
}

export async function updateChecklistItem(actor: Actor, itemId: string, input: { done?: boolean; remove?: boolean }) {
  const c = await one<{ service_id: string; title: string }>('SELECT service_id, title FROM service_checklist WHERE id = $1 AND company_id = $2', [itemId, actor.companyId]);
  if (!c) throw notFound('Checklist item not found');
  await loadEditable(actor, c.service_id);
  if (input.remove) await pool.query('DELETE FROM service_checklist WHERE id = $1', [itemId]);
  else await pool.query('UPDATE service_checklist SET done_at = $2, done_by = $3 WHERE id = $1', [itemId, input.done ? new Date() : null, input.done ? actor.userId : null]);
  await auditFromActor(actor, input.remove ? 'engineering.checklist.remove' : input.done ? 'engineering.checklist.done' : 'engineering.checklist.reopen', { resourceType: 'service', resourceId: c.service_id, metadata: { title: c.title } });
}

/* ---------------------------------------------------------------- templates */

export async function listTemplates(actor: Actor) {
  await requireRead(actor);
  const rows = await many<{ id: string; name: string; description: string | null; kind: Kind; tier: Tier; checklist: unknown; environments: unknown; updated_at: Date }>(
    'SELECT id, name, description, kind, tier, checklist, environments, updated_at FROM service_templates WHERE company_id = $1 ORDER BY name', [actor.companyId]);
  return rows.map((t) => ({ id: t.id, name: t.name, description: t.description, kind: t.kind, tier: t.tier, checklist: parseJson<string[]>(t.checklist, []), environments: parseJson<string[]>(t.environments, []), updatedAt: t.updated_at }));
}

export async function saveTemplate(actor: Actor, id: string | null, input: { name: string; description?: string | null; kind: Kind; tier: Tier; checklist: string[]; environments: string[] }) {
  await authorize({ actor, capability: 'engineering.manage', resourceless: true });
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  if (await one('SELECT 1 FROM service_templates WHERE company_id = $1 AND name = $2 AND id <> $3', [actor.companyId, input.name.trim(), id ?? ''])) throw conflict('A template with that name already exists');
  const templateId = id ?? newId();
  const values = [input.name.trim(), input.description?.trim() || null, input.kind, input.tier, JSON.stringify(clean(input.checklist)), JSON.stringify(clean(input.environments))];
  if (id) {
    const res = await pool.query('UPDATE service_templates SET name = $3, description = $4, kind = $5, tier = $6, checklist = $7, environments = $8 WHERE id = $1 AND company_id = $2', [id, actor.companyId, ...values]);
    if (res.rowCount === 0) throw notFound('Template not found');
  } else {
    await pool.query('INSERT INTO service_templates (id, company_id, name, description, kind, tier, checklist, environments, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [templateId, actor.companyId, ...values, actor.userId]);
  }
  await auditFromActor(actor, id ? 'engineering.template.update' : 'engineering.template.create', { resourceType: 'service_template', resourceId: templateId });
  return { id: templateId };
}

export async function deleteTemplate(actor: Actor, id: string) {
  await authorize({ actor, capability: 'engineering.manage', resourceless: true });
  const res = await pool.query('DELETE FROM service_templates WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (res.rowCount === 0) throw notFound('Template not found');
  await auditFromActor(actor, 'engineering.template.delete', { resourceType: 'service_template', resourceId: id });
}

/* -------------------------------------------------------------- deployments */

export async function listDeployments(actor: Actor, filter: { serviceId?: string; status?: DeploymentStatus; production?: boolean; days: number; limit: number }) {
  await requireRead(actor);
  const where = ['d.company_id = $1', 'd.started_at >= $2'];
  const params: unknown[] = [actor.companyId, new Date(Date.now() - filter.days * 86_400_000)];
  if (filter.serviceId) { params.push(filter.serviceId); where.push(`d.service_id = $${params.length}`); }
  if (filter.status) { params.push(filter.status); where.push(`d.status = $${params.length}`); }
  if (filter.production) where.push("e.kind = 'production'");
  const base = `FROM deployments d JOIN services s ON s.id = d.service_id JOIN service_environments e ON e.id = d.environment_id WHERE ${where.join(' AND ')}`;
  const rows = await many<{ id: string; service_id: string; service_name: string; tier: string; env_name: string; env_kind: string; version: string | null; commit_sha: string | null; status: DeploymentStatus; source: string; url: string | null; notes: string | null; change_id: string | null; change_number: number | null; deployer: string | null; external_actor: string | null; started_at: Date; finished_at: Date | null }>(
    `SELECT d.*, s.name AS service_name, s.tier, e.name AS env_name, e.kind AS env_kind, c.number AS change_number, u.display_name AS deployer
       ${base.replace('WHERE', 'LEFT JOIN change_requests c ON c.id = d.change_id LEFT JOIN users u ON u.id = d.deployed_by WHERE')}
      ORDER BY d.started_at DESC LIMIT $${params.length + 1}`, [...params, filter.limit]);
  const stats = await one<{ total: number; succeeded: number; failed: number; rolled_back: number; production: number }>(
    `SELECT COUNT(*) AS total, SUM(d.status = 'succeeded') AS succeeded, SUM(d.status = 'failed') AS failed, SUM(d.status = 'rolled_back') AS rolled_back,
            SUM(e.kind = 'production') AS production ${base}`, params);
  const total = Number(stats?.total ?? 0);
  const failed = Number(stats?.failed ?? 0) + Number(stats?.rolled_back ?? 0);
  const finished = Number(stats?.succeeded ?? 0) + failed;
  return {
    items: rows.map((d) => ({
      id: d.id, service: { id: d.service_id, name: d.service_name, tier: d.tier }, environment: { name: d.env_name, kind: d.env_kind },
      version: d.version, commitSha: d.commit_sha, status: d.status, source: d.source, url: d.url, notes: d.notes,
      change: d.change_id ? { id: d.change_id, ref: `CHG-${d.change_number}` } : null,
      // A production release of an important service with no change record is worth seeing.
      withoutChange: !d.change_id && d.env_kind === 'production' && d.tier !== 'standard' && d.source === 'manual',
      deployedBy: d.deployer ?? d.external_actor, startedAt: d.started_at, finishedAt: d.finished_at,
    })),
    stats: {
      days: filter.days, total, production: Number(stats?.production ?? 0), failed,
      perWeek: Math.round((total / Math.max(1, filter.days / 7)) * 10) / 10,
      // Share of finished deployments that failed or were rolled back.
      changeFailureRate: finished ? Math.round((failed / finished) * 1000) / 10 : null,
    },
  };
}

async function notifyFailure(companyId: string, deploymentId: string) {
  const d = await one<{ service_id: string; name: string; owner_user_id: string | null; env: string; env_kind: string; version: string | null; status: string }>(
    `SELECT d.service_id, s.name, s.owner_user_id, e.name AS env, e.kind AS env_kind, d.version, d.status FROM deployments d
       JOIN services s ON s.id = d.service_id JOIN service_environments e ON e.id = d.environment_id WHERE d.id = $1`, [deploymentId]);
  if (!d || !d.owner_user_id || d.env_kind !== 'production' || (d.status !== 'failed' && d.status !== 'rolled_back')) return;
  await notifications.create({
    companyId, userId: d.owner_user_id, type: 'deployment.failed',
    title: `${d.name}: production deployment ${d.status === 'failed' ? 'failed' : 'was rolled back'}`,
    body: `${d.version ?? 'A deployment'} to ${d.env}`, link: `/engineering/services/${d.service_id}`,
    resourceType: 'deployment', resourceId: deploymentId, dedupeKey: `deployment.${deploymentId}.${d.status}`,
  });
}

export async function recordDeployment(actor: Actor, serviceId: string, input: { environmentId: string; version?: string | null; commitSha?: string | null; status: DeploymentStatus; url?: string | null; notes?: string | null; changeId?: string | null }) {
  await loadService(actor, serviceId);
  await authorize({ actor, capability: 'deployment.record', resourceless: true });
  if (!(await one('SELECT 1 FROM service_environments WHERE id = $1 AND service_id = $2', [input.environmentId, serviceId]))) throw unprocessable('Environment not found', [{ field: 'environmentId', message: 'Choose one of this service\'s environments' }]);
  if (input.changeId && !(await one('SELECT 1 FROM change_requests WHERE id = $1 AND company_id = $2', [input.changeId, actor.companyId]))) throw unprocessable('Change not found', [{ field: 'changeId', message: 'Choose a change' }]);
  if (input.commitSha && !/^[0-9a-f]{7,64}$/i.test(input.commitSha.trim())) throw unprocessable('A commit SHA is 7 to 64 hexadecimal characters', [{ field: 'commitSha', message: 'Check the SHA' }]);
  const id = newId();
  await pool.query(
    `INSERT INTO deployments (id, company_id, service_id, environment_id, version, commit_sha, status, source, url, notes, change_id, deployed_by, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11,$12)`,
    [id, actor.companyId, serviceId, input.environmentId, input.version?.trim() || null, input.commitSha?.trim().toLowerCase() || null, input.status,
      httpUrl(input.url, 'url'), input.notes?.trim() || null, input.changeId ?? null, actor.userId, input.status === 'in_progress' ? null : new Date()]);
  await auditFromActor(actor, 'deployment.record', { resourceType: 'deployment', resourceId: id, metadata: { serviceId, status: input.status } });
  await notifyFailure(actor.companyId, id);
  return { id };
}

export async function updateDeployment(actor: Actor, id: string, status: DeploymentStatus) {
  await requireRead(actor);
  await authorize({ actor, capability: 'deployment.record', resourceless: true });
  const d = await one<{ status: string; source: string }>('SELECT status, source FROM deployments WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!d) throw notFound('Deployment not found');
  // Provider-reported deployments are updated by the provider, so the record stays what it reported.
  if (d.source !== 'manual' && status !== 'rolled_back') throw conflict('This deployment is reported by source control; only a rollback can be recorded here');
  await pool.query('UPDATE deployments SET status = $2, finished_at = COALESCE(finished_at, NOW(3)) WHERE id = $1', [id, status]);
  await auditFromActor(actor, 'deployment.update', { resourceType: 'deployment', resourceId: id, metadata: { from: d.status, to: status } });
  await notifyFailure(actor.companyId, id);
}

/** Deployments to the given services in the day before an incident started, or since. */
export async function deploymentsNear(companyId: string, serviceIds: string[], detectedAt: Date) {
  if (serviceIds.length === 0) return [];
  const rows = await many<{ id: string; service_id: string; service_name: string; env: string; version: string | null; commit_sha: string | null; status: string; started_at: Date }>(
    `SELECT d.id, d.service_id, s.name AS service_name, e.name AS env, d.version, d.commit_sha, d.status, d.started_at
       FROM deployments d JOIN services s ON s.id = d.service_id JOIN service_environments e ON e.id = d.environment_id
      WHERE d.company_id = $1 AND d.service_id IN (${placeholders(serviceIds.length, 3)}) AND d.started_at >= $2
      ORDER BY d.started_at DESC LIMIT 10`, [companyId, new Date(detectedAt.getTime() - 86_400_000), ...serviceIds]);
  return rows.map((d) => ({ id: d.id, service: { id: d.service_id, name: d.service_name }, environment: d.env, version: d.version, commitSha: d.commit_sha, status: d.status, startedAt: d.started_at }));
}

/* ----------------------------------------------------------- source control */

type ConnectionRow = { id: string; company_id: string; provider: 'github' | 'gitlab'; name: string; endpoint_key: string; secret_encrypted: string; secret_fingerprint: string; is_active: number; last_received_at: Date | null; created_at: Date };

async function endpointFor(key: string) {
  const { config } = await import('../core/config.js');
  return `${config.apiUrl}/api/v1/engineering/scm/${key}`;
}

export async function listConnections(actor: Actor) {
  await authorize({ actor, capability: 'scm.manage', resourceless: true });
  const rows = await many<ConnectionRow & { repos: number }>(
    'SELECT c.*, (SELECT COUNT(*) FROM repositories r WHERE r.connection_id = c.id) AS repos FROM scm_connections c WHERE c.company_id = $1 ORDER BY c.created_at', [actor.companyId]);
  return Promise.all(rows.map(async (c) => ({ id: c.id, provider: c.provider, name: c.name, isActive: Boolean(c.is_active), lastReceivedAt: c.last_received_at, secretFingerprint: c.secret_fingerprint, repositories: Number(c.repos), endpoint: await endpointFor(c.endpoint_key), createdAt: c.created_at })));
}

export async function createConnection(actor: Actor, input: { provider: 'github' | 'gitlab'; name: string }) {
  await authorize({ actor, capability: 'scm.manage', resourceless: true });
  const id = newId();
  const secret = generateToken(32);
  const key = randomBytes(16).toString('hex');
  await pool.query('INSERT INTO scm_connections (id, company_id, provider, name, endpoint_key, secret_encrypted, secret_fingerprint, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, actor.companyId, input.provider, input.name.trim(), key, encryptField(secret), sha256(secret).slice(0, 12), actor.userId]);
  await auditFromActor(actor, 'scm.connection.create', { resourceType: 'scm_connection', resourceId: id, metadata: { provider: input.provider } });
  // The secret is shown once; afterwards only its fingerprint identifies it.
  return { id, endpoint: await endpointFor(key), secret };
}

export async function updateConnection(actor: Actor, id: string, input: { name?: string; isActive?: boolean; rotate?: boolean }) {
  await authorize({ actor, capability: 'scm.manage', resourceless: true });
  const row = await one<ConnectionRow>('SELECT * FROM scm_connections WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!row) throw notFound('Connection not found');
  const secret = input.rotate ? generateToken(32) : null;
  await pool.query('UPDATE scm_connections SET name = COALESCE($3, name), is_active = COALESCE($4, is_active), secret_encrypted = COALESCE($5, secret_encrypted), secret_fingerprint = COALESCE($6, secret_fingerprint) WHERE id = $1 AND company_id = $2',
    [id, actor.companyId, input.name?.trim() ?? null, input.isActive === undefined ? null : input.isActive, secret ? encryptField(secret) : null, secret ? sha256(secret).slice(0, 12) : null]);
  await auditFromActor(actor, input.rotate ? 'scm.connection.rotate' : 'scm.connection.update', { resourceType: 'scm_connection', resourceId: id, metadata: { changes: Object.keys(input) } });
  return { id, endpoint: await endpointFor(row.endpoint_key), secret };
}

export async function listRepositories(actor: Actor) {
  await requireRead(actor);
  const rows = await many<{ id: string; provider: string; full_name: string; url: string | null; default_branch: string | null; service_id: string | null; service_name: string | null; owner_user_id: string | null; last_push_at: Date | null; last_commit_message: string | null; last_pusher: string | null; open_prs: number; connection_name: string | null }>(
    `SELECT r.*, s.name AS service_name, s.owner_user_id, c.name AS connection_name,
            (SELECT COUNT(*) FROM pull_requests p WHERE p.repository_id = r.id AND p.state = 'open') AS open_prs
       FROM repositories r LEFT JOIN services s ON s.id = r.service_id LEFT JOIN scm_connections c ON c.id = r.connection_id
      WHERE r.company_id = $1 ORDER BY (r.service_id IS NULL) DESC, r.full_name LIMIT 500`, [actor.companyId]);
  const manage = hasCapability(actor, 'engineering.manage');
  return rows.map((r) => ({
    id: r.id, provider: r.provider, fullName: r.full_name, url: r.url, defaultBranch: r.default_branch, connectionName: r.connection_name,
    service: r.service_id ? { id: r.service_id, name: r.service_name } : null, lastPushAt: r.last_push_at, lastCommitMessage: r.last_commit_message,
    lastPusher: r.last_pusher, openPullRequests: Number(r.open_prs), canLink: manage || (r.owner_user_id !== null && r.owner_user_id === actor.userId),
  }));
}

/** Links a repository to a service. Engineering managers, or the owners of the services involved. */
export async function linkRepository(actor: Actor, repoId: string, serviceId: string | null) {
  await requireRead(actor);
  const repo = await one<{ service_id: string | null; full_name: string }>('SELECT service_id, full_name FROM repositories WHERE id = $1 AND company_id = $2', [repoId, actor.companyId]);
  if (!repo) throw notFound('Repository not found');
  if (!hasCapability(actor, 'engineering.manage')) {
    const owns = async (id: string | null) => !id || Boolean(await one('SELECT 1 FROM services WHERE id = $1 AND owner_user_id = $2', [id, actor.userId]));
    if (!(await owns(repo.service_id)) || !(await owns(serviceId))) throw forbidden('Only owners of the services involved or an engineering manager can link this repository');
  }
  if (serviceId && !(await one('SELECT 1 FROM services WHERE id = $1 AND company_id = $2', [serviceId, actor.companyId]))) throw unprocessable('Service not found', [{ field: 'serviceId', message: 'Choose a service' }]);
  await pool.query('UPDATE repositories SET service_id = $2 WHERE id = $1', [repoId, serviceId]);
  await auditFromActor(actor, serviceId ? 'scm.repository.link' : 'scm.repository.unlink', { resourceType: 'repository', resourceId: repoId, metadata: { serviceId, repository: repo.full_name } });
}

export type WebhookResult = { outcome: 'ok' | 'duplicate' | 'ignored'; repository?: string; recorded?: string[]; reason?: string };

/** GitHub: HMAC-SHA256 of the raw body in X-Hub-Signature-256. GitLab: the secret itself in X-Gitlab-Token. */
export async function receiveScmWebhook(key: string, rawBody: string, headers: Record<string, string | undefined>): Promise<WebhookResult> {
  const conn = await one<ConnectionRow>('SELECT * FROM scm_connections WHERE endpoint_key = $1', [key]);
  if (!conn || !conn.is_active) throw unauthenticated('Invalid signature');
  const secret = decryptField(conn.secret_encrypted);
  let event: string | undefined;
  let delivery: string | undefined;
  if (conn.provider === 'github') {
    const sig = headers['x-hub-signature-256'];
    if (!sig || !safeEqual(`sha256=${hmacSignature(secret, rawBody)}`, sig)) throw unauthenticated('Invalid signature');
    event = headers['x-github-event'];
    delivery = headers['x-github-delivery'];
  } else {
    const token = headers['x-gitlab-token'];
    if (!token || !safeEqual(token, secret)) throw unauthenticated('Invalid signature');
    event = headers['x-gitlab-event'];
    delivery = headers['x-gitlab-event-uuid'];
  }
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { throw unprocessable('Body must be JSON; set the webhook content type to application/json'); }
  await pool.query('UPDATE scm_connections SET last_received_at = NOW(3) WHERE id = $1', [conn.id]);
  // GitLab does not always send a delivery id; the body hash stands in so a resend is still recognised.
  const deliveryId = (delivery || `sha256:${sha256(rawBody)}`).slice(0, 80);
  const claim = await pool.query('INSERT IGNORE INTO scm_deliveries (connection_id, delivery_id) VALUES ($1,$2)', [conn.id, deliveryId]);
  if (claim.rowCount === 0) return { outcome: 'duplicate' };
  if (!event || event === 'ping') return { outcome: 'ok' };
  const parsed = conn.provider === 'github' ? githubEvent(event, payload) : gitlabEvent(event, payload);
  if (!parsed) return { outcome: 'ignored', reason: 'Not a repository event' };
  return applyScmEvent(conn, parsed);
}

async function applyScmEvent(conn: ConnectionRow, ev: ScmEvent): Promise<WebhookResult> {
  const recorded: string[] = [];
  await pool.query(
    `INSERT INTO repositories (id, company_id, connection_id, provider, full_name, url, default_branch) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON DUPLICATE KEY UPDATE connection_id = VALUES(connection_id), url = COALESCE(VALUES(url), url), default_branch = COALESCE(VALUES(default_branch), default_branch)`,
    [newId(), conn.company_id, conn.id, conn.provider, ev.repo.fullName, ev.repo.url, ev.repo.defaultBranch]);
  const repo = (await one<{ id: string; service_id: string | null; default_branch: string | null }>('SELECT id, service_id, default_branch FROM repositories WHERE company_id = $1 AND provider = $2 AND full_name = $3', [conn.company_id, conn.provider, ev.repo.fullName]))!;

  if (ev.push && (!repo.default_branch || ev.push.branch === repo.default_branch)) {
    await pool.query('UPDATE repositories SET last_push_at = $2, last_commit_sha = $3, last_commit_message = $4, last_pusher = $5 WHERE id = $1',
      [repo.id, ev.push.at, ev.push.sha || null, ev.push.message, ev.push.pusher]);
    recorded.push('push');
  }
  if (ev.pullRequest) {
    const pr = ev.pullRequest;
    await pool.query(
      `INSERT INTO pull_requests (id, company_id, repository_id, number, title, author, state, url, opened_at, merged_at, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON DUPLICATE KEY UPDATE title = VALUES(title), state = VALUES(state), url = COALESCE(VALUES(url), url), merged_at = VALUES(merged_at), closed_at = VALUES(closed_at)`,
      [newId(), conn.company_id, repo.id, pr.number, pr.title, pr.author, pr.state, pr.url, pr.openedAt, pr.mergedAt, pr.closedAt]);
    recorded.push('pull_request');
  }
  if (ev.deployment) {
    if (!repo.service_id) return { outcome: 'ignored', repository: ev.repo.fullName, recorded, reason: 'Repository is not linked to a service' };
    const dep = ev.deployment;
    await pool.query('INSERT IGNORE INTO service_environments (id, company_id, service_id, name, kind) VALUES ($1,$2,$3,$4,$5)',
      [newId(), conn.company_id, repo.service_id, dep.environment, environmentKind(dep.environment)]);
    const env = (await one<{ id: string }>('SELECT id FROM service_environments WHERE service_id = $1 AND name = $2', [repo.service_id, dep.environment]))!;
    const terminal = dep.status !== 'in_progress';
    await pool.query(
      `INSERT INTO deployments (id, company_id, service_id, environment_id, version, commit_sha, status, source, external_id, url, external_actor, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON DUPLICATE KEY UPDATE status = VALUES(status), url = COALESCE(VALUES(url), url), finished_at = COALESCE(VALUES(finished_at), finished_at)`,
      [newId(), conn.company_id, repo.service_id, env.id, null, dep.sha, dep.status, conn.provider, dep.externalId, dep.url, dep.actor, dep.at, terminal ? dep.at : null]);
    const row = await one<{ id: string }>('SELECT id FROM deployments WHERE company_id = $1 AND source = $2 AND external_id = $3', [conn.company_id, conn.provider, dep.externalId]);
    if (row) await notifyFailure(conn.company_id, row.id);
    recorded.push('deployment');
  }
  return { outcome: recorded.length ? 'ok' : 'ignored', repository: ev.repo.fullName, recorded };
}

export async function pruneDeliveries(): Promise<void> {
  await pool.query('DELETE FROM scm_deliveries WHERE received_at < DATE_SUB(NOW(3), INTERVAL 30 DAY)');
}

/* ---------------------------------------------------------------- dashboard */

export async function forDashboard(actor: Actor) {
  if (!hasCapability(actor, 'engineering.read')) return null;
  const owned = await many<{ id: string; name: string }>('SELECT id, name FROM services WHERE company_id = $1 AND owner_user_id = $2 AND is_active = 1 ORDER BY name LIMIT 20', [actor.companyId, actor.userId]);
  if (owned.length === 0) return { services: [], failedDeployments: [] };
  const cards = await scorecards(actor.companyId, owned.map((s) => s.id));
  const failed = await many<{ id: string; service_id: string; name: string; env: string; version: string | null; commit_sha: string | null; status: string; started_at: Date }>(
    `SELECT d.id, d.service_id, s.name, e.name AS env, d.version, d.commit_sha, d.status, d.started_at FROM deployments d JOIN services s ON s.id = d.service_id JOIN service_environments e ON e.id = d.environment_id
      WHERE s.company_id = $1 AND s.owner_user_id = $2 AND e.kind = 'production' AND d.status IN ('failed','rolled_back') AND d.started_at > DATE_SUB(NOW(3), INTERVAL 1 DAY)
      ORDER BY d.started_at DESC LIMIT 5`, [actor.companyId, actor.userId]);
  return {
    services: owned.map((s) => ({ id: s.id, name: s.name, percent: cards.get(s.id)!.percent, level: cards.get(s.id)!.level, failing: cards.get(s.id)!.rules.filter((r) => r.applies && !r.passed).map((r) => r.label) })),
    failedDeployments: failed.map((d) => ({ id: d.id, serviceId: d.service_id, service: d.name, environment: d.env, version: d.version ?? d.commit_sha?.slice(0, 7) ?? null, status: d.status, at: d.started_at })),
  };
}

/* ------------------------------------------------------------------ deletion */

/** Removes a deployment recorded by hand in error. Provider-reported ones are the provider's record. */
export async function deleteDeployment(actor: Actor, id: string) {
  await authorize({ actor, capability: 'engineering.manage', resourceless: true });
  const d = await one<{ source: string; service_id: string; version: string | null }>('SELECT source, service_id, version FROM deployments WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!d) throw notFound('Deployment not found');
  if (d.source !== 'manual') throw conflict('This deployment was reported by source control and cannot be deleted here');
  await pool.query('DELETE FROM deployments WHERE id = $1', [id]);
  await auditFromActor(actor, 'deployment.delete', { resourceType: 'deployment', resourceId: id, metadata: { serviceId: d.service_id, version: d.version } });
}

/** Deleting a connection stops its webhook at once; repositories it reported stay, unconnected. */
export async function deleteConnection(actor: Actor, id: string) {
  await authorize({ actor, capability: 'scm.manage', resourceless: true });
  const c = await one<{ name: string; provider: string }>('SELECT name, provider FROM scm_connections WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!c) throw notFound('Connection not found');
  await pool.query('DELETE FROM scm_connections WHERE id = $1', [id]);
  await auditFromActor(actor, 'scm.connection.delete', { resourceType: 'scm_connection', resourceId: id, metadata: { name: c.name, provider: c.provider } });
}

/** Removes a repository record and its pull requests. Deployments already recorded for the service stay. */
export async function deleteRepository(actor: Actor, id: string) {
  await authorize({ actor, capability: 'engineering.manage', resourceless: true });
  const r = await one<{ full_name: string }>('SELECT full_name FROM repositories WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!r) throw notFound('Repository not found');
  await pool.query('DELETE FROM repositories WHERE id = $1', [id]);
  await auditFromActor(actor, 'scm.repository.delete', { resourceType: 'repository', resourceId: id, metadata: { repository: r.full_name } });
}
