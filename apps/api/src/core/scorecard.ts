/**
 * Service scorecards: whether a catalogue entry meets the company's baseline for running
 * software. Computed from facts every time, never stored, so fixing a gap shows at once.
 *
 * A rule that does not apply (a library has no production environment; a service with no
 * APIs has nothing to document) is left out of the score instead of counting as passed.
 */

export type ScorecardFacts = {
  tier: 'critical' | 'high' | 'standard';
  kind: string;
  lifecycle: string;
  hasOwner: boolean;
  hasDescription: boolean;
  hasEscalationPolicy: boolean;
  alertIntegrations: number;
  runbooks: number;
  repositories: number;
  productionEnvironments: number;
  lastProductionDeployAt: Date | null;
  activeApis: number;
  activeApisWithSpec: number;
  checklistTotal: number;
  checklistDone: number;
  majorIncidentsResolved: number;
  majorPostmortemsPublished: number;
};

export type RuleResult = { id: string; label: string; applies: boolean; passed: boolean; hint: string };
export type Scorecard = { percent: number | null; level: 'gold' | 'silver' | 'bronze' | 'needs_work' | 'not_scored'; passed: number; applicable: number; rules: RuleResult[] };

export const SCORECARD_RULES = [
  { id: 'owner', label: 'Has an owner' },
  { id: 'description', label: 'Describes what it does' },
  { id: 'repository', label: 'Code repository linked' },
  { id: 'runbook', label: 'Runbook linked' },
  { id: 'escalation', label: 'Escalation policy set' },
  { id: 'monitoring', label: 'Monitoring sends alerts' },
  { id: 'environment', label: 'Production environment defined' },
  { id: 'deployed', label: 'Deployed to production in the last 90 days' },
  { id: 'api_specs', label: 'Every active API has a spec' },
  { id: 'onboarding', label: 'Onboarding checklist complete' },
  { id: 'postmortems', label: 'Postmortems published for SEV1/2 incidents' },
] as const;

const DAY = 86_400_000;

export function evaluateScorecard(f: ScorecardFacts, now = new Date()): Scorecard {
  const runs = f.kind !== 'library';
  const important = f.tier === 'critical' || f.tier === 'high';
  const check: Record<(typeof SCORECARD_RULES)[number]['id'], [boolean, boolean, string]> = {
    owner: [true, f.hasOwner, 'Assign the person accountable for it.'],
    description: [true, f.hasDescription, 'Add a sentence on what it does and who uses it.'],
    repository: [true, f.repositories > 0, 'Link the repository from Repositories.'],
    runbook: [runs, f.runbooks > 0, 'Link a runbook: a knowledge base article or a document.'],
    escalation: [runs && important, f.hasEscalationPolicy, 'Critical and high tier services need someone to page.'],
    monitoring: [runs && important, f.alertIntegrations > 0, 'Connect a monitoring tool or a heartbeat on the service status page.'],
    environment: [runs, f.productionEnvironments > 0, 'Add the production environment.'],
    deployed: [runs && f.lifecycle === 'production', f.lastProductionDeployAt !== null && now.getTime() - f.lastProductionDeployAt.getTime() <= 90 * DAY, 'No production deployment recorded in 90 days.'],
    api_specs: [f.activeApis > 0, f.activeApisWithSpec >= f.activeApis, 'Add a spec link to each active API.'],
    onboarding: [f.checklistTotal > 0, f.checklistDone >= f.checklistTotal, 'Finish the onboarding checklist.'],
    postmortems: [f.majorIncidentsResolved > 0, f.majorPostmortemsPublished >= f.majorIncidentsResolved, 'Publish the postmortem for each resolved SEV1 or SEV2 incident.'],
  };
  const rules = SCORECARD_RULES.map((r) => {
    const [applies, passed, hint] = check[r.id];
    return { id: r.id, label: r.label, applies, passed: applies && passed, hint };
  });
  const applicable = rules.filter((r) => r.applies).length;
  const passed = rules.filter((r) => r.passed).length;
  if (applicable === 0) return { percent: null, level: 'not_scored', passed, applicable, rules };
  const percent = Math.round((passed / applicable) * 100);
  const level = percent >= 90 ? 'gold' : percent >= 70 ? 'silver' : percent >= 50 ? 'bronze' : 'needs_work';
  return { percent, level, passed, applicable, rules };
}
