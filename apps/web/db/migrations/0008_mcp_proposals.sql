-- Optional AI assistance: scoped MCP client credentials, document-match proposals and the grants of the MCP database role.
-- Synthetic data only in tests. See docs/security.md (Optional LAN-only MCP) and docs/mcp.md.
--
--   mcp_clients               one credential per assistant client. Only the SHA-256 digest of the bearer token is stored; the
--                             token is shown once at creation. Scoped, expiring and revocable. Revocation is permanent.
--   document_match_proposals  a client's suggestion that one document version belongs to one bill or visit. A proposal changes
--                             nothing by itself: only a signed-in person approving it in the app creates the attachment.
--
-- Invariants held by the database (the services check first):
--   * a proposal pins the document version and the target version it was made against, and names a bill or a visit only;
--   * one proposal ever per (document version, target), so a rejected suggestion cannot be re-raised by a client;
--   * a proposal is decided once (pending -> approved or rejected) by a user of its own household; an approval names the
--     attachment it created, and that attachment must be the matching document version and target;
--   * nothing about a proposal or a client credential is deleted, and only the allowed transitions update a row.

create table mcp_clients (
  id uuid primary key,
  household_id uuid not null references households (id),
  name text not null check (char_length(name) between 1 and 80),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  scopes text[] not null check (
    cardinality(scopes) between 1 and 4
    and scopes <@ array['documents:read', 'records:read', 'documents:content', 'proposals:create']::text[]),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users (id),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (household_id, id),
  check ((revoked_at is null) = (revoked_by is null)),
  check (expires_at > created_at)
);
create index mcp_clients_household_idx on mcp_clients (household_id, created_at desc, id desc);

create function mcp_clients_guard_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'assistant clients cannot be deleted; revoke them instead' using errcode = 'check_violation';
  end if;
  if (new.id, new.household_id, new.name, new.token_hash, new.scopes, new.expires_at, new.created_by, new.created_at)
     is distinct from (old.id, old.household_id, old.name, old.token_hash, old.scopes, old.expires_at, old.created_by, old.created_at) then
    raise exception 'assistant client credentials are immutable' using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by) then
    raise exception 'a revoked assistant client stays revoked' using errcode = 'check_violation';
  end if;
  if new.revoked_by is not null and old.revoked_by is null
     and not exists (select 1 from users u where u.id = new.revoked_by and u.household_id = new.household_id) then
    raise exception 'a client is revoked by a user of its own household' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger mcp_clients_guard_change before update or delete on mcp_clients for each row execute function mcp_clients_guard_change();

create table document_match_proposals (
  id uuid primary key,
  household_id uuid not null references households (id),
  client_id uuid not null,
  document_id uuid not null,
  document_version_id uuid not null,
  document_version_no integer not null check (document_version_no >= 1),
  target_type text not null check (target_type in ('bill', 'visit')),
  bill_id uuid,
  visit_id uuid,
  target_id uuid generated always as (coalesce(bill_id, visit_id)) stored,
  -- The bill's or visit's version when the client proposed. A later change to the record makes the proposal stale.
  target_version integer not null check (target_version >= 1),
  -- Untrusted text written by the client. Displayed as plain text only.
  rationale text not null check (char_length(rationale) between 1 and 500),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references users (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) between 1 and 300),
  attachment_id uuid,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  foreign key (household_id, client_id) references mcp_clients (household_id, id),
  foreign key (household_id, document_id) references documents (household_id, id),
  foreign key (household_id, document_id, document_version_id) references document_versions (household_id, document_id, id),
  foreign key (household_id, bill_id) references bills (household_id, id),
  foreign key (household_id, visit_id) references visits (household_id, id),
  foreign key (household_id, attachment_id) references document_attachments (household_id, id),
  unique (household_id, id),
  check (case target_type
    when 'bill' then bill_id is not null and visit_id is null
    else visit_id is not null and bill_id is null
  end),
  check (case status
    when 'pending' then decided_by is null and decided_at is null and decision_note is null and attachment_id is null
    when 'approved' then decided_by is not null and decided_at is not null and attachment_id is not null
    else decided_by is not null and decided_at is not null and decision_note is not null and attachment_id is null
  end)
);
create index document_match_proposals_status_idx on document_match_proposals (household_id, status, created_at desc, id desc);
create index document_match_proposals_client_idx on document_match_proposals (client_id, status, created_at desc);
create index document_match_proposals_document_idx on document_match_proposals (household_id, document_id);
-- One proposal ever per document version and target: a rejected or approved suggestion is never raised again.
create unique index document_match_proposals_once on document_match_proposals (document_id, document_version_no, target_type, target_id);

