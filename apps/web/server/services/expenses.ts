// Use cases for medical expense management. Each mutation authorizes, validates, locks, writes and audits in one
// transaction. Money is bigint cents. No payment records exist yet, so open balance equals household responsibility.
import { createHash, randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import { isUniqueViolation, withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { MAX_CENTS } from '../money.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as repo from '../repositories/expenses.ts';
import { filterSchemas, parse, schemas } from '../validation.ts';

type Detail = Record<string, string | number | boolean | null>;
const isArchived = (p: repo.Party | repo.Visit | null) => p !== null && 'archivedAt' in p && p.archivedAt !== null;

function fingerprint(input: Record<string, unknown>): string {
  const canonical = Object.keys(input).sort().map((k) => [k, typeof input[k] === 'bigint' ? String(input[k]) : input[k]]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Returns the stored result id for an exact replay, throws on the same key with different input, or null to proceed. */
async function idempotent(tx: Queryable, actor: Actor, operation: string, key: string, input: Record<string, unknown>, resultId: string): Promise<string | null> {
  const claim = await repo.claimIdempotency(tx, {
    householdId: actor.householdId, actorUserId: actor.userId, operation, key, fingerprint: fingerprint(input), resultId,
  });
  if (!claim.replay) return null;
  if (!claim.sameInput) throw new AppError('conflict', 'That request key was already used with different details');
  return claim.resultId;
}

// ---------- members and providers ----------

export const listMembers = async (pool: Pool, actor: Actor, raw: unknown) => {
  authorize(actor, 'expenses:read');
  return repo.listParties(pool, 'family_members', actor.householdId, parse(filterSchemas.party, raw));
};
export const listProviders = async (pool: Pool, actor: Actor, raw: unknown) => {
  authorize(actor, 'expenses:read');
  return repo.listParties(pool, 'providers', actor.householdId, parse(filterSchemas.party, raw));
};
export async function getMember(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const m = await repo.getParty(pool, 'family_members', actor.householdId, parse(schemas.id, id), false);
  if (!m) throw new AppError('not_found');
  return m;
}
export async function getProvider(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const p = await repo.getParty(pool, 'providers', actor.householdId, parse(schemas.id, id), false);
  if (!p) throw new AppError('not_found');
  return p;
}

export async function createMember(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.createMember, input);
  return withTransaction(pool, async (tx) => {
    const id = await repo.insertMember(tx, { householdId: actor.householdId, userId: actor.userId, name: d.name, dateOfBirth: d.dateOfBirth, notes: d.notes });
    await recordAudit(tx, { householdId: actor.householdId, actorUserId: actor.userId, action: 'member.created', entityType: 'family_member', entityId: id, requestId });
    return { id };
  });
}

export async function updateMember(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.updateMember, input);
  return withTransaction(pool, async (tx) => {
    const current = await repo.getParty(tx, 'family_members', actor.householdId, d.id, 'update');
    if (!current) throw new AppError('not_found');
    if (current.version !== d.version) throw new AppError('stale_version');
    await repo.updateMember(tx, actor.householdId, d.id, d.version, { name: d.name, dateOfBirth: d.dateOfBirth, notes: d.notes });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'member.updated', entityType: 'family_member', entityId: d.id, requestId,
      detail: { renamed: current.name !== d.name },
    });
    return { id: d.id };
  });
}

export async function createProvider(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.createProvider, input);
  return withTransaction(pool, async (tx) => {
    const id = await repo.insertProvider(tx, { householdId: actor.householdId, userId: actor.userId, name: d.name, kind: d.kind, notes: d.notes });
    await recordAudit(tx, { householdId: actor.householdId, actorUserId: actor.userId, action: 'provider.created', entityType: 'provider', entityId: id, requestId });
    return { id };
  });
}

export async function updateProvider(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.updateProvider, input);
  return withTransaction(pool, async (tx) => {
    const current = await repo.getParty(tx, 'providers', actor.householdId, d.id, 'update');
    if (!current) throw new AppError('not_found');
    if (current.version !== d.version) throw new AppError('stale_version');
    await repo.updateProvider(tx, actor.householdId, d.id, d.version, { name: d.name, kind: d.kind, notes: d.notes });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'provider.updated', entityType: 'provider', entityId: d.id, requestId,
      detail: { renamed: current.name !== d.name },
    });
    return { id: d.id };
  });
}

