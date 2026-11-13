-- Payments, allocations, refunds, reversals and payment plans. Money is USD in bigint cents. Synthetic data only in tests.
--
-- Cash model (see docs/ledger.md and docs/contracts.md):
--   payments            immutable header of one actual household payment (cash out).
--   payment_entries     immutable signed ledger on a payment. Allocations apply cash to a bill, allocation reversals return
--                       it to the payment's unapplied balance, refunds return cash to the household, refund reversals
--                       correct a refund. Every correction is a new linked entry.
--   payment_voids       a payment recorded in error; allowed only when nothing remains applied or refunded.
-- Plan model:
--   payment_plans, payment_plan_bills, plan_revisions, plan_installments (immutable schedule revisions) and
--   installment_matches (signed, immutable links from an installment to an existing allocation; never new cash).
-- The services lock payments, plans and bills in a fixed order. The deferred triggers below re-check every limit at commit
-- (taking the same payment row lock first) so direct SQL, scripts and future writers cannot break them either.

create function ledger_immutable() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; post a linked correction instead', tg_table_name;
end $$;

create table payments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  paid_on date not null check (paid_on between date '1900-01-01' and date '2100-01-01'),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 10000000000000),
  method text not null check (method in ('card', 'bank_transfer', 'check', 'cash', 'portal', 'other')),
  reference text check (reference is null or char_length(reference) between 1 and 80),
  note text not null default '' check (char_length(note) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (household_id, id)
);
create index payments_date_idx on payments (household_id, paid_on desc, id desc);

create table payment_voids (
  payment_id uuid primary key,
  household_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 500),
  voided_on date not null check (voided_on between date '1900-01-01' and date '2100-01-01'),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id) references payments (household_id, id)
);

create table payment_entries (
  seq bigint generated always as identity unique,
  id uuid primary key,
  household_id uuid not null references households (id),
  payment_id uuid not null,
  -- One user action (a payment with its allocations, a refund across several allocations) shares an event id.
  event_id uuid not null,
  kind text not null check (kind in ('allocation', 'allocation_reversal', 'refund', 'unapplied_refund', 'refund_reversal')),
  bill_id uuid,
  -- The allocation entry this entry draws from (equal to id for an allocation). Null for cash that was never applied.
  allocation_id uuid,
  reverses_entry_id uuid,
  amount_cents bigint not null check (amount_cents <> 0 and amount_cents between -10000000000000 and 10000000000000),
  effective_date date not null check (effective_date between date '1900-01-01' and date '2100-01-01'),
  reason text not null default '' check (char_length(reason) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id) references payments (household_id, id),
  foreign key (household_id, bill_id) references bills (household_id, id),
  unique (household_id, payment_id, id),
  unique (household_id, payment_id, id, bill_id),
  foreign key (household_id, payment_id, allocation_id, bill_id) references payment_entries (household_id, payment_id, id, bill_id),
  check (case kind
    when 'allocation' then amount_cents > 0 and bill_id is not null and allocation_id = id and reverses_entry_id is null
    when 'allocation_reversal' then amount_cents < 0 and bill_id is not null and allocation_id is not null and allocation_id <> id and reverses_entry_id is null
    when 'refund' then amount_cents < 0 and bill_id is not null and allocation_id is not null and allocation_id <> id and reverses_entry_id is null
    when 'unapplied_refund' then amount_cents < 0 and bill_id is null and allocation_id is null and reverses_entry_id is null
    when 'refund_reversal' then amount_cents > 0 and reverses_entry_id is not null and (bill_id is null) = (allocation_id is null)
  end)
);
create index payment_entries_payment_idx on payment_entries (household_id, payment_id, seq);
create index payment_entries_bill_idx on payment_entries (household_id, bill_id) where bill_id is not null;
create index payment_entries_allocation_idx on payment_entries (household_id, allocation_id) where allocation_id is not null;
-- A refund entry is reversed at most once, even under concurrent requests.
create unique index payment_entries_one_refund_reversal on payment_entries (reverses_entry_id) where reverses_entry_id is not null;

