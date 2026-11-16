-- Administrator removal (with undo) of HSA eligibility decisions, claims and reimbursement receipts. Synthetic data only in tests.
--
-- Nothing is ever deleted. A removal is an append-only marker, and a removed record is not LIVE: it stops counting in every figure, list and
-- export, and a restore (undo) is the exact inverse because the original rows were never touched. Compensating entries could not do this: a
-- receipt reversal lowers "received" but does not return the claim line to pending, and a receipt can be reversed once.
--
--   hsa_removal_events     append-only; the newest event (highest seq) of a (kind, record) says whether it is removed. Events alternate.
--   hsa_record_removed()   the one test of "removed".
--   hsa_live_decisions     the decisions that are not removed. Same columns as hsa_eligibility_decisions.
--   hsa_live_entries       the entries whose claim is not removed AND whose receipt is not removed. Same columns as hsa_entries.
-- These two views are the ONE definition of live: every reader of decisions and entries (guards, hsa_allocation_status, the backup ledger rules
-- and the application's queries) reads them. Writes keep targeting the base tables.
--
-- Guards (checked at commit, after the affected payment rows are locked first in ascending id, then recomputed with the live views):
--   remove or restore   pending >= 0, received >= 0, every claim line's open amount >= 0, a receipt stays fully allocated.
--   restore             pending + received <= the ceiling of the live current decision (the allocation net): never creates or leaves an excess.
--   remove              the excess (needs review) must not become larger than it was with the record still live, so stale records can be
--                       cleaned up on an allocation that already needs review.
--   remove              leaf-first: a claim with a live receipt entry cannot be removed; a decision removal that lowers the ceiling is
--                       refused only when it would create or enlarge an excess.
--   restore             also: the payment is not removed, not voided and not paid directly from an HSA; a receipt cannot be restored while its
--                       claim is removed; a claim cannot be restored when a live claim has taken its reference.
-- Claim references: the unique index is replaced by a check against LIVE claims only (before insert on hsa_claims and on a claim restore, under an
-- advisory lock), so a deleted claim's reference can be entered again. A backup restore loads rows with these triggers off, like the other
-- guards; the ledger rules in backup/ledger.ts check the same facts over the whole database.
-- Lock order stays: payments (ascending id), bills, plans, payment method, then HSA account last.

-- Events ---------------------------------------------------------------------------------------------------------------

create table hsa_removal_events (
  seq bigint generated always as identity unique,
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  kind text not null check (kind in ('decision', 'claim', 'receipt')),
  record_id uuid not null,
  action text not null check (action in ('remove', 'restore')),
  reason text not null default '' check (char_length(reason) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now()
);
create index hsa_removal_events_record_idx on hsa_removal_events (household_id, kind, record_id, seq desc);
-- hsa_record_removed() knows the record id only (ids are globally unique uuids), so it reads through this index.
create index hsa_removal_events_lookup_idx on hsa_removal_events (kind, record_id, seq desc);
create trigger hsa_removal_events_no_change before update or delete on hsa_removal_events for each row execute function ledger_immutable();
create trigger hsa_removal_events_no_truncate before truncate on hsa_removal_events for each statement execute function ledger_immutable();

-- A record is removed while its newest event says so.
create function hsa_record_removed(k text, rid uuid) returns boolean language sql stable as $$
  select coalesce((select e.action from hsa_removal_events e where e.kind = k and e.record_id = rid order by e.seq desc limit 1), 'restore') = 'remove'
$$;

-- The one definition of live ---------------------------------------------------------------------------------------------

create view hsa_live_decisions as
select d.* from hsa_eligibility_decisions d where not hsa_record_removed('decision', d.id);

create view hsa_live_entries as
select e.* from hsa_entries e
 where (e.claim_id is null or not hsa_record_removed('claim', e.claim_id))
   and (e.receipt_id is null or not hsa_record_removed('receipt', e.receipt_id));

-- Which payments a removal event touches, ascending, and their row locks (the carried lock order). The set is read again after the locks are
-- taken, so a row another writer committed while this one waited is locked too.
create function hsa_removal_payments(k text, rid uuid) returns uuid[] language sql stable as $$
  select coalesce(array_agg(distinct x.payment_id order by x.payment_id), '{}'::uuid[]) from (
    select d.payment_id from hsa_eligibility_decisions d where k = 'decision' and d.id = rid
    union all select e.payment_id from hsa_entries e where k = 'claim' and e.claim_id = rid
    union all select e.payment_id from hsa_entries e where k = 'receipt' and e.receipt_id = rid) x
$$;

create function hsa_removal_lock(k text, rid uuid) returns uuid[] language plpgsql as $$
declare pids uuid[];
begin
  pids := hsa_removal_payments(k, rid);
  perform 1 from payments where id = any(pids) order by id for no key update;
  pids := hsa_removal_payments(k, rid);
  perform 1 from payments where id = any(pids) order by id for no key update;
  return pids;
end $$;

-- Claim references -------------------------------------------------------------------------------------------------------

-- No two LIVE claims of a household share a reference (case-insensitive). The advisory lock serializes concurrent writers of one reference, and
-- it is held to the end of the transaction, so the second writer sees the first one's committed claim. The unique_violation keeps the constraint
-- name of the dropped index, so the existing service mapping still answers "already recorded".
create function hsa_claim_reference_check(hid uuid, ref text, self uuid) returns void language plpgsql as $$
begin
  if ref is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext(hid::text || lower(ref)));
  if exists (select 1 from hsa_claims c where c.household_id = hid and lower(c.reference) = lower(ref) and c.id <> self
              and not hsa_record_removed('claim', c.id)) then
    raise exception 'a claim with that reference is already recorded' using errcode = 'unique_violation', constraint = 'hsa_claims_reference_unique';
  end if;
end $$;

drop index hsa_claims_reference_unique;

create function hsa_claims_reference_guard() returns trigger language plpgsql as $$
begin
  perform hsa_claim_reference_check(new.household_id, new.reference, new.id);
  return new;
end $$;
create trigger hsa_claims_reference_guard before insert on hsa_claims for each row execute function hsa_claims_reference_guard();

-- Event checks -----------------------------------------------------------------------------------------------------------

-- The events alternate and name a record of their household. The affected payment rows are locked first (in ascending id), so two concurrent
-- events on one record, or an event racing a new entry, are checked one after the other.
create function hsa_removal_event_check() returns trigger language plpgsql as $$
declare
  owner uuid;
  removed boolean;
  ref text;
begin
  perform hsa_removal_lock(new.kind, new.record_id);
  if new.kind = 'decision' then
    select household_id into owner from hsa_eligibility_decisions where id = new.record_id;
  elsif new.kind = 'claim' then
    select household_id, reference into owner, ref from hsa_claims where id = new.record_id;
  else
    select household_id into owner from hsa_receipts where id = new.record_id;
  end if;
  if owner is distinct from new.household_id then
    raise exception 'unknown HSA record (% %)', new.kind, new.record_id using errcode = 'check_violation';
  end if;
  removed := hsa_record_removed(new.kind, new.record_id);
  if new.action = 'remove' and removed then
    raise exception 'the HSA record is already removed (% %)', new.kind, new.record_id using errcode = 'check_violation';
  end if;
  if new.action = 'restore' and not removed then
    raise exception 'the HSA record is not removed (% %)', new.kind, new.record_id using errcode = 'check_violation';
  end if;
  if new.kind = 'claim' and new.action = 'restore' then
    perform hsa_claim_reference_check(new.household_id, ref, new.record_id);
  end if;
  return new;
end $$;
create trigger hsa_removal_event_check before insert on hsa_removal_events for each row execute function hsa_removal_event_check();

-- The excess (what "needs review" shows) of one allocation, computed as if the record (k, rid) were still live. Everything else counts as in the
-- live views. A removal is judged by comparing this figure with the present one: it must never make needs-review worse.
create function hsa_allocation_excess_with(alloc uuid, k text, rid uuid) returns bigint language plpgsql stable as $$
declare
  net bigint;
  elig bigint;
  pend bigint;
  recv bigint;
begin
  select coalesce(sum(amount_cents), 0) into net from payment_entries where allocation_id = alloc;
  select d.eligible_cents into elig from hsa_eligibility_decisions d
   where d.allocation_id = alloc and (not hsa_record_removed('decision', d.id) or (k = 'decision' and d.id = rid)) order by d.seq desc limit 1;
  select coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0),
         coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0)
    into pend, recv from hsa_entries e
   where e.allocation_id = alloc
     and (e.claim_id is null or not hsa_record_removed('claim', e.claim_id) or (k = 'claim' and e.claim_id = rid))
     and (e.receipt_id is null or not hsa_record_removed('receipt', e.receipt_id) or (k = 'receipt' and e.receipt_id = rid));
  return greatest(0, pend + recv - least(coalesce(elig, 0), net));