/** Archiving keeps every historical link. It takes the row lock that new visits and bills share-lock, so it serializes with them. */
async function archive(pool: Pool, actor: Actor, table: repo.PartyTable, entity: string, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.archive, input);
  return withTransaction(pool, async (tx) => {
    const current = await repo.getParty(tx, table, actor.householdId, d.id, 'update');
    if (!current) throw new AppError('not_found');
    if (current.version !== d.version) throw new AppError('stale_version');
    await repo.setArchived(tx, table, actor.householdId, d.id, d.version, d.archived);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: `${entity}.${d.archived ? 'archived' : 'unarchived'}`,
      entityType: table === 'providers' ? 'provider' : 'family_member', entityId: d.id, requestId,
    });
    return { id: d.id };
  });
}
export const archiveMember = (pool: Pool, actor: Actor, input: unknown, requestId: string) => archive(pool, actor, 'family_members', 'member', input, requestId);
export const archiveProvider = (pool: Pool, actor: Actor, input: unknown, requestId: string) => archive(pool, actor, 'providers', 'provider', input, requestId);

/** Share-locks a member or provider for the transaction and requires it to be active. */
async function requireActive(tx: Queryable, table: repo.PartyTable, householdId: string, id: string): Promise<repo.Party> {
  const p = await repo.getParty(tx, table, householdId, id, 'share');
  if (!p) throw new AppError('not_found');
  if (isArchived(p)) throw new AppError('conflict', `That ${table === 'providers' ? 'provider' : 'family member'} is archived`);
  return p;
}

/** How many records a select list shows before it is marked as truncated. */
export const PICK_LIMIT = 100;
export interface PickList<T> { items: T[]; truncated: boolean }

/**
 * Options for a member or provider select. The record that is currently selected is always included, even when it
 * falls outside the first PICK_LIMIT matches, so saving a form can never silently switch it. `truncated` tells the page
 * to offer a search. An invalid or foreign `currentId` is ignored.
 */
export async function pickParties(pool: Pool, actor: Actor, kind: 'members' | 'providers', o: { q?: string; archived?: boolean; currentId?: string | null }): Promise<PickList<repo.Party>> {
  authorize(actor, 'expenses:read');
  const table = kind === 'members' ? 'family_members' : 'providers';
  const page = await repo.listParties(pool, table, actor.householdId, parse(filterSchemas.party, { q: o.q, archived: o.archived ? 'yes' : undefined, limit: PICK_LIMIT }));
  const items = [...page.items];
  const current = o.currentId && schemas.id.safeParse(o.currentId).success ? o.currentId : null;
  if (current && !items.some((i) => i.id === current)) {
    const found = await repo.getParty(pool, table, actor.householdId, current, false);
    if (found) items.unshift(found);
  }
  return { items, truncated: page.nextCursor !== null };
}

/** Visit options for a bill's member, with the currently linked visit always included. */
export async function pickVisits(pool: Pool, actor: Actor, o: { memberId?: string | null; q?: string; currentId?: string | null }): Promise<PickList<repo.Visit>> {
  authorize(actor, 'expenses:read');
  const page = await repo.listVisits(pool, actor.householdId, parse(filterSchemas.visit, { ...(o.memberId ? { memberId: o.memberId } : {}), ...(o.q ? { q: o.q } : {}), limit: PICK_LIMIT }));
  const items = [...page.items];
  const current = o.currentId && schemas.id.safeParse(o.currentId).success ? o.currentId : null;
  if (current && !items.some((i) => i.id === current)) {
    const found = await repo.getVisit(pool, actor.householdId, current, false);
    if (found) items.unshift(found);
  }
  return { items, truncated: page.nextCursor !== null };
}

// ---------- visits ----------

export async function listVisits(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return repo.listVisits(pool, actor.householdId, parse(filterSchemas.visit, raw));
}
export async function getVisit(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const visit = await repo.getVisit(pool, actor.householdId, parse(schemas.id, id));
  if (!visit) throw new AppError('not_found');
  const bills = await repo.listBills(pool, actor.householdId, parse(filterSchemas.bill, { visitId: visit.id, limit: 100 }));
  return { visit, bills: bills.items };
}

export async function createVisit(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.createVisit, input);
  return withTransaction(pool, async (tx) => {
    const member = await requireActive(tx, 'family_members', actor.householdId, d.memberId);
    const provider = await requireActive(tx, 'providers', actor.householdId, d.providerId);
    const id = await repo.insertVisit(tx, {
      householdId: actor.householdId, userId: actor.userId, memberId: d.memberId, providerId: d.providerId, serviceDate: d.serviceDate,
      description: d.description, notes: d.notes, memberName: member.name, providerName: provider.name,
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'visit.created', entityType: 'visit', entityId: id, requestId,
      detail: { memberId: d.memberId, providerId: d.providerId, serviceDate: d.serviceDate },
    });
    return { id };
  });
}

