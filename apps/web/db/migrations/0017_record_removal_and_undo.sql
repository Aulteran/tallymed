-- Record removal, HSA funding release and the undo slot. Synthetic data only in tests.
--
--   payment_removal_events        append-only: an administrator removed (or restored) a payment. A payment header stays immutable and no row is ever
--                                 deleted; a removed payment keeps no applied or refunded cash (the services reverse it first), so every figure
--                                 already shows zero. The newest event (highest seq) is the current state. payment_is_removed() reads it.
--   payment_plans.removed_*       a plan is mutable, so removal is three columns that are all null or all set (and can be cleared again).
--                                 New matches to a removed plan are refused; unmatches stay possible.
--   payment_hsa_funding_events    append-only: a direct HSA funding was released (the payment then is an ordinary, claimable payment) or
--                                 reinstated. payment_hsa_funding stays as written; payment_is_direct_hsa() combines both.
--   undo_actions                  one ephemeral slot per user: the inverse of the user's last removal or method change, valid for a few
--                                 minutes by the database clock. It is not a ledger: rows are updated and deleted freely and are not backed up.
-- Lock order stays: payments, bills, plans, payment method, then HSA account last.

-- Payment removal ---------------------------------------------------------------------------------------------------------

create table payment_removal_events (
  seq bigint generated always as identity unique,
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  payment_id uuid not null,
  action text not null check (action in ('remove', 'restore')),
  reason text not null default '' check (char_length(reason) <= 500),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id) references payments (household_id, id)
);
create index payment_removal_events_payment_idx on payment_removal_events (household_id, payment_id, seq desc);
create trigger payment_removal_events_no_change before update or delete on payment_removal_events for each row execute function ledger_immutable();
create trigger payment_removal_events_no_truncate before truncate on payment_removal_events for each statement execute function ledger_immutable();

-- A payment is removed while its newest removal event says so.
create function payment_is_removed(pid uuid) returns boolean language sql stable as $$
  select coalesce((select e.action from payment_removal_events e where e.payment_id = pid order by e.seq desc limit 1), 'restore') = 'remove'
$$;

-- The events alternate: only a payment that is not removed can be removed and only a removed one restored. The payment row lock comes first
-- (the carried lock order), so two concurrent events on one payment are checked one after the other.
create function payment_removal_event_check() returns trigger language plpgsql as $$
declare removed boolean;
begin
  perform 1 from payments where id = new.payment_id for no key update;
  removed := payment_is_removed(new.payment_id);
  if new.action = 'remove' and removed then
    raise exception 'the payment is already removed (payment %)', new.payment_id using errcode = 'check_violation';
  end if;
  if new.action = 'restore' and not removed then
    raise exception 'the payment is not removed (payment %)', new.payment_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payment_removal_event_check before insert on payment_removal_events for each row execute function payment_removal_event_check();

-- The same cash guard as for entries and voids, now also run for a removal event (and so, at commit, after the reversals of the same transaction).
-- Every rule of 0005 is unchanged; only the removed-payment rule is new.
create or replace function payment_ledger_guard() returns trigger language plpgsql as $$
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
  if payment_is_removed(pid) and (applied <> 0 or refunded <> 0) then
    raise exception 'a removed payment cannot keep applied or refunded cash (payment %)', pid using errcode = 'check_violation';
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
create constraint trigger payment_removal_events_guard after insert on payment_removal_events
  deferrable initially deferred for each row execute function payment_ledger_guard();

-- Plan removal ------------------------------------------------------------------------------------------------------------

alter table payment_plans
  add column removed_at timestamptz,
  add column removed_by uuid references users (id),
  add column removed_reason text check (removed_reason is null or char_length(removed_reason) between 1 and 500),
  add constraint payment_plans_removed_all_or_none check ((removed_at is null) = (removed_by is null) and (removed_at is null) = (removed_reason is null));

-- Latest definition of installment_match_guard is 0005's; the only change is that a new match to a removed plan is refused.
create or replace function installment_match_guard() returns trigger language plpgsql as $$
declare
  total bigint;
  cap bigint;
  pair bigint;
  plan_status text;
  plan_removed timestamptz;
  current_rev boolean;