create function document_match_proposals_guard_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'proposals cannot be deleted' using errcode = 'check_violation';
  end if;
  if (new.id, new.household_id, new.client_id, new.document_id, new.document_version_id, new.document_version_no, new.target_type,
      new.bill_id, new.visit_id, new.target_version, new.rationale, new.confidence, new.created_at)
     is distinct from (old.id, old.household_id, old.client_id, old.document_id, old.document_version_id, old.document_version_no, old.target_type,
      old.bill_id, old.visit_id, old.target_version, old.rationale, old.confidence, old.created_at) then
    raise exception 'a proposal is immutable except for its decision' using errcode = 'check_violation';
  end if;
  if old.status <> 'pending' then
    raise exception 'a proposal is decided once' using errcode = 'check_violation';
  end if;
  if new.status = 'pending' then
    raise exception 'a pending proposal can only be decided' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from users u where u.id = new.decided_by and u.household_id = new.household_id) then
    raise exception 'a proposal is decided by a user of its own household' using errcode = 'check_violation';
  end if;
  if new.status = 'approved' and not exists (
      select 1 from document_attachments a
      where a.household_id = new.household_id and a.id = new.attachment_id and a.document_id = new.document_id
        and a.document_version_id = new.document_version_id and a.target_type = new.target_type
        and a.target_id = coalesce(new.bill_id, new.visit_id)) then
    raise exception 'an approval must name the attachment of that document version and target' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_match_proposals_guard_change before update or delete on document_match_proposals for each row execute function document_match_proposals_guard_change();

-- A new proposal is always pending and undecided, whoever inserts it. The MCP role holds INSERT, so a decision or an attachment
-- cannot be forged by inserting an already-decided row (which would also permanently block a genuine proposal).
create function document_match_proposals_guard_insert() returns trigger language plpgsql as $$
begin
  if new.status <> 'pending' or new.decided_by is not null or new.decided_at is not null or new.decision_note is not null
     or new.attachment_id is not null or new.version <> 1 then
    raise exception 'a new proposal is pending and undecided' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_match_proposals_guard_insert before insert on document_match_proposals for each row execute function document_match_proposals_guard_insert();

-- The MCP role can insert audit rows (it records its own tool calls) but only its own kinds, never in a person's name. The role is
-- recognised by what it cannot do: it cannot read accounts, which the web role always can.
create function audit_events_guard_restricted_insert() returns trigger language plpgsql as $$
begin
  if not has_table_privilege(current_user, 'users', 'SELECT') then
    if new.actor_user_id is not null
       or new.action not in ('mcp.tool_called', 'mcp.tool_refused', 'mcp.document_content_read', 'proposal.created')
       or new.entity_type not in ('mcp_client', 'document', 'document_match_proposal') then
      raise exception 'the assistant role may only record its own tool calls and proposals' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger audit_events_guard_restricted_insert before insert on audit_events for each row execute function audit_events_guard_restricted_insert();

create function document_match_proposals_no_truncate() returns trigger language plpgsql as $$
begin
  raise exception 'proposals cannot be truncated' using errcode = 'check_violation';
end $$;
create trigger document_match_proposals_no_truncate before truncate on document_match_proposals for each statement execute function document_match_proposals_no_truncate();
create trigger mcp_clients_no_truncate before truncate on mcp_clients for each statement execute function document_match_proposals_no_truncate();

-- MCP database role -------------------------------------------------------------------------------------------------------
-- The MCP listener connects as a separate role that can read only what its tools return and write only proposals, its own
-- last-used time and audit rows. It sees only the listed columns of documents, bills, visits and adjustment amounts, cannot read users, sessions, payments or
-- HSA records, and cannot write money, documents, attachments or accounts. The role is created by the operator (`npm run mcp -w @tallymed/web -- setup-role`),
-- not by a migration, because a migration must not choose a password. This function (re)applies the grants and is run by
-- that command and again here when the role already exists.
create function tallymed_apply_mcp_grants(role_name text) returns void language plpgsql as $$
begin
  execute format('revoke all on all tables in schema public from %I', role_name);
  execute format('revoke all on all sequences in schema public from %I', role_name);
  execute format('revoke all on all functions in schema public from %I', role_name);
  execute format('grant usage on schema public to %I', role_name);
  execute format('grant select (id, household_id, title, kind, note, version, removed_at, created_at) on documents to %I', role_name);
  execute format('grant select (id, household_id, document_id, version_no, storage_key, sha256, size_bytes, media_type, original_name, state, created_at) on document_versions to %I', role_name);
  execute format('grant select (household_id, document_id, document_version_id, target_type, target_id, detached_at) on document_attachments to %I', role_name);
  execute format('grant select (id, household_id, provider_reference, statement_date, due_date, amount_status, base_responsibility_cents, member_name_snapshot, provider_name_snapshot, version) on bills to %I', role_name);
  execute format('grant select (household_id, bill_id, amount_cents) on bill_adjustments to %I', role_name);
  execute format('grant select (id, household_id, service_date, description, member_name_snapshot, provider_name_snapshot, version) on visits to %I', role_name);
  execute format('grant select (id, household_id, name, token_hash, scopes, expires_at, revoked_at, last_used_at) on mcp_clients to %I', role_name);
  -- Not the reviewer's decision note, the reviewer or the attachment: the role never needs to read what people typed or who decided.
  execute format('grant select (id, household_id, client_id, document_id, document_version_id, document_version_no, target_type, bill_id, visit_id, target_id, target_version, rationale, confidence, status, decided_at, version, created_at) on document_match_proposals to %I', role_name);
  execute format('grant insert on document_match_proposals, audit_events to %I', role_name);
  execute format('grant update (last_used_at) on mcp_clients to %I', role_name);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'tallymed_mcp') then
    perform tallymed_apply_mcp_grants('tallymed_mcp');
  end if;
end $$;
