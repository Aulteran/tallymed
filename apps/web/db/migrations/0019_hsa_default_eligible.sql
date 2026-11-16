-- Default-eligible HSA reimbursements and the payment-level "ineligible for HSA" marker. Synthetic data only in tests.
--
-- Every payment allocation is now eligible for its full net cash unless it is marked ineligible, so no eligibility decision is needed to
-- claim or record a reimbursement. The ceiling rule, used identically by the hsa_allocation_status view, the commit-time guard
-- hsa_entry_guard and the backup ledger summary (which reads the view):
--   ceiling = 0                                   when the payment has an ineligible marker or is paid directly from an HSA
--           = 0                                   when the newest decision is 'ineligible'
--           = least(decision eligible_cents, net) when the newest decision is 'eligible'
--           = net                                 when the newest decision is 'pending' (a behavior change: pending used to be zero) or none
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

-- The commit-time guard with the new ceiling (0006's body; only the ceiling lines changed).
create or replace function hsa_entry_guard() returns trigger language plpgsql as $$
declare
  alloc uuid := new.allocation_id;
  net bigint;
  elig bigint;
  dstatus text;
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
  select coalesce(sum(amount_cents), 0) into net from payment_entries where allocation_id = alloc;
  -- The ceiling rule (0019): nothing on a payment marked ineligible or paid directly from an HSA; otherwise the newest decision decides
  -- (eligible: its amount up to the net cash, ineligible: nothing, pending: the net cash); with no decision the whole net cash is eligible.
  select status, eligible_cents into dstatus, elig from hsa_eligibility_decisions where allocation_id = alloc order by seq desc limit 1;
  if hsa_payment_has_no_ceiling(new.payment_id) or dstatus = 'ineligible' then
    ceil := 0;
  elsif dstatus = 'eligible' then
    ceil := least(elig, net);
  else
    ceil := net;
  end if;
  select coalesce(sum(amount_cents) filter (where kind = 'reserve'), 0) - coalesce(sum(amount_cents) filter (where kind in ('receipt', 'reject', 'cancel')), 0),
         coalesce(sum(amount_cents) filter (where kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(amount_cents) filter (where kind = 'receipt_reversal'), 0)
    into pend, recv from hsa_entries where allocation_id = alloc;
  if pend < 0 or recv < 0 then
    raise exception 'pending or received reimbursement would go below zero (allocation %, pending %, received %)', alloc, pend, recv using errcode = 'check_violation';
  end if;
  -- Each claim line keeps its own reservation between zero and what was reserved.
  select l.line_id into bad from (
    select e.line_id, sum(case e.kind when 'reserve' then e.amount_cents when 'receipt' then -e.amount_cents when 'reject' then -e.amount_cents
                                       when 'cancel' then -e.amount_cents else 0 end) as open_cents
      from hsa_entries e where e.allocation_id = alloc and e.line_id is not null group by e.line_id) l
    where l.open_cents < 0 limit 1;
  if bad is not null then
    raise exception 'a claim line cannot be paid or released beyond its reservation (line %)', bad using errcode = 'check_violation';
  end if;
  -- New reservations and external receipts must fit under the ceiling together with everything already pending and received.
  -- When an excess already exists the same test refuses them, which freezes new claims until the excess is resolved.
  if new.kind in ('reserve', 'external_receipt') and pend + recv > ceil then
    raise exception 'pending plus received reimbursement would exceed the eligible ceiling (allocation %, ceiling %, pending %, received %)', alloc, ceil, pend, recv
      using errcode = 'check_violation';
  end if;
  -- A receipt is fully allocated: its entries add up to its amount, and a reversal covers every entry of the receipt.
  if new.receipt_id is not null then
    select amount_cents into r_amount from hsa_receipts where id = new.receipt_id;
    select coalesce(sum(amount_cents), 0), count(*) into r_total, r_entries from hsa_entries where receipt_id = new.receipt_id and kind in ('receipt', 'external_receipt');
    select count(*) into r_reversals from hsa_entries where receipt_id = new.receipt_id and kind = 'receipt_reversal';
    if r_total <> r_amount then
      raise exception 'a receipt must be allocated in full (receipt %, amount %, allocated %)', new.receipt_id, r_amount, r_total using errcode = 'check_violation';
    end if;
    if r_reversals not in (0, r_entries) then
      raise exception 'a receipt reversal must cover every entry of the receipt (receipt %)', new.receipt_id using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;

-- The view with the new ceiling. Same columns in the same order as 0017; the marker flag is added last.
create or replace view hsa_allocation_status as
select s.*,
       case when payment_is_direct_hsa(s.payment_id) then 0
            else greatest(0, s.ceiling_cents - s.pending_cents - s.received_cents) end as available_cents,
       greatest(0, s.pending_cents + s.received_cents - s.ceiling_cents) as needs_review_cents,
       payment_is_direct_hsa(s.payment_id) as direct_hsa,
       exists (select 1 from payment_hsa_ineligible i where i.payment_id = s.payment_id) as marked_ineligible
  from (
    select n.household_id, n.allocation_id, n.payment_id, n.bill_id, n.paid_on, n.net_cents::bigint as net_cents,
           d.id as decision_id, d.status as decision_status, coalesce(d.eligible_cents, 0) as decided_cents,
           (select count(*) from hsa_eligibility_decisions x where x.allocation_id = n.allocation_id)::int as decision_count,
           case when hsa_payment_has_no_ceiling(n.payment_id) or d.status = 'ineligible' then 0
                when d.status = 'eligible' then least(d.eligible_cents, n.net_cents::bigint)
                else n.net_cents::bigint end as ceiling_cents,
           h.pending_cents::bigint as pending_cents, h.received_cents::bigint as received_cents
      from allocation_net n
      left join lateral (select x.id, x.status, x.eligible_cents from hsa_eligibility_decisions x
                          where x.allocation_id = n.allocation_id order by x.seq desc limit 1) d on true
      cross join lateral (select
          coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0) as pending_cents,
          coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0) as received_cents
        from hsa_entries e where e.allocation_id = n.allocation_id) h
  ) s;
