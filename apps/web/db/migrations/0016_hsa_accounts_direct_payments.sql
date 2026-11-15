-- HSA accounts, HSA-linked payment methods and payments paid directly from an HSA. Synthetic data only in tests.
--
--   hsa_accounts                 the household's named HSA accounts: a name, the administrator and optionally the last four digits. Nothing
--                                that could move money is stored.
--   payment_method_hsa_links     which HSA account a saved payment method (an HSA card) draws from. One account per method; the link can be
--                                changed or removed, which never alters a payment already recorded.
--   payment_hsa_funding          append-only: this payment was paid directly from that HSA account, at the point of service. It is written
--                                in the same transaction as the payment and never afterwards.
-- A directly paid payment is already settled by the HSA, so it cannot be claimed back. The database enforces that in both directions: no HSA
-- claim, reimbursement or eligibility decision on such a payment, and no direct funding on a payment that already has HSA entries. The
-- hsa_allocation_status view reports zero available cash for those allocations, so claims, reimbursements, totals and queues follow.
-- Lock order: payments, bills, plans, payment method, then HSA account last.

create table hsa_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  name text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  administrator text not null default '' check (char_length(administrator) <= 80 and administrator = btrim(administrator)),
  last_four text check (last_four is null or last_four ~ '^[0-9]{4}$'),
  archived_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  -- A name or administrator is a label, not a place for an account number: nine or more digits in a row (spaces and hyphens ignored) are refused.
  check (regexp_replace(name, '[ -]', '', 'g') !~ '[0-9]{9,}' and regexp_replace(administrator, '[ -]', '', 'g') !~ '[0-9]{9,}')
);
create unique index hsa_accounts_active_name on hsa_accounts (household_id, lower(name)) where archived_at is null;
create index hsa_accounts_household_idx on hsa_accounts (household_id, lower(name), id);

create function hsa_accounts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'HSA accounts are never deleted; archive them instead' using errcode = 'check_violation';
  end if;
  if new.id <> old.id or new.household_id <> old.household_id or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'an HSA account keeps its identity' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger hsa_accounts_guard before update or delete on hsa_accounts for each row execute function hsa_accounts_guard();
create trigger hsa_accounts_no_truncate before truncate on hsa_accounts for each statement execute function ledger_immutable();

create table payment_method_hsa_links (
  method_id uuid primary key,
  household_id uuid not null references households (id),
  hsa_account_id uuid not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, method_id) references payment_methods (household_id, id),
  foreign key (household_id, hsa_account_id) references hsa_accounts (household_id, id)
);
create index payment_method_hsa_links_account_idx on payment_method_hsa_links (household_id, hsa_account_id);

create table payment_hsa_funding (
  payment_id uuid primary key,
  household_id uuid not null references households (id),
  hsa_account_id uuid not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id) references payments (household_id, id),
  foreign key (household_id, hsa_account_id) references hsa_accounts (household_id, id)
);
create index payment_hsa_funding_account_idx on payment_hsa_funding (household_id, hsa_account_id);
create trigger payment_hsa_funding_no_change before update or delete on payment_hsa_funding for each row execute function ledger_immutable();
create trigger payment_hsa_funding_no_truncate before truncate on payment_hsa_funding for each statement execute function ledger_immutable();

-- A payment is funded directly only into an active account, and only while it has no HSA entries. The payment row lock comes first (the
-- carried lock order), then a share lock on the account so an archive cannot slip in before commit.
create function payment_hsa_funding_check() returns trigger language plpgsql as $$
declare archived timestamptz;
begin
  perform 1 from payments where id = new.payment_id for no key update;
  select archived_at into archived from hsa_accounts where household_id = new.household_id and id = new.hsa_account_id for share;
  if archived is not null then
    raise exception 'that HSA account is archived' using errcode = 'check_violation';
  end if;
  if exists (select 1 from hsa_entries e where e.payment_id = new.payment_id)
     or exists (select 1 from hsa_eligibility_decisions d join payment_entries a on a.id = d.allocation_id where a.payment_id = new.payment_id) then
    raise exception 'a payment that already has HSA claims or decisions cannot be paid directly from an HSA' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payment_hsa_funding_check before insert on payment_hsa_funding for each row execute function payment_hsa_funding_check();

-- The other direction: a payment paid directly from an HSA takes no claim, reimbursement or eligibility decision. Checked at commit, like
-- the other HSA guards, after taking the payment row lock first, so it is race-safe against a concurrent funding insert (which takes the
-- same lock and looks for HSA entries): whichever commits second sees the other's row and refuses.
create function hsa_refuse_direct_payment() returns trigger language plpgsql as $$
declare pid uuid;
begin
  if tg_table_name = 'hsa_entries' then
    pid := new.payment_id;
  else
    select a.payment_id into pid from payment_entries a where a.id = new.allocation_id;
  end if;
  perform 1 from payments where id = pid for no key update;
  if exists (select 1 from payment_hsa_funding f where f.payment_id = pid) then
    raise exception 'a payment paid directly from an HSA takes no claims, reimbursements or eligibility decisions' using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger hsa_entries_refuse_direct after insert on hsa_entries
  deferrable initially deferred for each row execute function hsa_refuse_direct_payment();
create constraint trigger hsa_decisions_refuse_direct after insert on hsa_eligibility_decisions
  deferrable initially deferred for each row execute function hsa_refuse_direct_payment();

-- Directly paid allocations have nothing available to claim. Only the available_cents expression changes; the new column comes last so
-- every existing column keeps its position and meaning.
create or replace view hsa_allocation_status as
select s.*,
       case when exists (select 1 from payment_hsa_funding f where f.payment_id = s.payment_id) then 0
            else greatest(0, s.ceiling_cents - s.pending_cents - s.received_cents) end as available_cents,
       greatest(0, s.pending_cents + s.received_cents - s.ceiling_cents) as needs_review_cents,
       exists (select 1 from payment_hsa_funding f where f.payment_id = s.payment_id) as direct_hsa
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
