import type { Queryable } from '../db.ts';

export interface AuditEntry {
  householdId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

/** Callers pass the same client as the state change so the audit row commits atomically with it. */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_events (household_id, actor_user_id, action, entity_type, entity_id, request_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.householdId, entry.actorUserId, entry.action, entry.entityType, entry.entityId ?? null,
      entry.requestId ?? null, JSON.stringify(entry.detail ?? {})],
  );
}