create trigger payments_no_change before update or delete on payments for each row execute function ledger_immutable();
create trigger payments_no_truncate before truncate on payments for each statement execute function ledger_immutable();
create trigger payment_voids_no_change before update or delete on payment_voids for each row execute function ledger_immutable();
create trigger payment_voids_no_truncate before truncate on payment_voids for each statement execute function ledger_immutable();
create trigger payment_entries_no_change before update or delete on payment_entries for each row execute function ledger_immutable();
create trigger payment_entries_no_truncate before truncate on payment_entries for each statement execute function ledger_immutable();

-- Reference rules the composite foreign keys cannot express.
create function payment_entries_validate() returns trigger language plpgsql as $$
declare
  t record;
begin
  if new.kind = 'allocation' then
    -- Cash is applied only to confirmed bill amounts; an estimate has no reliable balance to apply against.
    if not exists (select 1 from bills where household_id = new.household_id and id = new.bill_id and amount_status = 'confirmed') then
      raise exception 'payments can only be applied to bills with confirmed amounts' using errcode = 'check_violation';
    end if;
  elsif new.kind in ('allocation_reversal', 'refund') then
    select kind, bill_id, payment_id into t from payment_entries where household_id = new.household_id and id = new.allocation_id;
    if t is null or t.kind <> 'allocation' or t.payment_id <> new.payment_id or t.bill_id <> new.bill_id then
      raise exception 'the target must be an allocation of the same payment and bill' using errcode = 'check_violation';
    end if;
  elsif new.kind = 'refund_reversal' then
    select kind, bill_id, payment_id, allocation_id, amount_cents into t from payment_entries
      where household_id = new.household_id and id = new.reverses_entry_id;
    if t is null or t.kind not in ('refund', 'unapplied_refund') or t.payment_id <> new.payment_id
       or t.bill_id is distinct from new.bill_id or t.allocation_id is distinct from new.allocation_id or t.amount_cents <> -new.amount_cents then
      raise exception 'a refund reversal must exactly offset one refund of the same payment' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger payment_entries_validate before insert on payment_entries for each row execute function payment_entries_validate();

-- Plans ---------------------------------------------------------------------------------------------------------------

create table payment_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  provider_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) between 1 and 500),
  cancelled_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, provider_id) references providers (household_id, id),
  unique (household_id, id),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index payment_plans_provider_idx on payment_plans (household_id, provider_id);

create table payment_plan_bills (
  household_id uuid not null,
  plan_id uuid not null,
  bill_id uuid not null,
  primary key (plan_id, bill_id),
  foreign key (household_id, plan_id) references payment_plans (household_id, id),
  foreign key (household_id, bill_id) references bills (household_id, id),
  unique (household_id, plan_id, bill_id)
);
create index payment_plan_bills_bill_idx on payment_plan_bills (household_id, bill_id);

create table plan_revisions (
  id uuid primary key,
  household_id uuid not null,
  plan_id uuid not null,
  revision_no integer not null check (revision_no >= 1),
  total_cents bigint not null check (total_cents > 0 and total_cents <= 10000000000000),
  cadence text not null check (cadence in ('weekly', 'biweekly', 'monthly', 'custom')),
  reason text not null check (char_length(reason) between 1 and 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, plan_id) references payment_plans (household_id, id),
  unique (plan_id, revision_no),
  unique (household_id, plan_id, id)
);

create table plan_installments (
  id uuid primary key,
  household_id uuid not null,
  plan_id uuid not null,
  revision_id uuid not null,
  seq integer not null check (seq >= 1),
  due_date date not null check (due_date between date '1900-01-01' and date '2100-01-01'),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 10000000000000),
  foreign key (household_id, plan_id, revision_id) references plan_revisions (household_id, plan_id, id),
  unique (revision_id, seq),
  unique (household_id, plan_id, revision_id, id)
);
create index plan_installments_due_idx on plan_installments (household_id, due_date);

