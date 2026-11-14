-- Administrator-editable server settings.
--
--   server_settings  one row per settings group ('general', 'documents', 'email', 'proxy'). The value is a JSON object of non-secret fields.
--                    A secret (the SMTP password) is never stored in the value: it lives encrypted in secret_ciphertext (AES-256-GCM,
--                    key from TALLYMED_SECRETS_KEY) and is never returned to a browser. A missing row or a missing field means "use the
--                    environment value or built-in default". The version supports optimistic concurrency.
--
-- Settings are server-wide (one installation, one set of values), so the table has no household column. Every change is audited by
-- the service in the same transaction (action 'settings.updated', changed field names and non-secret values only).

create table server_settings (
  group_key text primary key check (group_key in ('general', 'documents', 'email', 'proxy')),
  value jsonb not null default '{}'::jsonb check (jsonb_typeof(value) = 'object' and pg_column_size(value) <= 4096),
  secret_ciphertext text check (secret_ciphertext is null or char_length(secret_ciphertext) between 20 and 2048),
  version integer not null default 1 check (version >= 1),
  updated_by uuid references users (id),
  updated_at timestamptz not null default now()
);
