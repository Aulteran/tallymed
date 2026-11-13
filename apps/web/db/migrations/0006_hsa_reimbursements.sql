-- HSA reimbursements: eligibility decisions with evidence, claim reservations, receipts and linked reversals.
-- Money is USD in bigint cents. Synthetic data only in tests. See docs/ledger.md (HSA reconciliation) and docs/contracts.md.
--
--   hsa_eligibility_decisions  immutable user decisions per payment allocation (eligible portion, ineligible, pending) with
--                              rationale and evidence. The latest decision is current. No decision means unknown.
--   hsa_claims                 immutable header of one submission to the HSA administrator.
--   hsa_receipts               immutable header of one actual reimbursement received (from a claim, or external).
--   hsa_entries                immutable ledger on an allocation: reserve (a claim line), receipt, external_receipt,
--                              receipt_reversal, reject and cancel (releases). Every correction is a new linked entry.
--
-- Figures per allocation (all derived from posted rows, never cached):
--   ceiling   = least(current decision's eligible cents, the allocation's net cash)   (zero when ineligible/pending/unknown)
--   pending   = reserves - receipts - rejects - cancels        received = receipts + external receipts - receipt reversals
--   available = max(0, ceiling - pending - received)           needs review = max(0, pending + received - ceiling)
-- A later refund, reversal or lower decision can push pending + received above the ceiling. Real cash stays on record and the
-- allocation is frozen for new claims until the excess is resolved. HSA rows never touch payment_entries, so a receipt does not
-- change any bill or provider balance.
-- Services lock payments first (global order: payments, bills, plans) and the deferred guards below take the same payment row
-- lock before they re-check, so direct SQL and future writers cannot break the invariants either.

create table hsa_eligibility_decisions (
  seq bigint generated always as identity unique,
  id uuid primary key,
  household_id uuid not null references households (id),
  payment_id uuid not null,
  allocation_id uuid not null,
  bill_id uuid not null,
  status text not null check (status in ('eligible', 'ineligible', 'pending')),
  eligible_cents bigint not null check (eligible_cents >= 0 and eligible_cents <= 10000000000000),
  rationale text not null check (char_length(rationale) between 1 and 500),
  evidence_type text check (evidence_type in ('receipt', 'eob', 'statement', 'provider_letter', 'plan_document', 'other')),
  evidence_note text check (evidence_note is null or char_length(evidence_note) between 1 and 300),
  context_note text not null default '' check (char_length(context_note) <= 300),
  decided_on date not null check (decided_on between date '1900-01-01' and date '2100-01-01'),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id, allocation_id, bill_id) references payment_entries (household_id, payment_id, id, bill_id),
  -- An eligible decision names an eligible amount; the others contribute zero. A date, category or suggestion alone never
  -- certifies eligibility: a decision that certifies or rules out cash needs evidence.
  check ((status = 'eligible') = (eligible_cents > 0)),
  check (status = 'pending' or (evidence_type is not null and evidence_note is not null))
);
create index hsa_decisions_allocation_idx on hsa_eligibility_decisions (allocation_id, seq desc);
create index hsa_decisions_household_idx on hsa_eligibility_decisions (household_id, allocation_id);