-- Signed, immutable links from an installment to an existing allocation. A match never creates or moves cash.
create table installment_matches (
  seq bigint generated always as identity unique,
  id uuid primary key,
  household_id uuid not null,
  plan_id uuid not null,
  revision_id uuid not null,
  installment_id uuid not null,
  payment_id uuid not null,
  allocation_id uuid not null,
  bill_id uuid not null,
  kind text not null check (kind in ('match', 'unmatch')),
  amount_cents bigint not null check (amount_cents <> 0 and amount_cents between -10000000000000 and 10000000000000),
  carried boolean not null default false,
  reason text not null default '' check (char_length(reason) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, plan_id, revision_id, installment_id) references plan_installments (household_id, plan_id, revision_id, id),
  foreign key (household_id, payment_id, allocation_id, bill_id) references payment_entries (household_id, payment_id, id, bill_id),
  -- The allocation must pay one of the plan's bills.
  foreign key (household_id, plan_id, bill_id) references payment_plan_bills (household_id, plan_id, bill_id),
  check ((kind = 'match') = (amount_cents > 0))
);
create index installment_matches_installment_idx on installment_matches (household_id, installment_id);
create index installment_matches_allocation_idx on installment_matches (household_id, allocation_id);

create trigger plan_revisions_no_change before update or delete on plan_revisions for each row execute function ledger_immutable();
create trigger plan_revisions_no_truncate before truncate on plan_revisions for each statement execute function ledger_immutable();
create trigger plan_installments_no_change before update or delete on plan_installments for each row execute function ledger_immutable();
create trigger plan_installments_no_truncate before truncate on plan_installments for each statement execute function ledger_immutable();
create trigger installment_matches_no_change before update or delete on installment_matches for each row execute function ledger_immutable();
create trigger installment_matches_no_truncate before truncate on installment_matches for each statement execute function ledger_immutable();
create trigger payment_plan_bills_no_change before update or delete on payment_plan_bills for each row execute function ledger_immutable();
create trigger payment_plan_bills_no_truncate before truncate on payment_plan_bills for each statement execute function ledger_immutable();

-- Commit-time guards ---------------------------------------------------------------------------------------------------
-- Each takes the payment row lock in its own statement first, so after waiting for another writer the following statements
-- see that writer's committed rows. FOR NO KEY UPDATE does not conflict with the key-share locks that foreign keys take.

-- Cash on a payment: unapplied = amount - refunded cash - applied must stay >= 0, every allocation must stay between zero
-- and its original amount, and a voided payment must have nothing applied or refunded.
create function payment_ledger_guard() returns trigger language plpgsql as $$
declare
  pid uuid := new.payment_id;
  amt bigint;
  applied bigint;
  refunded bigint;
  bad uuid;
begin
  perform 1 from payments where id = pid for no key update;
  select amount_cents into amt from payments where id = pid;
  select coalesce(sum(amount_cents) filter (where bill_id is not null), 0),
         -coalesce(sum(amount_cents) filter (where kind in ('refund', 'unapplied_refund', 'refund_reversal')), 0)
    into applied, refunded from payment_entries where payment_id = pid;
  if applied < 0 or refunded < 0 or amt - refunded - applied < 0 then
    raise exception 'applied cash plus refunds would exceed the payment (payment %, amount %, applied %, refunded %)', pid, amt, applied, refunded
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from payment_voids where payment_id = pid) and (applied <> 0 or refunded <> 0) then
    raise exception 'a voided payment cannot keep applied or refunded cash (payment %)', pid using errcode = 'check_violation';
  end if;
  select e.allocation_id into bad from payment_entries e where e.payment_id = pid and e.allocation_id is not null
    group by e.allocation_id
    having sum(e.amount_cents) < 0 or sum(e.amount_cents) > (select a.amount_cents from payment_entries a where a.id = e.allocation_id)
    limit 1;
  if bad is not null then
    raise exception 'an allocation cannot be reduced below zero or restored above its original amount (allocation %)', bad
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger payment_entries_guard after insert on payment_entries
  deferrable initially deferred for each row execute function payment_ledger_guard();
