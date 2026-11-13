create table invitations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  email text not null check (char_length(email) between 3 and 254),
  role text not null check (role in ('admin', 'operator')),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  invited_by uuid not null references users (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_household_idx on invitations (household_id);
-- One open invitation per address at a time.
create unique index invitations_open_email_key on invitations (lower(email))
  where accepted_at is null and revoked_at is null;

-- Throttling keys are digests; no raw email is stored here.
create table login_attempts (
  id bigint generated always as identity primary key,
  email_hash bytea not null check (octet_length(email_hash) = 32),
  client_ip text not null,
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
create index login_attempts_email_idx on login_attempts (email_hash, attempted_at);
create index login_attempts_ip_idx on login_attempts (client_ip, attempted_at);
