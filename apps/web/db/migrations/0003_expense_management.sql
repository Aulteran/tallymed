-- Medical expense management: family members, providers, visits, bills, signed adjustments and
-- idempotency records. Money is USD in bigint cents. Synthetic data only in tests.

create table family_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  name text not null check (char_length(name) between 1 and 80),
  date_of_birth date check (date_of_birth between date '1900-01-01' and date '2100-01-01'),
  notes text not null default '' check (char_length(notes) <= 2000),
  archived_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id)
);
create index family_members_name_idx on family_members (household_id, lower(name), id);

create table providers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  name text not null check (char_length(name) between 1 and 120),
  kind text not null default 'other' check (kind in ('facility', 'clinician', 'lab', 'pharmacy', 'other')),
  notes text not null default '' check (char_length(notes) <= 2000),
  archived_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id)
);
create index providers_name_idx on providers (household_id, lower(name), id);

-- A visit belongs to a member and references a provider. Bills from other providers can join the same visit.
create table visits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  member_id uuid not null,
  provider_id uuid not null,
  service_date date not null check (service_date between date '1900-01-01' and date '2100-01-01'),
  description text not null default '' check (char_length(description) <= 200),
  notes text not null default '' check (char_length(notes) <= 2000),
  member_name_snapshot text not null,
  provider_name_snapshot text not null,
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, member_id) references family_members (household_id, id),
  foreign key (household_id, provider_id) references providers (household_id, id),
  unique (household_id, id),
  unique (household_id, id, member_id)
);
create index visits_date_idx on visits (household_id, service_date desc, id desc);
create index visits_member_idx on visits (household_id, member_id);
create index visits_provider_idx on visits (household_id, provider_id);

create table bills (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  member_id uuid not null,
  provider_id uuid not null,
  visit_id uuid,
  provider_reference text check (provider_reference is null or char_length(provider_reference) between 1 and 80),
  -- Normalized reference used only for duplicate hints.
  reference_norm text generated always as (lower(regexp_replace(coalesce(provider_reference, ''), '[^[:alnum:]]', '', 'g'))) stored,
  statement_date date not null check (statement_date between date '1900-01-01' and date '2100-01-01'),
  due_date date check (due_date between date '1900-01-01' and date '2100-01-01'),
  original_cents bigint not null check (original_cents between 0 and 10000000000000),
  base_responsibility_cents bigint not null check (base_responsibility_cents between 0 and 10000000000000),
  amount_status text not null default 'estimate' check (amount_status in ('estimate', 'confirmed')),
  amount_source text not null check (amount_source in ('statement', 'portal', 'eob', 'phone', 'manual')),
  source_note text not null default '' check (char_length(source_note) <= 500),
  notes text not null default '' check (char_length(notes) <= 2000),
  member_name_snapshot text not null,
  provider_name_snapshot text not null,
  confirmed_at timestamptz,
  confirmed_by uuid references users (id),
  version integer not null default 1 check (version >= 1),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (base_responsibility_cents <= original_cents),
  check ((amount_status = 'confirmed') = (confirmed_at is not null)),
  foreign key (household_id, member_id) references family_members (household_id, id),
  foreign key (household_id, provider_id) references providers (household_id, id),
  -- With a null visit_id the check is skipped (awaiting assignment). Otherwise the visit must be this member's.
  foreign key (household_id, visit_id, member_id) references visits (household_id, id, member_id),
  unique (household_id, id)
);
create index bills_statement_idx on bills (household_id, statement_date desc, id desc);
create index bills_member_idx on bills (household_id, member_id);
create index bills_provider_idx on bills (household_id, provider_id, reference_norm);
create index bills_visit_idx on bills (household_id, visit_id);

-- Signed, immutable changes to household responsibility. Corrections are linked reversals.
create table bill_adjustments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  bill_id uuid not null,
  amount_cents bigint not null check (amount_cents <> 0 and amount_cents between -10000000000000 and 10000000000000),
  category text not null check (category in (
    'insurer_adjustment', 'insurer_payment', 'provider_discount', 'financial_assistance', 'correction', 'reversal')),
  effective_date date not null check (effective_date between date '1900-01-01' and date '2100-01-01'),
  reason text not null check (char_length(reason) between 1 and 500),
  source text not null check (source in ('statement', 'portal', 'eob', 'phone', 'manual')),
  source_note text not null default '' check (char_length(source_note) <= 500),
  reverses_adjustment_id uuid,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, bill_id) references bills (household_id, id),
  unique (household_id, bill_id, id),
  foreign key (household_id, bill_id, reverses_adjustment_id) references bill_adjustments (household_id, bill_id, id),
  check (reverses_adjustment_id is distinct from id),
  check ((reverses_adjustment_id is not null) = (category = 'reversal'))
);
create index bill_adjustments_bill_idx on bill_adjustments (household_id, bill_id, created_at, id);
-- A posted adjustment can be reversed at most once, even under concurrent requests.
create unique index bill_adjustments_one_reversal_key on bill_adjustments (reverses_adjustment_id)
  where reverses_adjustment_id is not null;

create function bill_adjustments_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'bill_adjustments is append-only; post a linked reversal instead';
end $$;
create trigger bill_adjustments_no_change before update or delete on bill_adjustments
  for each row execute function bill_adjustments_immutable();
create trigger bill_adjustments_no_truncate before truncate on bill_adjustments
  for each statement execute function bill_adjustments_immutable();

-- One logical request, one effect: replays return the stored result, changed input conflicts.
create table idempotency_records (
  id bigint generated always as identity primary key,
  household_id uuid not null references households (id),
  actor_user_id uuid not null references users (id),
  operation text not null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 100),
  fingerprint text not null check (char_length(fingerprint) = 64),
  result_entity_id uuid not null,
  created_at timestamptz not null default now(),
  unique (household_id, actor_user_id, operation, idempotency_key)
);