end $$;

-- The money rules of one allocation, recomputed with the live views. Used at commit for removals and restores. A restore (strict) must leave
-- pending + received within the ceiling. A removal (not strict) may happen on an allocation that already needs review, as long as it does not
-- make the excess larger than it was with the record still live.
create function hsa_allocation_live_check(alloc uuid, strict boolean, k text, rid uuid) returns void language plpgsql as $$
declare
  before_excess bigint;
  net bigint;
  elig bigint;
  ceil bigint;
  pend bigint;
  recv bigint;
  bad uuid;
begin
  select coalesce(sum(amount_cents), 0) into net from payment_entries where allocation_id = alloc;
  select eligible_cents into elig from hsa_live_decisions where allocation_id = alloc order by seq desc limit 1;
  ceil := least(coalesce(elig, 0), net);
  select coalesce(sum(amount_cents) filter (where kind = 'reserve'), 0) - coalesce(sum(amount_cents) filter (where kind in ('receipt', 'reject', 'cancel')), 0),
         coalesce(sum(amount_cents) filter (where kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(amount_cents) filter (where kind = 'receipt_reversal'), 0)
    into pend, recv from hsa_live_entries where allocation_id = alloc;
  if pend < 0 or recv < 0 then
    raise exception 'pending or received reimbursement would go below zero (allocation %, pending %, received %)', alloc, pend, recv using errcode = 'check_violation';
  end if;
  select l.line_id into bad from (
    select e.line_id, sum(case e.kind when 'reserve' then e.amount_cents when 'receipt' then -e.amount_cents when 'reject' then -e.amount_cents
                                       when 'cancel' then -e.amount_cents else 0 end) as open_cents
      from hsa_live_entries e where e.allocation_id = alloc and e.line_id is not null group by e.line_id) l
    where l.open_cents < 0 limit 1;
  if bad is not null then
    raise exception 'a claim line cannot be paid or released beyond its reservation (line %)', bad using errcode = 'check_violation';
  end if;
  if strict then
    if pend + recv > ceil then
      raise exception 'pending plus received reimbursement would exceed the eligible ceiling (allocation %, ceiling %, pending %, received %)', alloc, ceil, pend, recv
        using errcode = 'check_violation';
    end if;
  else
    before_excess := hsa_allocation_excess_with(alloc, k, rid);
    if greatest(0, pend + recv - ceil) > before_excess then
      raise exception 'removing this record would increase the excess above the eligible ceiling (allocation %, ceiling %, pending %, received %)', alloc, ceil, pend, recv
        using errcode = 'check_violation';
    end if;
  end if;
end $$;

-- Commit-time guard for a removal or restore. It judges the record's present state (so a remove and a restore in one transaction judge as a
-- restore), after taking the payment locks first.
create function hsa_removal_event_guard() returns trigger language plpgsql as $$
declare
  pids uuid[];
  pid uuid;
  alloc uuid;
  rec uuid;
  r_amount bigint;
  r_total bigint;
  r_entries integer;
  r_reversals integer;
  removed_now boolean;
