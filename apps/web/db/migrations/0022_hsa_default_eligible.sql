-- Default-eligible HSA reimbursements and the payment-level "ineligible for HSA" marker. Synthetic data only in tests.
--
-- Every payment allocation is now eligible for its full net cash unless it is marked ineligible, so no eligibility decision is needed to
-- claim or record a reimbursement. Built on 0020 (record removal): decisions are read through hsa_live_decisions, so a removed (undone) decision
-- falls back to the default. The ceiling rule, used identically by the hsa_allocation_status view, the commit-time guard hsa_entry_guard, the
-- removal guards (hsa_allocation_excess_with, hsa_allocation_live_check) and the backup ledger summary (which reads the view):
--   ceiling = 0                                   when the payment has an ineligible marker or is paid directly from an HSA
--           = 0                                   when the newest LIVE NON-PENDING decision is 'ineligible'
--           = least(decision eligible_cents, net) when the newest live non-pending decision is 'eligible'
--           = net                                 when there is no live non-pending decision (none at all, or only pending ones)
-- A 'pending' decision is a note: it never changes the ceiling, so it cannot lift an ineligible or partial ruling back to full net cash.
-- Existing decisions are neither changed nor deleted (the table is immutable). Direct HSA payments keep a zero ceiling, as before, so
-- eligible still equals pending + received + available for claimable payments.
--
--   payment_hsa_ineligible   append-only: the payment was recorded as ineligible for HSA. Written only when the payment is created, in the
--                            same transaction (a payment can gain allocations later, so the marker belongs to the payment, not an allocation).
--                            It is not a decision row: it needs no rationale or evidence and does not block removing the payment.
-- A payment cannot be both marked ineligible and paid directly from an HSA; the database refuses either row at commit, in either order,
-- after taking the payment row lock first (the carried lock order), so concurrent writers are race-safe.

create table payment_hsa_ineligible (
  payment_id uuid primary key,
  household_id uuid not null references households (id),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id) references payments (household_id, id)
);
create index payment_hsa_ineligible_household_idx on payment_hsa_ineligible (household_id);
create trigger payment_hsa_ineligible_no_change before update or delete on payment_hsa_ineligible for each row execute function ledger_immutable();
create trigger payment_hsa_ineligible_no_truncate before truncate on payment_hsa_ineligible for each statement execute function ledger_immutable();

-- True when nothing on the payment can be claimed regardless of decisions: it carries the marker or is paid directly from an HSA.
create function hsa_payment_has_no_ceiling(pid uuid) returns boolean language sql stable as $$
  select exists (select 1 from payment_hsa_ineligible i where i.payment_id = pid) or payment_is_direct_hsa(pid)
$$;

-- Marker side: refused on a payment paid directly from an HSA. Deferred, so the order of the two inserts in one transaction is free.
create function payment_hsa_ineligible_check() returns trigger language plpgsql as $$
begin
  perform 1 from payments where id = new.payment_id for no key update;
  if payment_is_direct_hsa(new.payment_id) then
    raise exception 'a payment paid directly from an HSA cannot also be marked ineligible for HSA' using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger payment_hsa_ineligible_refuse_direct after insert on payment_hsa_ineligible
  deferrable initially deferred for each row execute function payment_hsa_ineligible_check();

-- Funding side: a direct funding (or its reinstatement) is refused on a payment that carries the marker.
create function payment_hsa_funding_refuse_ineligible() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'payment_hsa_funding_events' then
    -- A release only ends the direct funding; only a reinstatement can make the payment direct again.
    if to_jsonb(new) ->> 'action' <> 'reinstate' then
      return null;
    end if;
  end if;
  perform 1 from payments where id = new.payment_id for no key update;
  if exists (select 1 from payment_hsa_ineligible i where i.payment_id = new.payment_id) and payment_is_direct_hsa(new.payment_id) then
    raise exception 'a payment marked ineligible for HSA cannot be paid directly from an HSA' using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger payment_hsa_funding_refuse_ineligible after insert on payment_hsa_funding
  deferrable initially deferred for each row execute function payment_hsa_funding_refuse_ineligible();
create constraint trigger payment_hsa_funding_events_refuse_ineligible after insert on payment_hsa_funding_events
  deferrable initially deferred for each row execute function payment_hsa_funding_refuse_ineligible();

-- The ceiling of one allocation under the rule above. Decisions are read live; when (k, rid) names a decision, that decision counts as live
-- too (used by the removal check, which compares the figures with and without the record). A marker is not a decision and is never removable.
create function hsa_allocation_ceiling(alloc uuid, k text, rid uuid) returns bigint language plpgsql stable as $$
declare
  pid uuid;
  net bigint;
  elig bigint;
  dstatus text;