/** The member of a visit is fixed because bills inherit it; change the provider, date and text only. */
export async function updateVisit(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.updateVisit, input);
  return withTransaction(pool, async (tx) => {
    const current = await repo.getVisit(tx, actor.householdId, d.id, 'update');
    if (!current) throw new AppError('not_found');
    if (current.version !== d.version) throw new AppError('stale_version');
    let providerName: string | null = null;
    if (d.providerId !== current.providerId) providerName = (await requireActive(tx, 'providers', actor.householdId, d.providerId)).name;
    await repo.updateVisit(tx, actor.householdId, d.id, d.version, {
      providerId: d.providerId, providerName, serviceDate: d.serviceDate, description: d.description, notes: d.notes,
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'visit.updated', entityType: 'visit', entityId: d.id, requestId,
      detail: { providerChanged: providerName !== null, dateChanged: current.serviceDate !== d.serviceDate },
    });
    return { id: d.id };
  });
}

// ---------- bills ----------

export async function listBills(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return repo.listBills(pool, actor.householdId, parse(filterSchemas.bill, raw));
}

export async function getBillDetail(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const billId = parse(schemas.id, id);
  const bill = await repo.getBill(pool, actor.householdId, billId);
  if (!bill) throw new AppError('not_found');
  const [adjustments, duplicates, history] = await Promise.all([
    repo.listAdjustments(pool, actor.householdId, billId),
    repo.listDuplicatesOf(pool, actor.householdId, billId),
    repo.billHistory(pool, actor.householdId, billId),
  ]);
  return { bill, adjustments, duplicates, history };
}

/** Duplicate hints for a prospective bill, used to warn before saving. Never merges anything. */
export async function duplicateHints(pool: Pool, actor: Actor, c: {
  providerId: string; memberId: string; providerReference: string | null; statementDate: string; originalCents: bigint;
}): Promise<string[]> {
  authorize(actor, 'expenses:read');
  return repo.findDuplicateBills(pool, actor.householdId, c);
}

export async function createBill(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { idempotencyKey, confirmDuplicate, csrf: _csrf, ...fields } = parse(schemas.createBill, input);
  const d = { ...fields, idempotencyKey };
  const baseCents = d.responsibilityAmount ?? d.originalAmount;
  if (baseCents > d.originalAmount) throw new AppError('invalid_input', 'Household responsibility cannot exceed the billed amount');
  const id = randomUUID();
  return withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'bill.create', idempotencyKey, fields, id);
    if (replayId) return { id: replayId, replayed: true };
    const member = await requireActive(tx, 'family_members', actor.householdId, d.memberId);
    const provider = await requireActive(tx, 'providers', actor.householdId, d.providerId);
    if (d.visitId) {
      const visit = await repo.getVisit(tx, actor.householdId, d.visitId, 'share');
      if (!visit) throw new AppError('not_found');
      if (visit.memberId !== d.memberId) throw new AppError('invalid_input', 'The visit belongs to a different family member');
    }
    if (!confirmDuplicate) {
      const hints = await repo.findDuplicateBills(tx, actor.householdId, {
        providerId: d.providerId, memberId: d.memberId, providerReference: d.providerReference, statementDate: d.statementDate, originalCents: d.originalAmount,
      });
      if (hints.length > 0) throw new AppError('duplicate_warning', 'A similar bill already exists for this provider. Review it, then confirm to save anyway.');
    }
    await repo.insertBill(tx, {
      id, householdId: actor.householdId, userId: actor.userId, memberId: d.memberId, providerId: d.providerId, visitId: d.visitId,
      providerReference: d.providerReference, statementDate: d.statementDate, dueDate: d.dueDate, originalCents: d.originalAmount, baseCents,
      status: d.amountStatus, source: d.amountSource, sourceNote: d.sourceNote, notes: d.notes, memberName: member.name, providerName: provider.name,
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'bill.created', entityType: 'bill', entityId: id, requestId,
      detail: {
        status: d.amountStatus, source: d.amountSource, originalCents: d.originalAmount.toString(), responsibilityCents: baseCents.toString(),
        visitLinked: d.visitId !== null, duplicateConfirmed: Boolean(confirmDuplicate),
      },
    });
    return { id, replayed: false };
  });
}