begin
  pids := hsa_removal_lock(new.kind, new.record_id);
  removed_now := hsa_record_removed(new.kind, new.record_id);
  if removed_now then
    -- Leaf-first: a claim keeps standing while a live receipt still has entries on it.
    if new.kind = 'claim' and exists (select 1 from hsa_entries e where e.claim_id = new.record_id and e.receipt_id is not null
                                        and not hsa_record_removed('receipt', e.receipt_id)) then
      raise exception 'a claim with a live reimbursement cannot be removed; remove its reimbursements first (claim %)', new.record_id using errcode = 'check_violation';
    end if;
  else
    foreach pid in array pids loop
      if payment_is_removed(pid) then
        raise exception 'the payment is removed, so its HSA records cannot be restored (payment %)', pid using errcode = 'check_violation';
      end if;
      if exists (select 1 from payment_voids v where v.payment_id = pid) then
        raise exception 'the payment is voided, so its HSA records cannot be restored (payment %)', pid using errcode = 'check_violation';
      end if;
      if payment_is_direct_hsa(pid) then
        raise exception 'the payment is paid directly from an HSA, so its HSA records cannot be restored (payment %)', pid using errcode = 'check_violation';
      end if;
    end loop;
    if new.kind = 'receipt' and exists (select 1 from hsa_entries e where e.receipt_id = new.record_id and e.claim_id is not null
                                          and hsa_record_removed('claim', e.claim_id)) then
      raise exception 'a reimbursement cannot be restored while its claim is removed (receipt %)', new.record_id using errcode = 'check_violation';
    end if;
    -- A receipt stays fully allocated: what is live of it adds up to its amount, and a reversal covers every entry.
    for rec in select distinct e.receipt_id from hsa_entries e
                where e.receipt_id is not null and ((new.kind = 'claim' and e.claim_id = new.record_id) or (new.kind = 'receipt' and e.receipt_id = new.record_id))
                order by 1 loop
      if hsa_record_removed('receipt', rec) then
        continue;
      end if;
      select amount_cents into r_amount from hsa_receipts where id = rec;
      select coalesce(sum(amount_cents), 0), count(*) into r_total, r_entries from hsa_live_entries where receipt_id = rec and kind in ('receipt', 'external_receipt');
      select count(*) into r_reversals from hsa_live_entries where receipt_id = rec and kind = 'receipt_reversal';
      if r_total <> r_amount then
        raise exception 'a receipt must be allocated in full (receipt %, amount %, allocated %)', rec, r_amount, r_total using errcode = 'check_violation';
      end if;
      if r_reversals not in (0, r_entries) then
        raise exception 'a receipt reversal must cover every entry of the receipt (receipt %)', rec using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  for alloc in select a from (
      select d.allocation_id as a from hsa_eligibility_decisions d where new.kind = 'decision' and d.id = new.record_id
      union select e.allocation_id from hsa_entries e where new.kind = 'claim' and e.claim_id = new.record_id
      union select e.allocation_id from hsa_entries e where new.kind = 'receipt' and e.receipt_id = new.record_id) x order by a loop
    perform hsa_allocation_live_check(alloc, not removed_now, new.kind, new.record_id);
  end loop;
  return null;