create constraint trigger payment_voids_guard after insert on payment_voids
  deferrable initially deferred for each row execute function payment_ledger_guard();

-- Matches never exceed an installment, and never exceed what an allocation still holds after refunds and reversals. Only
-- the plan's current revision counts: earlier revisions keep their matched history as it was.
create function allocation_match_check(pid uuid, alloc uuid) returns void language plpgsql as $$
declare
  remaining bigint;
  matched bigint;
begin
  perform 1 from payments where id = pid for no key update;
  select coalesce(sum(amount_cents), 0) into remaining from payment_entries where payment_id = pid and allocation_id = alloc;
  -- Across every plan, so one allocation cannot be counted twice by two schedules.
  select coalesce(sum(m.amount_cents), 0) into matched from installment_matches m
    join plan_revisions r on r.id = m.revision_id
    where m.allocation_id = alloc and r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = m.plan_id);
  if matched > remaining then
    raise exception 'plan matches would exceed what the allocation still holds (allocation %, remaining % cents)', alloc, remaining
      using errcode = 'check_violation';
  end if;
end $$;

create function installment_match_guard() returns trigger language plpgsql as $$
declare
  total bigint;
  cap bigint;
begin
  perform allocation_match_check(new.payment_id, new.allocation_id);
  select coalesce(sum(amount_cents), 0) into total from installment_matches where installment_id = new.installment_id;
  select amount_cents into cap from plan_installments where id = new.installment_id;
  if total < 0 or total > cap then
    raise exception 'matches must stay between zero and the installment amount (installment %)', new.installment_id using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger installment_matches_guard after insert on installment_matches
  deferrable initially deferred for each row execute function installment_match_guard();

-- A refund or reversal can lower an allocation below what plan matches rely on; the same commit must unmatch the difference.
create function payment_entry_match_guard() returns trigger language plpgsql as $$
begin
  if new.allocation_id is not null and new.amount_cents < 0 then
    perform allocation_match_check(new.payment_id, new.allocation_id);
  end if;
  return null;
end $$;
create constraint trigger payment_entries_match_guard after insert on payment_entries
  deferrable initially deferred for each row execute function payment_entry_match_guard();

-- Every schedule revision totals exactly its installments.
create function plan_revision_guard() returns trigger language plpgsql as $$
declare
  rid uuid;
  total bigint;
  scheduled bigint;
  n integer;
begin
  if tg_table_name = 'plan_revisions' then rid := new.id; else rid := new.revision_id; end if;
  select total_cents into total from plan_revisions where id = rid;
  select coalesce(sum(amount_cents), 0), count(*) into scheduled, n from plan_installments where revision_id = rid;
  if n < 1 or scheduled <> total then
    raise exception 'a schedule revision must have installments that add up to its total (revision %)', rid using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger plan_revisions_guard after insert on plan_revisions
  deferrable initially deferred for each row execute function plan_revision_guard();
create constraint trigger plan_installments_guard after insert on plan_installments
  deferrable initially deferred for each row execute function plan_revision_guard();

-- Stable read model for balances and HSA reconciliation (M04): one row per allocation with its net cash after reversals
-- and refunds. Voided or fully refunded allocations show zero.
create view allocation_net as
  select a.household_id, a.id as allocation_id, a.payment_id, a.bill_id, p.paid_on, a.amount_cents as allocated_cents,
         -coalesce(sum(e.amount_cents) filter (where e.kind = 'allocation_reversal'), 0) as reversed_cents,
         -coalesce(sum(e.amount_cents) filter (where e.kind in ('refund', 'refund_reversal')), 0) as refunded_cents,
         coalesce(sum(e.amount_cents), 0) as net_cents
    from payment_entries a
    join payments p on p.household_id = a.household_id and p.id = a.payment_id
    join payment_entries e on e.household_id = a.household_id and e.allocation_id = a.id
   where a.kind = 'allocation'
   group by a.household_id, a.id, a.payment_id, a.bill_id, p.paid_on, a.amount_cents;