create table hsa_claims (
  id uuid primary key,
  household_id uuid not null references households (id),
  submitted_on date not null check (submitted_on between date '1900-01-01' and date '2100-01-01'),
  administrator text not null check (char_length(administrator) between 1 and 80),
  reference text check (reference is null or char_length(reference) between 1 and 80),
  note text not null default '' check (char_length(note) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (household_id, id)
);
-- The same administrator claim reference is never recorded twice (a duplicate submission).
create unique index hsa_claims_reference_unique on hsa_claims (household_id, lower(reference)) where reference is not null;

create table hsa_receipts (
  id uuid primary key,
  household_id uuid not null references households (id),
  received_on date not null check (received_on between date '1900-01-01' and date '2100-01-01'),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 10000000000000),
  origin text not null check (origin in ('claim', 'external')),
  source text not null check (source in ('administrator_transfer', 'hsa_debit_card', 'portal_reimbursement', 'other')),
  reference text check (reference is null or char_length(reference) between 1 and 80),
  evidence_type text check (evidence_type in ('receipt', 'eob', 'statement', 'provider_letter', 'plan_document', 'other')),
  evidence_note text check (evidence_note is null or char_length(evidence_note) between 1 and 300),
  note text not null default '' check (char_length(note) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (household_id, id),
  -- A reimbursement that did not come from a claim in this ledger needs an explicit source and evidence.
  check (origin = 'claim' or (evidence_type is not null and evidence_note is not null))
);

create table hsa_entries (
  seq bigint generated always as identity unique,
  id uuid primary key,
  household_id uuid not null references households (id),
  payment_id uuid not null,
  allocation_id uuid not null,
  bill_id uuid not null,
  -- One user action (a claim with several lines, a receipt split over several lines) shares an event id.
  event_id uuid not null,
  kind text not null check (kind in ('reserve', 'receipt', 'external_receipt', 'receipt_reversal', 'reject', 'cancel')),
  claim_id uuid,
  -- The reserve entry (claim line) an entry belongs to; equal to id for the reserve itself. Null for external receipts.
  line_id uuid,
  receipt_id uuid,
  reverses_entry_id uuid,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 10000000000000),
  effective_date date not null check (effective_date between date '1900-01-01' and date '2100-01-01'),
  reason text not null default '' check (char_length(reason) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id, allocation_id, bill_id) references payment_entries (household_id, payment_id, id, bill_id),
  foreign key (household_id, claim_id) references hsa_claims (household_id, id),
  foreign key (household_id, receipt_id) references hsa_receipts (household_id, id),
  unique (household_id, id),
  unique (household_id, allocation_id, id),
  foreign key (household_id, allocation_id, line_id) references hsa_entries (household_id, allocation_id, id),
  foreign key (household_id, reverses_entry_id) references hsa_entries (household_id, id),
  check (case kind
    when 'reserve' then claim_id is not null and line_id = id and receipt_id is null and reverses_entry_id is null
    when 'receipt' then claim_id is not null and line_id is not null and line_id <> id and receipt_id is not null and reverses_entry_id is null
    when 'external_receipt' then claim_id is null and line_id is null and receipt_id is not null and reverses_entry_id is null
    when 'receipt_reversal' then receipt_id is not null and reverses_entry_id is not null
    when 'reject' then claim_id is not null and line_id is not null and line_id <> id and receipt_id is null and reverses_entry_id is null
    when 'cancel' then claim_id is not null and line_id is not null and line_id <> id and receipt_id is null and reverses_entry_id is null
  end)
);
create index hsa_entries_allocation_idx on hsa_entries (household_id, allocation_id, seq);
create index hsa_entries_line_idx on hsa_entries (line_id) where line_id is not null;
create index hsa_entries_receipt_idx on hsa_entries (receipt_id) where receipt_id is not null;
create index hsa_entries_claim_idx on hsa_entries (household_id, claim_id) where claim_id is not null;
-- A receipt entry is reversed at most once, even under concurrent requests.
create unique index hsa_entries_one_reversal on hsa_entries (reverses_entry_id) where reverses_entry_id is not null;

create trigger hsa_decisions_no_change before update or delete on hsa_eligibility_decisions for each row execute function ledger_immutable();
create trigger hsa_decisions_no_truncate before truncate on hsa_eligibility_decisions for each statement execute function ledger_immutable();
create trigger hsa_claims_no_change before update or delete on hsa_claims for each row execute function ledger_immutable();
create trigger hsa_claims_no_truncate before truncate on hsa_claims for each statement execute function ledger_immutable();
create trigger hsa_receipts_no_change before update or delete on hsa_receipts for each row execute function ledger_immutable();
create trigger hsa_receipts_no_truncate before truncate on hsa_receipts for each statement execute function ledger_immutable();
create trigger hsa_entries_no_change before update or delete on hsa_entries for each row execute function ledger_immutable();
create trigger hsa_entries_no_truncate before truncate on hsa_entries for each statement execute function ledger_immutable();

-- Reference rules the composite foreign keys cannot express.
create function hsa_decisions_validate() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from payment_entries where household_id = new.household_id and id = new.allocation_id and kind = 'allocation') then
    raise exception 'an eligibility decision must target a payment allocation' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger hsa_decisions_validate before insert on hsa_eligibility_decisions for each row execute function hsa_decisions_validate();

create function hsa_entries_validate() returns trigger language plpgsql as $$
declare
  t record;
  r record;
