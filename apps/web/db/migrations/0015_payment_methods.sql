-- Saved payment methods and which one paid a payment. Synthetic data only in tests.
--
--   payment_methods              the household's named ways of paying: a nickname, a type and optionally the last four digits. Nothing
--                                that could charge anything is stored (no full number, expiry date or security code). A method is never
--                                deleted; archiving hides it from new payments and keeps every old payment's link.
--   payment_method_assignments   append-only history of "this payment was paid with this method" (or, with a null method, "cleared").
--                                A payment header is immutable (ledger_immutable), so the choice lives beside it. The newest row per
--                                payment (highest seq) is the current one. It never touches a payment's amount, allocations or balances.
-- This is separate from payments.method, which is the kind of payment (card, check, cash...) and stays as it is.
-- Lock order: payments, bills, plans (unchanged), then payment methods last. Only the assignment trigger and the archive action lock a
-- method row, and neither holds a payment, bill or plan lock that a method writer could be waiting on in the other direction.

create table payment_methods (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  nickname text not null check (char_length(nickname) between 1 and 60 and nickname = btrim(nickname)),
  -- A nickname is a label, not a place to keep a card or account number: nine or more digits in a row (spaces and hyphens ignored) are refused.
  check (regexp_replace(nickname, '[ -]', '', 'g') !~ '[0-9]{9,}'),
  kind text not null check (kind in ('credit_card', 'debit_card', 'hsa_fsa_card', 'bank_account', 'other')),
  last_four text check (last_four is null or last_four ~ '^[0-9]{4}$'),
  archived_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id)
);
-- Two active methods cannot share a nickname (so the dropdown is never ambiguous). Archived ones can be reused.
create unique index payment_methods_active_nickname on payment_methods (household_id, lower(nickname)) where archived_at is null;
create index payment_methods_household_idx on payment_methods (household_id, lower(nickname), id);

create function payment_methods_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payment methods are never deleted; archive them instead' using errcode = 'check_violation';
  end if;
  if new.id <> old.id or new.household_id <> old.household_id or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'a payment method keeps its identity' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payment_methods_guard before update or delete on payment_methods for each row execute function payment_methods_guard();
create trigger payment_methods_no_truncate before truncate on payment_methods for each statement execute function ledger_immutable();

create table payment_method_assignments (
  seq bigint generated always as identity unique,
  id uuid primary key,
  household_id uuid not null references households (id),
  payment_id uuid not null,
  method_id uuid,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, payment_id) references payments (household_id, id),
  foreign key (household_id, method_id) references payment_methods (household_id, id)
);
create index payment_method_assignments_payment_idx on payment_method_assignments (household_id, payment_id, seq desc);
create index payment_method_assignments_method_idx on payment_method_assignments (household_id, method_id) where method_id is not null;

create trigger payment_method_assignments_no_change before update or delete on payment_method_assignments for each row execute function ledger_immutable();
create trigger payment_method_assignments_no_truncate before truncate on payment_method_assignments for each statement execute function ledger_immutable();

-- A new assignment names a method that is active at that moment. The share lock makes this race-safe against an archive: the archive's
-- update waits for this transaction, or this check sees the archive.
create function payment_method_assignment_check() returns trigger language plpgsql as $$
declare archived timestamptz;
begin
  if new.method_id is null then return new; end if;
  select archived_at into archived from payment_methods where household_id = new.household_id and id = new.method_id for share;
  if archived is not null then
    raise exception 'that payment method is archived' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payment_method_assignment_check before insert on payment_method_assignments for each row execute function payment_method_assignment_check();
