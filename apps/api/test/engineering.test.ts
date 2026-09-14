/**
 * What GitHub and GitLab webhook payloads mean, and how a service scorecard is scored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { environmentKind, githubEvent, gitlabEvent } from '../src/core/scm.js';
import { evaluateScorecard, type ScorecardFacts } from '../src/core/scorecard.js';

const ghRepo = { full_name: 'acme/payments', html_url: 'https://github.com/acme/payments', default_branch: 'main' };
const glProject = { path_with_namespace: 'acme/web', web_url: 'https://gitlab.com/acme/web', default_branch: 'main' };

describe('source control events', () => {
  it('reads a GitHub push to a branch, first line of the message only', () => {
    const ev = githubEvent('push', { ref: 'refs/heads/main', after: 'abc1234', repository: ghRepo, pusher: { name: 'ana' }, head_commit: { message: 'Fix rounding\n\nLonger body', timestamp: '2026-09-01T10:00:00Z' } });
    assert.deepEqual(ev?.push, { branch: 'main', sha: 'abc1234', message: 'Fix rounding', pusher: 'ana', at: new Date('2026-09-01T10:00:00Z') });
    assert.equal(ev?.repo.url, 'https://github.com/acme/payments');
    assert.equal(githubEvent('push', { ref: 'refs/tags/v1', repository: ghRepo })?.push, undefined, 'tags are not branch pushes');
    assert.equal(githubEvent('push', { ref: 'refs/heads/old', deleted: true, repository: ghRepo })?.push, undefined);
  });

  it('distinguishes merged from closed pull requests', () => {
    const base = { number: 7, title: 'Add refunds', user: { login: 'ben' }, html_url: 'https://github.com/acme/payments/pull/7', created_at: '2026-09-01T00:00:00Z' };
    assert.equal(githubEvent('pull_request', { action: 'opened', pull_request: { ...base, state: 'open' }, repository: ghRepo })?.pullRequest?.state, 'open');
    assert.equal(githubEvent('pull_request', { action: 'closed', pull_request: { ...base, state: 'closed', merged: true, merged_at: '2026-09-02T00:00:00Z' }, repository: ghRepo })?.pullRequest?.state, 'merged');
    assert.equal(githubEvent('pull_request', { action: 'closed', pull_request: { ...base, state: 'closed', merged: false }, repository: ghRepo })?.pullRequest?.state, 'closed');
  });

  it('maps GitHub deployment statuses and skips superseded ones', () => {
    const ev = (state: string) => githubEvent('deployment_status', { deployment_status: { state, environment_url: 'https://pay.acme.test' }, deployment: { id: 99, sha: 'deadbeef', environment: 'production', creator: { login: 'ci' } }, repository: ghRepo });
    assert.equal(ev('success')?.deployment?.status, 'succeeded');
    assert.equal(ev('failure')?.deployment?.status, 'failed');
    assert.equal(ev('queued')?.deployment?.status, 'in_progress');
    assert.equal(ev('inactive')?.deployment, undefined);
    assert.equal(ev('success')?.deployment?.externalId, '99');
  });

  it('never keeps a non-http link', () => {
    const ev = githubEvent('deployment_status', { deployment_status: { state: 'success', target_url: 'javascript:alert(1)' }, deployment: { id: 1, environment: 'prod' }, repository: { ...ghRepo, html_url: 'data:text/html,x' } });
    assert.equal(ev?.deployment?.url, null);
    assert.equal(ev?.repo.url, null);
  });

  it('reads GitLab push, merge request and deployment hooks', () => {
    const push = gitlabEvent('Push Hook', { ref: 'refs/heads/main', checkout_sha: 'c0ffee1', user_username: 'cy', project: glProject, commits: [{ id: 'c0ffee1', message: 'Ship it', timestamp: '2026-09-03T00:00:00Z' }] });
    assert.equal(push?.push?.message, 'Ship it');
    assert.equal(gitlabEvent('Push Hook', { ref: 'refs/heads/gone', checkout_sha: null, after: '0000000000000000000000000000000000000000', project: glProject })?.push, undefined);
    const mr = gitlabEvent('Merge Request Hook', { user: { username: 'cy' }, project: glProject, object_attributes: { iid: 3, title: 'Refactor', state: 'merged', url: 'https://gitlab.com/acme/web/-/merge_requests/3', created_at: '2026-09-01 10:00:00 UTC', updated_at: '2026-09-02T10:00:00Z' } });
    assert.equal(mr?.pullRequest?.state, 'merged');
    assert.equal(mr?.pullRequest?.number, 3);
    const dep = gitlabEvent('Deployment Hook', { status: 'failed', deployment_id: 12, environment: 'staging', short_sha: 'c0ffee1', project: glProject, user: { username: 'cy' } });
    assert.equal(dep?.deployment?.status, 'failed');
    assert.equal(gitlabEvent('Pipeline Hook', { project: glProject })?.deployment, undefined);
    assert.equal(gitlabEvent('Push Hook', {}), null, 'no project, nothing to record');
  });

  it('guesses environment kinds from names', () => {
    assert.equal(environmentKind('production'), 'production');
    assert.equal(environmentKind('prod'), 'production');
    assert.equal(environmentKind('eu-prod'), 'production');
    assert.equal(environmentKind('staging'), 'staging');
    assert.equal(environmentKind('review/feature-x'), 'development');
    assert.equal(environmentKind('sandbox'), 'other');
    assert.equal(environmentKind('product-demo'), 'other');
  });
});

describe('service scorecard', () => {
  const blank: ScorecardFacts = {
    tier: 'standard', kind: 'service', lifecycle: 'production', hasOwner: false, hasDescription: false, hasEscalationPolicy: false,
    alertIntegrations: 0, runbooks: 0, repositories: 0, productionEnvironments: 0, lastProductionDeployAt: null, activeApis: 0,
    activeApisWithSpec: 0, checklistTotal: 0, checklistDone: 0, majorIncidentsResolved: 0, majorPostmortemsPublished: 0,
  };
  const now = new Date('2026-09-14T00:00:00Z');

  it('leaves out rules that do not apply rather than passing them', () => {
    const card = evaluateScorecard(blank, now);
    const applies = card.rules.filter((r) => r.applies).map((r) => r.id);
    assert.deepEqual(applies, ['owner', 'description', 'repository', 'runbook', 'environment', 'deployed']);
    assert.equal(card.percent, 0);
    assert.equal(card.level, 'needs_work');
  });

  it('asks more of critical services and less of libraries', () => {
    assert.ok(evaluateScorecard({ ...blank, tier: 'critical' }, now).rules.find((r) => r.id === 'escalation')!.applies);
    const lib = evaluateScorecard({ ...blank, kind: 'library', tier: 'critical' }, now);
    assert.deepEqual(lib.rules.filter((r) => r.applies).map((r) => r.id), ['owner', 'description', 'repository']);
  });

  it('scores a well-kept service gold and notices a stale deploy', () => {
    const good: ScorecardFacts = { ...blank, tier: 'critical', hasOwner: true, hasDescription: true, hasEscalationPolicy: true, alertIntegrations: 1, runbooks: 1, repositories: 1, productionEnvironments: 1, lastProductionDeployAt: new Date('2026-09-01T00:00:00Z'), activeApis: 2, activeApisWithSpec: 2, checklistTotal: 3, checklistDone: 3, majorIncidentsResolved: 1, majorPostmortemsPublished: 1 };
    assert.deepEqual([evaluateScorecard(good, now).percent, evaluateScorecard(good, now).level], [100, 'gold']);
    const stale = evaluateScorecard({ ...good, lastProductionDeployAt: new Date('2026-05-01T00:00:00Z') }, now);
    assert.equal(stale.rules.find((r) => r.id === 'deployed')!.passed, false);
    assert.equal(stale.level, 'gold', '10 of 11 is still 91%');
    const missingSpec = evaluateScorecard({ ...good, activeApisWithSpec: 1, majorPostmortemsPublished: 0, runbooks: 0 }, now);
    assert.equal(missingSpec.percent, 73);
    assert.equal(missingSpec.level, 'silver');
  });
});