begin
  if not exists (select 1 from payment_entries where household_id = new.household_id and id = new.allocation_id and kind = 'allocation') then
    raise exception 'an HSA entry must target a payment allocation' using errcode = 'check_violation';
  end if;
  if new.kind in ('receipt', 'reject', 'cancel') then
    select kind, claim_id, allocation_id into t from hsa_entries where household_id = new.household_id and id = new.line_id;
    if t is null or t.kind <> 'reserve' or t.claim_id <> new.claim_id or t.allocation_id <> new.allocation_id then
      raise exception 'the claim line must be a reservation of the same claim and allocation' using errcode = 'check_violation';
    end if;
  end if;
  if new.kind in ('receipt', 'external_receipt') then
    select origin into r from hsa_receipts where household_id = new.household_id and id = new.receipt_id;
    if r is null or r.origin <> (case new.kind when 'receipt' then 'claim' else 'external' end) then
      raise exception 'the receipt does not match the kind of entry (claim receipts take claim lines, external receipts take allocations)' using errcode = 'check_violation';
    end if;
  elsif new.kind = 'receipt_reversal' then
    select kind, allocation_id, amount_cents, receipt_id, claim_id, line_id into t from hsa_entries
      where household_id = new.household_id and id = new.reverses_entry_id;
    if t is null or t.kind not in ('receipt', 'external_receipt') or t.allocation_id <> new.allocation_id or t.amount_cents <> new.amount_cents
       or t.receipt_id <> new.receipt_id or t.claim_id is distinct from new.claim_id or t.line_id is distinct from new.line_id then
      raise exception 'a receipt reversal must exactly offset one receipt entry' using errcode = 'check_violation';
    end if;
  elsif new.reverses_entry_id is not null then
    raise exception 'only a receipt reversal can reverse an entry' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger hsa_entries_validate before insert on hsa_entries for each row execute function hsa_entries_validate();

-- Commit-time guards ---------------------------------------------------------------------------------------------------
-- Each takes the payment row lock in its own statement first (the same lock refunds, reversals and the services take), so after
-- waiting for another writer the following statements see that writer's committed rows. A refund that commits later is allowed
-- and shows up as "needs review"; these guards only stop writes that would make things worse.

create function hsa_entry_guard() returns trigger language plpgsql as $$
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
  select coalesce(sum(amount_cents), 0) into net from payment_entries where allocation_id = alloc;
  select eligible_cents into elig from hsa_eligibility_decisions where allocation_id = alloc order by seq desc limit 1;
  ceil := least(coalesce(elig, 0), net);
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
create constraint trigger hsa_entries_guard after insert on hsa_entries
  deferrable initially deferred for each row execute function hsa_entry_guard();

-- A receipt header never stands alone: at commit its entries add up to its amount, so a raw INSERT of a header with no entries
-- (or with the wrong total) is refused. The entry guard above re-checks the same sum when entries are added later.
create function hsa_receipt_guard() returns trigger language plpgsql as $$
declare
  allocated bigint;
begin
  select coalesce(sum(amount_cents), 0) into allocated from hsa_entries where receipt_id = new.id and kind in ('receipt', 'external_receipt');
  if allocated <> new.amount_cents then
    raise exception 'a receipt must be allocated in full (receipt %, amount %, allocated %)', new.id, new.amount_cents, allocated using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger hsa_receipts_guard after insert on hsa_receipts
  deferrable initially deferred for each row execute function hsa_receipt_guard();

-- A decision cannot certify more than the allocation's net cash at commit. Reductions below pending and received are allowed
-- (they are real, historical decisions) and show as needs review.
create function hsa_decision_guard() returns trigger language plpgsql as $$
declare
  net bigint;
begin
  perform 1 from payments where id = new.payment_id for no key update;
  select coalesce(sum(amount_cents), 0) into net from payment_entries where allocation_id = new.allocation_id;
  if new.eligible_cents > net then
    raise exception 'an eligible amount cannot exceed the allocation''s net cash (allocation %, net %, eligible %)', new.allocation_id, net, new.eligible_cents
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger hsa_decisions_guard after insert on hsa_eligibility_decisions
  deferrable initially deferred for each row execute function hsa_decision_guard();

-- Read model: one row per payment allocation with the current decision and every reconciliation figure. Voided and fully
-- refunded allocations show a zero ceiling. Available and needs-review follow the formulas in docs/ledger.md.
create view hsa_allocation_status as
select s.*,
       greatest(0, s.ceiling_cents - s.pending_cents - s.received_cents) as available_cents,
       greatest(0, s.pending_cents + s.received_cents - s.ceiling_cents) as needs_review_cents
  from (
    select n.household_id, n.allocation_id, n.payment_id, n.bill_id, n.paid_on, n.net_cents::bigint as net_cents,
           d.id as decision_id, d.status as decision_status, coalesce(d.eligible_cents, 0) as decided_cents,
           (select count(*) from hsa_eligibility_decisions x where x.allocation_id = n.allocation_id)::int as decision_count,
           least(coalesce(d.eligible_cents, 0), n.net_cents::bigint) as ceiling_cents,
           h.pending_cents::bigint as pending_cents, h.received_cents::bigint as received_cents
      from allocation_net n
      left join lateral (select x.id, x.status, x.eligible_cents from hsa_eligibility_decisions x
                          where x.allocation_id = n.allocation_id order by x.seq desc limit 1) d on true
      cross join lateral (select
          coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0) as pending_cents,
          coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0) as received_cents
        from hsa_entries e where e.allocation_id = n.allocation_id) h
  ) s;