/** Estimates may change freely; once confirmed, amounts only change through adjustments. */
export async function updateBill(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.updateBill, input);
  return withTransaction(pool, async (tx) => {
    const [bill] = await repo.lockBills(tx, actor.householdId, [d.id]);
    if (!bill) throw new AppError('not_found');
    if (bill.version !== d.version) throw new AppError('stale_version');
    if (bill.amountStatus === 'confirmed' && (d.originalAmount !== null || d.responsibilityAmount !== null)) {
      throw new AppError('conflict', 'Confirmed amounts change only through adjustments');
    }
    const original = d.originalAmount ?? bill.originalCents;
    const base = d.responsibilityAmount ?? bill.baseResponsibilityCents;
    if (base > original) throw new AppError('invalid_input', 'Household responsibility cannot exceed the billed amount');
    if (base + bill.adjustmentsCents < 0n) throw new AppError('conflict', 'Responsibility cannot be negative after adjustments');
    let providerName: string | null = null;
    if (d.providerId !== bill.providerId) providerName = (await requireActive(tx, 'providers', actor.householdId, d.providerId)).name;
    const current = await repo.getBill(tx, actor.householdId, d.id);
    await repo.updateBill(tx, actor.householdId, d.id, d.version, {
      providerId: d.providerId, providerName, providerReference: d.providerReference, statementDate: d.statementDate, dueDate: d.dueDate,
      originalCents: original, baseCents: base, source: d.amountSource ?? current!.amountSource, sourceNote: d.sourceNote, notes: d.notes,
    });
    // Every identifying or provenance field records old and new values, so a confirmed bill's history can always show what
    // changed. Free-text notes record only a changed flag (they are not evidence); the source note is provenance, so its
    // previous and new text are kept (bounded to 500 characters by the schema).
    const detail: Detail = { providerChanged: d.providerId !== bill.providerId };
    const track = (name: string, from: string | null, to: string | null) => {
      if (from !== to) Object.assign(detail, { [`from${name}`]: from, [`to${name}`]: to });
    };
    track('ProviderId', bill.providerId, d.providerId);
    track('ProviderReference', current!.providerReference, d.providerReference);
    track('StatementDate', current!.statementDate, d.statementDate);
    track('DueDate', current!.dueDate, d.dueDate);
    track('AmountSource', current!.amountSource, d.amountSource ?? current!.amountSource);
    track('SourceNote', current!.sourceNote, d.sourceNote);
    track('OriginalCents', bill.originalCents.toString(), original.toString());
    track('ResponsibilityCents', bill.baseResponsibilityCents.toString(), base.toString());
    if (current!.notes !== d.notes) detail.notesChanged = true;
    await recordAudit(tx, { householdId: actor.householdId, actorUserId: actor.userId, action: 'bill.updated', entityType: 'bill', entityId: d.id, requestId, detail });
    return { id: d.id };
  });
}

export async function confirmBillAmounts(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.confirmBill, input);
  return withTransaction(pool, async (tx) => {
    const [bill] = await repo.lockBills(tx, actor.householdId, [d.id]);
    if (!bill) throw new AppError('not_found');
    if (bill.version !== d.version) throw new AppError('stale_version');
    if (bill.amountStatus === 'confirmed') throw new AppError('conflict', 'The amounts are already confirmed');
    await repo.confirmBill(tx, actor.householdId, d.id, d.version, actor.userId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'bill.confirmed', entityType: 'bill', entityId: d.id, requestId,
      detail: { originalCents: bill.originalCents.toString(), responsibilityCents: (bill.baseResponsibilityCents + bill.adjustmentsCents).toString() },
    });
    return { id: d.id };
  });
}

/** Links a bill that was awaiting assignment, moves it, or (with a null visit) returns it to the awaiting queue. */
export async function assignBillVisit(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(schemas.assignVisit, input);
  return withTransaction(pool, async (tx) => {
    const [bill] = await repo.lockBills(tx, actor.householdId, [d.id]);
    if (!bill) throw new AppError('not_found');
    if (bill.version !== d.version) throw new AppError('stale_version');
    if (d.visitId) {
      const visit = await repo.getVisit(tx, actor.householdId, d.visitId, 'share');
      if (!visit) throw new AppError('not_found');
      if (visit.memberId !== bill.memberId) throw new AppError('invalid_input', 'The visit belongs to a different family member');
    }
    await repo.setBillVisit(tx, actor.householdId, d.id, d.version, d.visitId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'bill.visit_assigned', entityType: 'bill', entityId: d.id, requestId,
      detail: { fromVisitId: bill.visitId, toVisitId: d.visitId },
    });
    return { id: d.id };
  });
}

