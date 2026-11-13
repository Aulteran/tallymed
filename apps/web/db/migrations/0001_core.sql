-- Core identity, session and audit tables. Synthetic data only in tests.
create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  email text not null check (char_length(email) between 3 and 254),
  display_name text not null check (char_length(display_name) between 1 and 80),
  role text not null check (role in ('admin', 'operator')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  password_hash text not null,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_lower_key on users (lower(email));
create index users_household_idx on users (household_id);

-- Sessions store only a SHA-256 digest of the cookie token.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  household_id uuid not null references households (id),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index sessions_user_idx on sessions (user_id);

-- Closed exactly once by the local bootstrap procedure. The primary key on a
-- constant makes a second bootstrap fail inside the database, not just in code.
create table bootstrap_state (
  singleton boolean primary key default true check (singleton),
  household_id uuid not null references households (id),
  admin_user_id uuid not null references users (id),
  closed_at timestamptz not null default now()
);

create table audit_events (
  id bigint generated always as identity primary key,
  household_id uuid references households (id),
  actor_user_id uuid references users (id),
  action text not null,
  entity_type text not null,
  entity_id text,
  request_id text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index audit_events_household_time_idx on audit_events (household_id, occurred_at);

create function audit_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;
create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function audit_events_immutable();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function audit_events_immutable();
