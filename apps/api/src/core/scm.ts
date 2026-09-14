/**
 * GitHub and GitLab webhook payloads, reduced to the few facts Workspace records.
 *
 * Pure functions: no database, no network. The domain decides what to store; this only
 * says what an event means. Anything unrecognised returns null and is acknowledged but
 * ignored, so adding an event in the provider's settings never breaks delivery.
 */

export type ScmRepo = { fullName: string; url: string | null; defaultBranch: string | null };
export type ScmPush = { branch: string; sha: string; message: string | null; pusher: string | null; at: Date };
export type ScmPullRequest = { number: number; title: string; author: string | null; state: 'open' | 'merged' | 'closed'; url: string | null; openedAt: Date; mergedAt: Date | null; closedAt: Date | null };
export type ScmDeployment = { externalId: string; environment: string; status: 'in_progress' | 'succeeded' | 'failed' | 'rolled_back'; sha: string | null; url: string | null; actor: string | null; at: Date };

export type ScmEvent = { repo: ScmRepo; push?: ScmPush; pullRequest?: ScmPullRequest; deployment?: ScmDeployment };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : typeof v === 'number' ? String(v) : null);
const date = (v: unknown): Date => { const d = typeof v === 'string' ? new Date(v) : new Date(NaN); return Number.isNaN(d.getTime()) ? new Date() : d; };
const maybeDate = (v: unknown): Date | null => (typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? new Date(v) : null);
/** Only http(s) links are kept: anything else could be a script URL rendered on a page. */
const link = (v: unknown): string | null => { const s = str(v); return s && /^https?:\/\//i.test(s) ? s : null; };
const firstLine = (v: unknown): string | null => { const s = str(v, 5000); return s ? s.split('\n')[0]!.slice(0, 300) : null; };

export function githubEvent(event: string, payload: unknown): ScmEvent | null {
  const p = obj(payload);
  const r = obj(p.repository);
  const fullName = str(r.full_name, 200);
  if (!fullName) return null;
  const repo: ScmRepo = { fullName, url: link(r.html_url), defaultBranch: str(r.default_branch, 120) };

  if (event === 'push') {
    const ref = str(p.ref) ?? '';
    if (!ref.startsWith('refs/heads/') || p.deleted === true) return { repo };
    const head = obj(p.head_commit);
    return { repo, push: { branch: ref.slice('refs/heads/'.length), sha: str(p.after, 64) ?? '', message: firstLine(head.message), pusher: str(obj(p.pusher).name, 120), at: date(head.timestamp) } };
  }
  if (event === 'pull_request') {
    const pr = obj(p.pull_request);
    const number = Number(pr.number ?? p.number);
    if (!Number.isInteger(number)) return { repo };
    const state = pr.merged === true ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
    return { repo, pullRequest: { number, title: str(pr.title, 300) ?? `#${number}`, author: str(obj(pr.user).login, 120), state, url: link(pr.html_url), openedAt: date(pr.created_at), mergedAt: maybeDate(pr.merged_at), closedAt: maybeDate(pr.closed_at) } };
  }
  if (event === 'deployment_status') {
    const ds = obj(p.deployment_status);
    const d = obj(p.deployment);
    const id = str(d.id, 80);
    const env = str(d.environment ?? ds.environment, 60);
    const status = ({ success: 'succeeded', failure: 'failed', error: 'failed', in_progress: 'in_progress', queued: 'in_progress', pending: 'in_progress' } as const)[String(ds.state) as 'success'];
    // 'inactive' means a newer deployment replaced this one: nothing to record.
    if (!id || !env || !status) return { repo };
    return { repo, deployment: { externalId: id, environment: env, status, sha: str(d.sha, 64), url: link(ds.environment_url) ?? link(ds.target_url), actor: str(obj(d.creator).login, 120), at: date(ds.created_at ?? d.created_at) } };
  }
  return { repo };
}

export function gitlabEvent(event: string, payload: unknown): ScmEvent | null {
  const p = obj(payload);
  const project = obj(p.project);
  const fullName = str(project.path_with_namespace, 200);
  if (!fullName) return null;
  const repo: ScmRepo = { fullName, url: link(project.web_url), defaultBranch: str(project.default_branch, 120) };

  if (event === 'Push Hook') {
    const ref = str(p.ref) ?? '';
    const sha = str(p.checkout_sha, 64) ?? str(p.after, 64);
    // A deleted branch arrives with a zero SHA and no checkout.
    if (!ref.startsWith('refs/heads/') || !sha || /^0+$/.test(sha)) return { repo };
    const commits = Array.isArray(p.commits) ? p.commits.map(obj) : [];
    const head = commits.find((c) => c.id === sha) ?? commits[commits.length - 1] ?? {};
    return { repo, push: { branch: ref.slice('refs/heads/'.length), sha, message: firstLine(head.message), pusher: str(p.user_username ?? p.user_name, 120), at: date(head.timestamp) } };
  }
  if (event === 'Merge Request Hook') {
    const mr = obj(p.object_attributes);
    const number = Number(mr.iid);
    if (!Number.isInteger(number)) return { repo };
    const raw = String(mr.state);
    const state = raw === 'merged' ? 'merged' : raw === 'closed' || raw === 'locked' ? 'closed' : 'open';
    const updated = maybeDate(mr.updated_at);
    return { repo, pullRequest: { number, title: str(mr.title, 300) ?? `!${number}`, author: str(obj(p.user).username, 120), state, url: link(mr.url), openedAt: date(mr.created_at), mergedAt: state === 'merged' ? maybeDate(mr.merged_at) ?? updated : null, closedAt: state === 'closed' ? maybeDate(mr.closed_at) ?? updated : null } };
  }
  if (event === 'Deployment Hook') {
    const id = str(p.deployment_id, 80);
    const env = str(p.environment, 60);
    const status = ({ running: 'in_progress', created: 'in_progress', success: 'succeeded', failed: 'failed', canceled: 'failed' } as const)[String(p.status) as 'running'];
    if (!id || !env || !status) return { repo };
    return { repo, deployment: { externalId: id, environment: env, status, sha: str(p.sha ?? p.short_sha, 64), url: link(p.environment_external_url) ?? link(p.deployable_url), actor: str(obj(p.user).username, 120), at: date(p.status_changed_at) } };
  }
  return { repo };
}

/** Environment kind guessed from its name, for environments first seen in a deployment event. */
export function environmentKind(name: string): 'production' | 'staging' | 'development' | 'other' {
  const n = name.toLowerCase();
  if (/^(prod|production|live)\b|[-_ ]prod(uction)?$/.test(n)) return 'production';
  if (/stag|preprod|uat|qa/.test(n)) return 'staging';
  if (/^dev|develop|preview|review/.test(n)) return 'development';
  return 'other';
}
