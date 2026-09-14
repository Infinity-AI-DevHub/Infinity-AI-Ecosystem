/**
 * Shared types and small presentational pieces for the engineering catalogue.
 */
import { CheckCircle2, CircleDashed, RotateCcw, XCircle } from 'lucide-react';

export type ServiceKind = 'service' | 'website' | 'library' | 'job' | 'data' | 'mobile';
export type Lifecycle = 'experimental' | 'production' | 'deprecated';
export type Tier = 'critical' | 'high' | 'standard';
export type DeploymentStatus = 'in_progress' | 'succeeded' | 'failed' | 'rolled_back';
export type ScoreLevel = 'gold' | 'silver' | 'bronze' | 'needs_work' | 'not_scored';

export const KIND_LABEL: Record<ServiceKind, string> = { service: 'Service', website: 'Website', library: 'Library', job: 'Scheduled job', data: 'Data store', mobile: 'Mobile app' };
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = { experimental: 'Experimental', production: 'Production', deprecated: 'Deprecated' };
export const TIER_LABEL: Record<Tier, string> = { critical: 'Critical', high: 'High', standard: 'Standard' };
export const DEPLOYMENT_LABEL: Record<DeploymentStatus, string> = { in_progress: 'In progress', succeeded: 'Succeeded', failed: 'Failed', rolled_back: 'Rolled back' };
export const LEVEL_LABEL: Record<ScoreLevel, string> = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze', needs_work: 'Needs work', not_scored: 'Not scored' };
export const PROTOCOL_LABEL: Record<string, string> = { rest: 'REST', graphql: 'GraphQL', grpc: 'gRPC', event: 'Events', soap: 'SOAP', other: 'Other' };

export type RuleResult = { id: string; label: string; applies: boolean; passed: boolean; hint: string };
export type Scorecard = { percent: number | null; level: ScoreLevel; passed: number; applicable: number; rules: RuleResult[] };

export type CatalogueItem = {
  id: string; name: string; description: string | null; tier: Tier; kind: ServiceKind; lifecycle: Lifecycle; language: string | null;
  status: string; isActive: boolean; owner: { id: string; name: string | null } | null; team: { id: string; name: string | null } | null; repositories: number; openPullRequests: number;
  lastDeployment: { status: DeploymentStatus; environment: string; version: string | null; at: string } | null;
  score: { percent: number | null; level: ScoreLevel };
};

export type Deployment = {
  id: string; service: { id: string; name: string; tier: Tier }; environment: { name: string; kind: string };
  version: string | null; commitSha: string | null; status: DeploymentStatus; source: 'manual' | 'github' | 'gitlab'; url: string | null; notes: string | null;
  change: { id: string; ref: string } | null; withoutChange: boolean; deployedBy: string | null; startedAt: string; finishedAt: string | null;
};

export function ScoreBadge({ percent, level }: { percent: number | null; level: ScoreLevel }) {
  return (
    <span className={`eg-score eg-score-${level}`} title={percent === null ? 'No rules apply' : `${percent}% of applicable checks pass`}>
      {LEVEL_LABEL[level]}{percent !== null ? <span className="eg-score-pct">{percent}%</span> : null}
    </span>
  );
}

export function DeploymentBadge({ status }: { status: DeploymentStatus }) {
  const Icon = status === 'succeeded' ? CheckCircle2 : status === 'failed' ? XCircle : status === 'rolled_back' ? RotateCcw : CircleDashed;
  return <span className={`eg-deploy eg-deploy-${status}`}><Icon size={13} aria-hidden="true" />{DEPLOYMENT_LABEL[status]}</span>;
}

export function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  return <span className={`sd-badge eg-life-${lifecycle}`}>{LIFECYCLE_LABEL[lifecycle]}</span>;
}

export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : null);