begin
  select payment_id into pid from payment_entries where id = alloc;
  if hsa_payment_has_no_ceiling(pid) then
    return 0;
  end if;
  select coalesce(sum(amount_cents), 0) into net from payment_entries where allocation_id = alloc;
  select d.status, d.eligible_cents into dstatus, elig from hsa_eligibility_decisions d
   where d.allocation_id = alloc and d.status <> 'pending' and (not hsa_record_removed('decision', d.id) or (k = 'decision' and d.id = rid)) order by d.seq desc limit 1;
  if dstatus = 'ineligible' then
    return 0;
  elsif dstatus = 'eligible' then
    return least(elig, net);
  end if;
  return net;
end $$;

-- The excess of one allocation as if the record (k, rid) were still live (0020's body; only the ceiling comes from the rule).
create or replace function hsa_allocation_excess_with(alloc uuid, k text, rid uuid) returns bigint language plpgsql stable as $$
declare
  pend bigint;
  recv bigint;
begin
  select coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0),
         coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0)
    into pend, recv from hsa_entries e
   where e.allocation_id = alloc
     and (e.claim_id is null or not hsa_record_removed('claim', e.claim_id) or (k = 'claim' and e.claim_id = rid))
     and (e.receipt_id is null or not hsa_record_removed('receipt', e.receipt_id) or (k = 'receipt' and e.receipt_id = rid));
  return greatest(0, pend + recv - hsa_allocation_ceiling(alloc, k, rid));
end $$;

-- 0020's recheck of one allocation with the live views; only the ceiling comes from the rule. hsa_removal_event_guard calls it for every
-- allocation a decision, claim or receipt removal or restore touches, so a removed or restored decision is judged against the default.
create or replace function hsa_allocation_live_check(alloc uuid, strict boolean, k text, rid uuid) returns void language plpgsql as $$
declare
  before_excess bigint;
  ceil bigint;
  pend bigint;
  recv bigint;
  bad uuid;
begin
  ceil := hsa_allocation_ceiling(alloc, null, null);
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

-- The commit-time guard (0020's body, live views and the removed-record rule kept; only the ceiling comes from the rule).
create or replace function hsa_entry_guard() returns trigger language plpgsql as $$
declare
  alloc uuid := new.allocation_id;
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
  ceil := hsa_allocation_ceiling(alloc, null, null);
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
  -- New reservations and external receipts must fit under the ceiling together with everything already pending and received.
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

-- 0020's view with the same columns in the same order; the marker flag is added last. Sources stay the live views.
create or replace view hsa_allocation_status as
select s.*,
       case when payment_is_direct_hsa(s.payment_id) then 0
            else greatest(0, s.ceiling_cents - s.pending_cents - s.received_cents) end as available_cents,
       greatest(0, s.pending_cents + s.received_cents - s.ceiling_cents) as needs_review_cents,
       payment_is_direct_hsa(s.payment_id) as direct_hsa,
       exists (select 1 from payment_hsa_ineligible i where i.payment_id = s.payment_id) as marked_ineligible
  from (
    select n.household_id, n.allocation_id, n.payment_id, n.bill_id, n.paid_on, n.net_cents::bigint as net_cents,
           d.id as decision_id, d.status as decision_status, coalesce(c.eligible_cents, 0) as decided_cents,
           (select count(*) from hsa_live_decisions x where x.allocation_id = n.allocation_id)::int as decision_count,
           case when hsa_payment_has_no_ceiling(n.payment_id) or c.status = 'ineligible' then 0
                when c.status = 'eligible' then least(c.eligible_cents, n.net_cents::bigint)
                else n.net_cents::bigint end as ceiling_cents,
           h.pending_cents::bigint as pending_cents, h.received_cents::bigint as received_cents
      from allocation_net n
      left join lateral (select x.id, x.status, x.eligible_cents from hsa_live_decisions x
                          where x.allocation_id = n.allocation_id order by x.seq desc limit 1) d on true
      left join lateral (select x.status, x.eligible_cents from hsa_live_decisions x
                          where x.allocation_id = n.allocation_id and x.status <> 'pending' order by x.seq desc limit 1) c on true
      cross join lateral (select
          coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0) as pending_cents,
          coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0) as received_cents
        from hsa_live_entries e where e.allocation_id = n.allocation_id) h
  ) s;
