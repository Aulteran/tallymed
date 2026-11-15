-- Sign-in with an external OpenID Connect provider.
--
--   server_settings 'signin'  the provider configuration (issuer, client id, scopes, options). The client secret is stored only in
--                             secret_ciphertext, encrypted like the SMTP password, and is never returned to a browser.
--   user_identities           links one account to one subject at one issuer. A subject signs in as the account it is linked to; the
--                             link is made the first time a provider vouches for a verified email address that matches an account,
--                             or when an administrator has allowed new Standard accounts to be created. An account has at most one
--                             identity per issuer and a subject belongs to at most one account.
--
-- Password sign-in is unchanged and stays available unless an administrator turns it off after signing in through the provider.
alter table server_settings drop constraint server_settings_group_key_check;
alter table server_settings add constraint server_settings_group_key_check
  check (group_key in ('general', 'documents', 'email', 'proxy', 'signin'));

create table user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  household_id uuid not null references households (id),
  issuer text not null check (char_length(issuer) between 8 and 300),
  subject text not null check (char_length(subject) between 1 and 255),
  -- The address the provider vouched for when the link was made. A record of why the link exists; never used to sign in.
  email_at_link text not null check (char_length(email_at_link) between 3 and 254),
  created_via text not null check (created_via in ('email_match', 'provisioned')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  unique (issuer, subject),
  unique (user_id, issuer)
);
create index user_identities_household_idx on user_identities (household_id);