begin
  -- Same order as the services: the allocation's payment first, then the installment. The installment row lock serializes
  -- concurrent writers of one installment (they hold different payment locks), so the cap is checked one after the other.
  perform allocation_match_check(new.payment_id, new.allocation_id);
  perform 1 from plan_installments where id = new.installment_id for no key update;
  select coalesce(sum(amount_cents), 0) into total from installment_matches where installment_id = new.installment_id;
  select amount_cents into cap from plan_installments where id = new.installment_id;
  if total < 0 or total > cap then
    raise exception 'matches must stay between zero and the installment amount (installment %)', new.installment_id using errcode = 'check_violation';
  end if;
  select coalesce(sum(amount_cents), 0) into pair from installment_matches where installment_id = new.installment_id and allocation_id = new.allocation_id;
  if pair < 0 then
    raise exception 'an unmatch cannot exceed what that allocation matched to the installment (installment %, allocation %)', new.installment_id, new.allocation_id
      using errcode = 'check_violation';
  end if;
  if new.kind = 'match' then
    -- New matches go to the current schedule revision of an active, not removed plan. Unmatches stay possible on any plan so refunds can release cash.
    select p.status, p.removed_at, (r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = p.id))
      into plan_status, plan_removed, current_rev
      from payment_plans p join plan_revisions r on r.id = new.revision_id where p.id = new.plan_id for share of p;
    if plan_removed is not null then
      raise exception 'matches cannot be added to a removed plan (plan %)', new.plan_id using errcode = 'check_violation';
    end if;
    if plan_status <> 'active' or not current_rev then
      raise exception 'matches can only be added to the current schedule of an active plan (plan %)', new.plan_id using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;

-- Releasing a direct HSA funding ------------------------------------------------------------------------------------------

-- The funding row is immutable and keeps its meaning ("paid from this account at the point of service"); a release is a later event.
alter table payment_hsa_funding add constraint payment_hsa_funding_household_payment_key unique (household_id, payment_id);

create table payment_hsa_funding_events (
  seq bigint generated always as identity unique,
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  payment_id uuid not null,
  action text not null check (action in ('release', 'reinstate')),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id) references payment_hsa_funding (household_id, payment_id)
);
create index payment_hsa_funding_events_payment_idx on payment_hsa_funding_events (household_id, payment_id, seq desc);
create trigger payment_hsa_funding_events_no_change before update or delete on payment_hsa_funding_events for each row execute function ledger_immutable();
create trigger payment_hsa_funding_events_no_truncate before truncate on payment_hsa_funding_events for each statement execute function ledger_immutable();

-- Paid directly from an HSA: a funding row exists and its newest event is not a release.
create function payment_is_direct_hsa(pid uuid) returns boolean language sql stable as $$
  select exists (select 1 from payment_hsa_funding f where f.payment_id = pid)
     and coalesce((select e.action from payment_hsa_funding_events e where e.payment_id = pid order by e.seq desc limit 1), 'reinstate') <> 'release'
$$;

-- Events alternate, starting with a release. A reinstatement follows the same rule as the funding itself: the account is active and the payment
-- has no HSA entries or decisions. The payment row lock comes first, then a share lock on the account, as in payment_hsa_funding_check.
create function payment_hsa_funding_event_check() returns trigger language plpgsql as $$
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
    if exists (select 1 from hsa_entries e where e.payment_id = new.payment_id)
       or exists (select 1 from hsa_eligibility_decisions d join payment_entries a on a.id = d.allocation_id where a.payment_id = new.payment_id) then
      raise exception 'a payment that already has HSA claims or decisions cannot be paid directly from an HSA again' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger payment_hsa_funding_event_check before insert on payment_hsa_funding_events for each row execute function payment_hsa_funding_event_check();

-- The other direction, as in 0016, now through payment_is_direct_hsa so a released payment takes claims again.
create or replace function hsa_refuse_direct_payment() returns trigger language plpgsql as $$
declare pid uuid;
begin
  if tg_table_name = 'hsa_entries' then
    pid := new.payment_id;
  else
    select a.payment_id into pid from payment_entries a where a.id = new.allocation_id;
  end if;
  perform 1 from payments where id = pid for no key update;
  if payment_is_direct_hsa(pid) then
    raise exception 'a payment paid directly from an HSA takes no claims, reimbursements or eligibility decisions' using errcode = 'check_violation';
  end if;
  return null;
end $$;

-- payment_hsa_funding_check (0016) tests a payment's HSA entries and decisions, not its funding, so it is unchanged.

-- Same view as 0016 with the same columns in the same order; only the funding test changes.
create or replace view hsa_allocation_status as
select s.*,
       case when payment_is_direct_hsa(s.payment_id) then 0
            else greatest(0, s.ceiling_cents - s.pending_cents - s.received_cents) end as available_cents,
       greatest(0, s.pending_cents + s.received_cents - s.ceiling_cents) as needs_review_cents,
       payment_is_direct_hsa(s.payment_id) as direct_hsa
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

-- Undo slot ----------------------------------------------------------------------------------------------------------------

create table undo_actions (
  user_id uuid primary key references users (id),
  household_id uuid not null references households (id),
  kind text not null check (kind in ('payment_remove', 'plan_remove', 'method_change')),
  entity_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index undo_actions_expires_idx on undo_actions (expires_at);