end $$;
create constraint trigger hsa_removal_events_guard after insert on hsa_removal_events
  deferrable initially deferred for each row execute function hsa_removal_event_guard();

-- The existing guards and the read model read the live views -----------------------------------------------------------------

-- 0006's definition with the live views, and one new rule: no new entry on a removed claim or receipt (it would not count, and a later restore
-- would surprise the figures).
create or replace function hsa_entry_guard() returns trigger language plpgsql as $$
declare
  alloc uuid := new.allocation_id;
  net bigint;
  elig bigint;
  ceil bigint;
  pend bigint;
  recv bigint;
  bad uuid;
  r_amount bigint;
  r_total bigint;
  r_entries integer;
  r_reversals integer;
begin
  perform 1 from payments where id = new.payment_id for no key update;
  if (new.claim_id is not null and hsa_record_removed('claim', new.claim_id)) or (new.receipt_id is not null and hsa_record_removed('receipt', new.receipt_id)) then
    raise exception 'a removed claim or reimbursement takes no new entries (entry %)', new.id using errcode = 'check_violation';
  end if;
  select coalesce(sum(amount_cents), 0) into net from payment_entries where allocation_id = alloc;
  select eligible_cents into elig from hsa_live_decisions where allocation_id = alloc order by seq desc limit 1;
  ceil := least(coalesce(elig, 0), net);
  select coalesce(sum(amount_cents) filter (where kind = 'reserve'), 0) - coalesce(sum(amount_cents) filter (where kind in ('receipt', 'reject', 'cancel')), 0),
         coalesce(sum(amount_cents) filter (where kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(amount_cents) filter (where kind = 'receipt_reversal'), 0)
    into pend, recv from hsa_live_entries where allocation_id = alloc;
  if pend < 0 or recv < 0 then
    raise exception 'pending or received reimbursement would go below zero (allocation %, pending %, received %)', alloc, pend, recv using errcode = 'check_violation';
  end if;
  select l.line_id into bad from (
    select e.line_id, sum(case e.kind when 'reserve' then e.amount_cents when 'receipt' then -e.amount_cents when 'reject' then -e.amount_cents
                                       when 'cancel' then -e.amount_cents else 0 end) as open_cents
      from hsa_live_entries e where e.allocation_id = alloc and e.line_id is not null group by e.line_id) l
    where l.open_cents < 0 limit 1;
  if bad is not null then
    raise exception 'a claim line cannot be paid or released beyond its reservation (line %)', bad using errcode = 'check_violation';
  end if;
  if new.kind in ('reserve', 'external_receipt') and pend + recv > ceil then
    raise exception 'pending plus received reimbursement would exceed the eligible ceiling (allocation %, ceiling %, pending %, received %)', alloc, ceil, pend, recv
      using errcode = 'check_violation';
  end if;
  if new.receipt_id is not null then
    select amount_cents into r_amount from hsa_receipts where id = new.receipt_id;
    select coalesce(sum(amount_cents), 0), count(*) into r_total, r_entries from hsa_live_entries where receipt_id = new.receipt_id and kind in ('receipt', 'external_receipt');
    select count(*) into r_reversals from hsa_live_entries where receipt_id = new.receipt_id and kind = 'receipt_reversal';
    if r_total <> r_amount then
      raise exception 'a receipt must be allocated in full (receipt %, amount %, allocated %)', new.receipt_id, r_amount, r_total using errcode = 'check_violation';
    end if;
    if r_reversals not in (0, r_entries) then
      raise exception 'a receipt reversal must cover every entry of the receipt (receipt %)', new.receipt_id using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;

-- hsa_decision_guard (0006) reads no decisions, hsa_receipt_guard (0006) checks a header at its own insert, and hsa_refuse_direct_payment (0017) and
-- hsa_refuse_removed_payment (0018) guard inserts and read no existing HSA state: all unchanged.

-- 0016's definition; only the existence test of HSA entries and decisions now counts live records, so a payment whose HSA records were all removed
-- can be paid directly again (a later restore of those records is then refused by the removal guard above).
create or replace function payment_hsa_funding_check() returns trigger language plpgsql as $$
declare archived timestamptz;
begin
  perform 1 from payments where id = new.payment_id for no key update;
  select archived_at into archived from hsa_accounts where household_id = new.household_id and id = new.hsa_account_id for share;
  if archived is not null then
    raise exception 'that HSA account is archived' using errcode = 'check_violation';
  end if;
  if exists (select 1 from hsa_live_entries e where e.payment_id = new.payment_id)
     or exists (select 1 from hsa_live_decisions d join payment_entries a on a.id = d.allocation_id where a.payment_id = new.payment_id) then
    raise exception 'a payment that already has HSA claims or decisions cannot be paid directly from an HSA' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- 0017's definition with the same change.
create or replace function payment_hsa_funding_event_check() returns trigger language plpgsql as $$
declare
  acct uuid;
  archived timestamptz;
  direct boolean;
begin
  perform 1 from payments where id = new.payment_id for no key update;
  direct := payment_is_direct_hsa(new.payment_id);
  if new.action = 'release' then
    if not direct then
      raise exception 'the payment is not paid directly from an HSA (payment %)', new.payment_id using errcode = 'check_violation';
    end if;
  else
    if direct then
      raise exception 'the payment is still paid directly from an HSA (payment %)', new.payment_id using errcode = 'check_violation';
    end if;
    select f.hsa_account_id into acct from payment_hsa_funding f where f.payment_id = new.payment_id;
    select a.archived_at into archived from hsa_accounts a where a.household_id = new.household_id and a.id = acct for share;
    if archived is not null then
      raise exception 'that HSA account is archived' using errcode = 'check_violation';
    end if;
    if exists (select 1 from hsa_live_entries e where e.payment_id = new.payment_id)
       or exists (select 1 from hsa_live_decisions d join payment_entries a on a.id = d.allocation_id where a.payment_id = new.payment_id) then
      raise exception 'a payment that already has HSA claims or decisions cannot be paid directly from an HSA again' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- 0017's view with the same columns in the same order; only the sources change to the live views.
create or replace view hsa_allocation_status as
select s.*,
       case when payment_is_direct_hsa(s.payment_id) then 0
            else greatest(0, s.ceiling_cents - s.pending_cents - s.received_cents) end as available_cents,
       greatest(0, s.pending_cents + s.received_cents - s.ceiling_cents) as needs_review_cents,
       payment_is_direct_hsa(s.payment_id) as direct_hsa
  from (
    select n.household_id, n.allocation_id, n.payment_id, n.bill_id, n.paid_on, n.net_cents::bigint as net_cents,
           d.id as decision_id, d.status as decision_status, coalesce(d.eligible_cents, 0) as decided_cents,
           (select count(*) from hsa_live_decisions x where x.allocation_id = n.allocation_id)::int as decision_count,
           least(coalesce(d.eligible_cents, 0), n.net_cents::bigint) as ceiling_cents,
           h.pending_cents::bigint as pending_cents, h.received_cents::bigint as received_cents
      from allocation_net n
      left join lateral (select x.id, x.status, x.eligible_cents from hsa_live_decisions x
                          where x.allocation_id = n.allocation_id order by x.seq desc limit 1) d on true
      cross join lateral (select
          coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0) as pending_cents,
          coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0) as received_cents
        from hsa_live_entries e where e.allocation_id = n.allocation_id) h
  ) s;

-- Undo slot kinds -----------------------------------------------------------------------------------------------------------

alter table undo_actions drop constraint undo_actions_kind_check;
alter table undo_actions add constraint undo_actions_kind_check
  check (kind in ('payment_remove', 'plan_remove', 'method_change', 'hsa_decision_remove', 'hsa_claim_remove', 'hsa_receipt_remove'));
