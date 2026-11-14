-- Temporary passwords and forced password change.
--
-- The temporary password itself is never stored in the clear: an administrator reset writes its Argon2id hash into
-- users.password_hash (so the old password stops working at once) and sets must_change_password. Until the person
-- chooses a new password the account can reach only the change-password page and sign-out.
--
-- password_resets records each issued temporary credential without any secret. It is the reusable model for later
-- self-service resets: a future delivery channel inserts a row with its own kind and issuer and reuses the same
-- lifecycle (open -> used -> completed, or open/used -> superseded; expiry is derived from expires_at).
alter table users
  add column must_change_password boolean not null default false,
  add column password_changed_at timestamptz;

create table password_resets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  user_id uuid not null references users (id) on delete cascade,
  -- 'email_temporary' is reserved for the planned forgot-password flow; nothing issues it yet.
  kind text not null check (kind in ('admin_temporary', 'email_temporary')),
  -- The administrator who issued it; null for a future self-service reset.
  issued_by uuid references users (id),
  status text not null default 'open' check (status in ('open', 'used', 'completed', 'superseded')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > created_at),
  used_at timestamptz,
  completed_at timestamptz,
  check (status <> 'used' or used_at is not null),
  check ((status = 'completed') = (completed_at is not null))
);

-- At most one temporary password can still be signed in with, per account, even under concurrent resets.
create unique index password_resets_one_open_idx on password_resets (user_id) where status = 'open';
create index password_resets_user_idx on password_resets (user_id, created_at desc);
create index password_resets_household_idx on password_resets (household_id, created_at desc);
