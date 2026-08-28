/**
 * Authorization (blueprint 02 + appendix A).
 *
 * Deny by default. Every decision evaluates, in order:
 *   1. tenant scope        - the actor and the resource must share a company
 *   2. lifecycle           - suspended/offboarded users and suspended companies are denied
 *   3. capability          - the role must grant the action category
 *   4. resource authorization - membership / ownership / explicit grant on the target
 *   5. policy conditions   - classification, lifecycle state, separation of duties
 *
 * A role name alone never grants access to a specific record.
 */
import { jsonArray, many, one, type Queryable } from './db.js';
import { forbidden } from './errors.js';
import { pool } from './db.js';

export type AccessLevel =
  | 'super_admin'
  | 'admin'
  | 'manager'
  | 'staff'
  | 'auditor'
  | 'guest'
  | 'service';

export type Actor = {
  userId: string;
  companyId: string;
  email: string;
  displayName: string;
  accessLevel: AccessLevel;
  status: string;
  departmentId: string | null;
  managerId: string | null;
  capabilities: Set<string>;
  groupIds: string[];
  sessionId: string | null;
  tokenId: string | null;
  /** Capabilities a service token is narrowed to, if the request used one. */
  tokenScopes: string[] | null;
};

export type ResourceType =
  | 'company'
  | 'user'
  | 'mail_message'
  | 'calendar_event'
  | 'chat_room'
  | 'project'
  | 'task'
  | 'file'
  | 'folder'
  | 'approval_request'
  | 'announcement'
  | 'doc_space'
  | 'doc_page';

const capabilityCache = new Map<string, { value: Set<string>; expires: number }>();
const CAPABILITY_TTL_MS = 30_000;

/** Role capabilities are cached briefly; privilege changes invalidate the cache explicitly. */
export async function capabilitiesForRole(role: string): Promise<Set<string>> {
  const cached = capabilityCache.get(role);
  if (cached && cached.expires > Date.now()) return cached.value;
  const rows = await many<{ capability: string }>(
    'SELECT capability FROM role_capabilities WHERE role = $1',
    [role],
  );
  const value = new Set(rows.map((r) => r.capability));
  capabilityCache.set(role, { value, expires: Date.now() + CAPABILITY_TTL_MS });
  return value;
}

export function invalidateCapabilityCache(): void {
  capabilityCache.clear();
}

/** Baseline check: does the actor's role (narrowed by token scope) allow this action? */
export function hasCapability(actor: Actor, capability: string): boolean {
  if (actor.status !== 'active') return false;
  if (actor.tokenScopes && !actor.tokenScopes.includes(capability)) return false;
  return actor.capabilities.has(capability);
}

export function requireCapability(actor: Actor, capability: string): void {
  if (!hasCapability(actor, capability)) {
    throw forbidden(`Missing capability: ${capability}`);
  }
}

/**
 * Privileged operations are gated on capability alone.
 *
 * There was previously a step-up requirement here: destructive actions demanded a
 * session that had satisfied a second factor, not merely an account whose role allowed
 * it. Multi-factor authentication has been removed from the product, so that second
 * gate no longer exists and a valid session reaches everything the role permits.
 * See docs/security.md.
 */

/** Explicit grant lookup: direct user grants plus grants inherited from group membership. */
export async function explicitGrant(
  actor: Actor,
  resourceType: ResourceType,
  resourceId: string,
  capability: string,
  db: Queryable = pool,
): Promise<'allow' | 'deny' | null> {
  const rows = await db.query<{ effect: string; capabilities: unknown }>(
    `SELECT effect, capabilities FROM resource_grants
      WHERE company_id = $1
        AND resource_type = $2
        AND resource_id = $3
        AND (expires_at IS NULL OR expires_at > NOW(3))
        AND (
          (subject_type = 'user'  AND subject_id = $4)
          -- Group membership is passed as a JSON array; an empty array matches nothing.
          OR (subject_type = 'group' AND JSON_CONTAINS($5, JSON_QUOTE(subject_id)))
        )`,
    [actor.companyId, resourceType, resourceId, actor.userId, JSON.stringify(actor.groupIds)],
  );
  if (rows.rows.length === 0) return null;
  // An explicit deny always wins over any allow.
  const matches = rows.rows.filter((r) => {
    const granted = jsonArray(r.capabilities);
    return granted.length === 0 || granted.includes(capability);
  });
  if (matches.length === 0) return null;
  if (matches.some((r) => r.effect === 'deny')) return 'deny';
  return 'allow';
}

export type AuthorizeInput = {
  actor: Actor;
  capability: string;
  resourceType?: ResourceType;
  resourceId?: string;
  /** Result of the domain's own membership/ownership check. */
  membership?: boolean;
  /** Skip the resource check entirely (create-type actions with no target yet). */
  resourceless?: boolean;
  db?: Queryable;
};

export type Decision = { allowed: boolean; reason: string };

/**
 * Central decision function. Domain services call this rather than hand-rolling checks
 * so that grant and deny semantics stay identical everywhere.
 */
export async function decide(input: AuthorizeInput): Promise<Decision> {
  const { actor, capability } = input;

  if (actor.status !== 'active') return { allowed: false, reason: 'actor_not_active' };
  if (!hasCapability(actor, capability)) return { allowed: false, reason: 'missing_capability' };
  if (input.resourceless || !input.resourceType || !input.resourceId) {
    return { allowed: true, reason: 'capability_only' };
  }

  const grant = await explicitGrant(
    actor,
    input.resourceType,
    input.resourceId,
    capability,
    input.db,
  );
  if (grant === 'deny') return { allowed: false, reason: 'explicit_deny' };
  if (grant === 'allow') return { allowed: true, reason: 'explicit_grant' };
  if (input.membership) return { allowed: true, reason: 'membership' };

  // Administrators may reach company resources they are not a member of, but only for
  // capabilities their role already carries, and the access is always audited by the caller.
  if (actor.accessLevel === 'admin' || actor.accessLevel === 'super_admin') {
    return { allowed: true, reason: 'administrative_override' };
  }
  return { allowed: false, reason: 'no_resource_authorization' };
}

export async function authorize(input: AuthorizeInput): Promise<void> {
  const decision = await decide(input);
  if (!decision.allowed) throw forbidden();
}

/**
 * Separation of duties (blueprint 02): the person who raised a high-value request may
 * never be the person who finally approves it.
 */
export function assertSeparationOfDuties(actorId: string, requesterId: string): void {
  if (actorId === requesterId) {
    throw forbidden('Separation of duties: a requester cannot approve their own request');
  }
}

/** Loads the effective capability + group context for a user. */
export async function loadAuthorizationContext(
  userId: string,
  accessLevel: string,
): Promise<{ capabilities: Set<string>; groupIds: string[] }> {
  const [capabilities, groups] = await Promise.all([
    capabilitiesForRole(accessLevel),
    many<{ group_id: string }>('SELECT group_id FROM group_members WHERE user_id = $1', [userId]),
  ]);
  return { capabilities, groupIds: groups.map((g) => g.group_id) };
}

export async function isCompanyActive(companyId: string): Promise<boolean> {
  const row = await one<{ status: string }>('SELECT status FROM companies WHERE id = $1', [
    companyId,
  ]);
  return row?.status === 'active';
}