// ---------- adjustments ----------

function assertResponsibility(next: bigint): void {
  if (next < 0n) throw new AppError('conflict', 'That adjustment would make household responsibility negative');
  if (next > MAX_CENTS) throw new AppError('invalid_input', 'Amount out of range');
}

/**
 * Posts a signed adjustment. The bill row lock serializes concurrent writers, so the resulting responsibility is checked
 * against the true current total and can never go below zero. One idempotency key produces one posted adjustment.
 */
export async function addAdjustment(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, ...d } = parse(schemas.createAdjustment, input);
  const id = randomUUID();
  return withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'bill.adjust', d.idempotencyKey, { ...d, idempotencyKey: undefined }, id);
    if (replayId) return { id: replayId, replayed: true };
    const [bill] = await repo.lockBills(tx, actor.householdId, [d.billId]);
    if (!bill) throw new AppError('not_found');
    assertResponsibility(bill.baseResponsibilityCents + bill.adjustmentsCents + d.amount);
    await repo.insertAdjustment(tx, {
      id, householdId: actor.householdId, billId: d.billId, userId: actor.userId, amountCents: d.amount, category: d.category,
      effectiveDate: d.effectiveDate, reason: d.reason, source: d.source, sourceNote: d.sourceNote, reverses: null,
    });
    await repo.touchBill(tx, actor.householdId, d.billId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'bill.adjustment_added', entityType: 'bill_adjustment', entityId: id, requestId,
      detail: { billId: d.billId, amountCents: d.amount.toString(), category: d.category, source: d.source },
    });
    return { id, replayed: false };
  });
}

/** Corrects a posted adjustment with a linked, opposite entry. The original stays in the history. */
export async function reverseAdjustment(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, ...d } = parse(schemas.reverseAdjustment, input);
  const id = randomUUID();
  return withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'bill.reverse', d.idempotencyKey, { ...d, idempotencyKey: undefined }, id);
    if (replayId) return { id: replayId, replayed: true };
    const [bill] = await repo.lockBills(tx, actor.householdId, [d.billId]);
    if (!bill) throw new AppError('not_found');
    const original = await repo.getAdjustment(tx, actor.householdId, d.billId, d.adjustmentId);
    if (!original) throw new AppError('not_found');
    if (original.category === 'reversal') throw new AppError('invalid_input', 'A reversal cannot be reversed; post a new adjustment');
    if (original.reversedBy) throw new AppError('conflict', 'That adjustment was already reversed');
    assertResponsibility(bill.baseResponsibilityCents + bill.adjustmentsCents - original.amountCents);
    try {
      await repo.insertAdjustment(tx, {
        id, householdId: actor.householdId, billId: d.billId, userId: actor.userId, amountCents: -original.amountCents, category: 'reversal',
        effectiveDate: new Date().toISOString().slice(0, 10), reason: d.reason, source: 'manual', sourceNote: '', reverses: original.id,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('conflict', 'That adjustment was already reversed');
      throw error;
    }
    await repo.touchBill(tx, actor.householdId, d.billId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'bill.adjustment_reversed', entityType: 'bill_adjustment', entityId: id, requestId,
      detail: { billId: d.billId, reverses: original.id, amountCents: (-original.amountCents).toString() },
    });
    return { id, replayed: false };
  });
}

// ---------- overview ----------

/** Access-scoped overview: totals and action queues for the same filters, so every figure links to filtered records. */
export async function expenseOverview(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  const f = parse(filterSchemas.bill, { ...(raw as object), cursor: undefined, limit: 5 });
  const { cursor: _c, limit: _l, ...filters } = f;
  const [totals, awaiting, estimates, duplicates] = await Promise.all([
    repo.billTotals(pool, actor.householdId, filters),
    repo.listBills(pool, actor.householdId, { ...f, awaitingVisit: true }),
    repo.listBills(pool, actor.householdId, { ...f, status: 'estimate' }),
    repo.listBills(pool, actor.householdId, { ...f, duplicates: true }),
  ]);
  return { filters, totals, awaitingVisit: awaiting.items, estimates: estimates.items, possibleDuplicates: duplicates.items };
}
