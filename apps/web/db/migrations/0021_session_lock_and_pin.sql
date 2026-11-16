-- Keep me signed in, the interface lock and the security PIN.
--
-- users.pin_hash holds an Argon2id hash of a six-digit PIN (never the PIN). It is nullable: an account created before this
-- migration has none until the person sets one, and an account without a PIN is never locked.
--
-- sessions.remember marks a sign-in made with "Keep me signed in" (a longer lifetime, see TALLYMED_REMEMBER_SESSION_*).
-- sessions.locked_at is the lock itself. It lives on the session, not in the browser, so a reload, a second tab or a
-- browser reopened days later still lands on the PIN screen, and every authenticated route refuses a locked session.
-- sessions.pin_failures counts wrong PINs tried on this session; it is incremented before the PIN is checked and reset only by a
-- correct one, so a stolen cookie gets a handful of guesses in total. Reaching the limit revokes the session.
alter table users
  add column pin_hash text,
  add column pin_changed_at timestamptz,
  add constraint users_pin_changed_check check (pin_hash is not null or pin_changed_at is null);

alter table sessions
  add column remember boolean not null default false,
  add column locked_at timestamptz,
  add column pin_failures integer not null default 0 check (pin_failures >= 0);
