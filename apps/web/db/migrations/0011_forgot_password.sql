-- Self-service "forgot password" by email.
--
-- A request must never lock the account out, so an emailed temporary password is NOT written into users.password_hash when it is
-- issued. Its Argon2id hash lives in password_resets.secret_hash (null for administrator-issued credentials, which keep using
-- users.password_hash) and the account's current password keeps working until the emailed one is actually used to sign in. Only then
-- does the credential take the place of the password (the same restricted, change-required state as an administrator reset).
alter table password_resets add column secret_hash text;
alter table password_resets add check (kind <> 'email_temporary' or secret_hash is not null);
alter table password_resets add check (kind <> 'admin_temporary' or secret_hash is null);

-- One row per reset request, for existing and unknown addresses alike, so limits and audit decisions cannot reveal which addresses
-- have accounts. The address is stored only as a SHA-256 digest under its own prefix (separate from the sign-in throttle, so requests can never lock sign-in). Pruned after a day.
create table password_reset_requests (
  id bigint generated always as identity primary key,
  email_hash bytea not null,
  client_ip text not null,
  requested_at timestamptz not null default now()
);
create index password_reset_requests_email_idx on password_reset_requests (email_hash, requested_at);
create index password_reset_requests_ip_idx on password_reset_requests (client_ip, requested_at);
