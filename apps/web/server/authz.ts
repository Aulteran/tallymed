import { AppError } from './errors.ts';

export type Role = 'admin' | 'operator';
export type Capability = 'household:read' | 'operators:manage' | 'audit:read' | 'expenses:read' | 'expenses:write' | 'assistant:manage' | 'settings:manage' | 'records:remove';

const CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set<Capability>(['household:read', 'operators:manage', 'audit:read', 'expenses:read', 'expenses:write', 'assistant:manage', 'settings:manage', 'records:remove']),
  operator: new Set<Capability>(['household:read', 'expenses:read', 'expenses:write']),
};

/** The authenticated actor. Derived only from a validated server-side session. */
export interface Actor {
  userId: string;
  householdId: string;
  role: Role;
  displayName: string;
  sessionId: string;
  /** True until the person replaces an administrator-issued temporary password. Such an actor may only change the password or sign out. */
  mustChangePassword: boolean;
  /** True while the session is locked: it is still signed in, but every route except unlock, lock and sign-out refuses it until the PIN is entered. */
  locked: boolean;
  /** Whether the account has a PIN. An account without one is never locked. */
  hasPin: boolean;
  /** Whether this session was started with "Keep me signed in". */
  remember: boolean;
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
