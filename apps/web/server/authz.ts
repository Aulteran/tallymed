import { AppError } from './errors.ts';

export type Role = 'admin' | 'operator';
export type Capability = 'household:read' | 'operators:manage' | 'audit:read' | 'expenses:read' | 'expenses:write' | 'assistant:manage';

const CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set<Capability>(['household:read', 'operators:manage', 'audit:read', 'expenses:read', 'expenses:write', 'assistant:manage']),
  operator: new Set<Capability>(['household:read', 'expenses:read', 'expenses:write']),
};

/** The authenticated actor. Derived only from a validated server-side session. */
export interface Actor {
  userId: string;
  householdId: string;
  role: Role;
  displayName: string;
  sessionId: string;
}

export function can(actor: Actor, capability: Capability): boolean {
  return CAPABILITIES[actor.role]?.has(capability) ?? false;
}

export function authorize(actor: Actor, capability: Capability): void {
  if (!can(actor, capability)) throw new AppError('forbidden');
}

/** Rejects records outside the actor's household with the same error as a missing record. */
export function assertHousehold(actor: Actor, householdId: string | null | undefined): void {
  if (householdId !== actor.householdId) throw new AppError('not_found');
}
