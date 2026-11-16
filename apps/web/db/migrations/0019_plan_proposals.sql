-- Optional AI assistance: payment plan proposals. An MCP client with the separately granted `plans:propose` scope can suggest a payment plan
-- that is already in progress (the same data as the "Add a plan already in progress" form); a signed-in person reviews a full preview in the
-- app and approves or rejects it. Synthetic data only in tests. See docs/contracts.md (Assistant proposals) and .project/DECISIONS.md.
--
--   plan_proposals   one suggested plan. The payload is validated JSON (the strict schema in server/plan-proposal.ts, checked again at
--                    approval), `bill_versions` pins each bill's version when the client proposed, `note` is the client's untrusted rationale.
--                    A proposal changes nothing by itself: only a person approving it in the app creates the plan, with ordinary plan events.
--
-- Invariants held by the database (the services check first):
--   * a new proposal is pending and undecided, whoever inserts it (the MCP role holds INSERT on its own columns only);
--   * the payload, the pinned bill versions, the note, the client and the household never change; only the decision does, once;
--   * an approval names a plan of its own household that the deciding person created; a plan comes from at most one proposal;
--   * nothing is deleted or truncated.
-- `expired` and `superseded` are reserved states for a later release: nothing sets them yet.

-- A credential may now hold five scopes.
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'mcp_clients'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%proposals:create%' loop
    execute format('alter table mcp_clients drop constraint %I', c.conname);
  end loop;
end $$;
alter table mcp_clients add constraint mcp_clients_scopes_check check (
  cardinality(scopes) between 1 and 5
  and scopes <@ array['documents:read', 'records:read', 'documents:content', 'proposals:create', 'plans:propose']::text[]);

create table plan_proposals (
  id uuid primary key,
  household_id uuid not null references households (id),
  client_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768),
  bill_versions jsonb not null check (jsonb_typeof(bill_versions) = 'object'),
  -- Untrusted text written by the client. Displayed as plain text only.
  note text not null check (char_length(note) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  decided_by uuid references users (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) between 1 and 300),
  plan_id uuid,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  foreign key (household_id, client_id) references mcp_clients (household_id, id),
  foreign key (household_id, plan_id) references payment_plans (household_id, id),
  unique (household_id, id),
  check (case status
    when 'pending' then decided_by is null and decided_at is null and decision_note is null and plan_id is null
    when 'approved' then decided_by is not null and decided_at is not null and decision_note is null and plan_id is not null
    when 'rejected' then decided_by is not null and decided_at is not null and plan_id is null
    else decided_at is not null and decision_note is null and plan_id is null
  end)
);
create index plan_proposals_status_idx on plan_proposals (household_id, status, created_at desc, id desc);
create index plan_proposals_client_idx on plan_proposals (client_id, status, created_at desc);
create unique index plan_proposals_plan_once on plan_proposals (plan_id) where plan_id is not null;

create function plan_proposals_guard_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'plan proposals cannot be deleted' using errcode = 'check_violation';
  end if;
  if (new.id, new.household_id, new.client_id, new.payload, new.bill_versions, new.note, new.created_at)
     is distinct from (old.id, old.household_id, old.client_id, old.payload, old.bill_versions, old.note, old.created_at) then
    raise exception 'a plan proposal is immutable except for its decision' using errcode = 'check_violation';
  end if;
  if old.status <> 'pending' then
    raise exception 'a plan proposal is decided once' using errcode = 'check_violation';
  end if;
  if new.status = 'pending' then
    raise exception 'a pending plan proposal can only be decided' using errcode = 'check_violation';
  end if;
  if new.decided_by is not null and not exists (select 1 from users u where u.id = new.decided_by and u.household_id = new.household_id) then
    raise exception 'a plan proposal is decided by a user of its own household' using errcode = 'check_violation';
  end if;
  if new.status = 'approved' and not exists (
      select 1 from payment_plans p where p.household_id = new.household_id and p.id = new.plan_id and p.created_by = new.decided_by) then
    raise exception 'an approval must name the plan the approving person created' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger plan_proposals_guard_change before update or delete on plan_proposals for each row execute function plan_proposals_guard_change();

-- A new proposal is always pending and undecided, whoever inserts it (the MCP role holds INSERT).
create function plan_proposals_guard_insert() returns trigger language plpgsql as $$
begin
  if new.status <> 'pending' or new.decided_by is not null or new.decided_at is not null or new.decision_note is not null
     or new.plan_id is not null or new.version <> 1 then
    raise exception 'a new plan proposal is pending and undecided' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger plan_proposals_guard_insert before insert on plan_proposals for each row execute function plan_proposals_guard_insert();

create trigger plan_proposals_no_truncate before truncate on plan_proposals for each statement execute function document_match_proposals_no_truncate();

-- The MCP role may also record that it created a plan proposal, and nothing else new: approving and rejecting are a person's acts.
create or replace function audit_events_guard_restricted_insert() returns trigger language plpgsql as $$
begin
  if not has_table_privilege(current_user, 'users', 'SELECT') then
    if new.actor_user_id is not null
       or new.action not in ('mcp.tool_called', 'mcp.tool_refused', 'mcp.document_content_read', 'proposal.created', 'plan_proposal.created')
       or new.entity_type not in ('mcp_client', 'document', 'document_match_proposal', 'plan_proposal') then
      raise exception 'the assistant role may only record its own tool calls and proposals' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- MCP database role grants, with the plan proposal grants added (the 0008 grants are unchanged).
create or replace function tallymed_apply_mcp_grants(role_name text) returns void language plpgsql as $$
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
  -- Payment plan proposals (migration 0019). The role may insert a proposal's own columns (never its status, decision or created time) and read back
  -- only what the pending caps and its own listing need: not the payload, the note, who decided, or the plan a person made from it. It has no
  -- grant on any plan table, so a plan proposal is inert data until a signed-in person approves it in the app.
  execute format('grant insert (id, household_id, client_id, payload, bill_versions, note) on plan_proposals to %I', role_name);
  execute format('grant select (id, household_id, client_id, status, decided_at, created_at) on plan_proposals to %I', role_name);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'tallymed_mcp') then
    perform tallymed_apply_mcp_grants('tallymed_mcp');
  end if;
end $$;
