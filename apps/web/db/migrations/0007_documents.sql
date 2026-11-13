-- Document management: private document metadata, immutable versions with checksums, and typed attachment links with history.
-- File bytes live outside PostgreSQL on a private volume under a server-generated opaque key; this schema holds only metadata.
-- Synthetic data only in tests. See docs/security.md (documents) and docs/contracts.md (attachments).
--
--   documents             one logical document (title, kind, note). Removal is a tombstone, never a delete.
--   document_versions     immutable content versions: opaque storage key, SHA-256, size and sniffed media type. Only the
--                         transition available -> purged (after the retention window) can ever change a row.
--   document_attachments  typed links from a document version to a bill, visit, bill adjustment, HSA receipt or HSA
--                         eligibility decision. One nullable foreign key per target type, so the database enforces that the
--                         target exists in the same household. A link is detached, never deleted: the row is link history.
--
-- Invariants held by the database (the services check first under locks):
--   * a removed document has no active attachment, even under concurrent attach and remove (deferred guard that takes the
--     document row lock first, as the money guards take the payment lock);
--   * an attachment points at an available (not purged) version of its own document;
--   * a document is attached to the same target at most once at a time;
--   * versions, attachments and removal never change except through their one allowed transition.

-- Eligibility decisions can be an attachment target; the composite key keeps the household boundary in the database.
alter table hsa_eligibility_decisions add constraint hsa_decisions_household_id_key unique (household_id, id);

create table documents (
  id uuid primary key,
  household_id uuid not null references households (id),
  title text not null check (char_length(title) between 1 and 120),
  kind text not null check (kind in ('bill', 'eob', 'receipt', 'statement', 'provider_letter', 'plan_document', 'other')),
  note text not null default '' check (char_length(note) <= 500),
  version integer not null default 1 check (version >= 1),
  removed_at timestamptz,
  removed_by uuid references users (id),
  removal_reason text check (removal_reason is null or char_length(removal_reason) between 1 and 300),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, id),
  check ((removed_at is null) = (removed_by is null) and (removed_at is null) = (removal_reason is null))
);
create index documents_household_idx on documents (household_id, created_at desc, id desc);

create table document_versions (
  id uuid primary key,
  household_id uuid not null references households (id),
  document_id uuid not null,
  version_no integer not null check (version_no >= 1),
  -- Server-generated random key. It is never derived from a file name and never appears in a URL.
  storage_key text not null check (storage_key ~ '^[0-9a-f]{32}$'),
  sha256 bytea not null check (octet_length(sha256) = 32),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  media_type text not null check (media_type in ('application/pdf', 'image/png', 'image/jpeg')),
  -- Sanitized display name only. Not used for storage, not copied into audit detail.
  original_name text not null check (char_length(original_name) between 1 and 120),
  state text not null default 'available' check (state in ('available', 'purged')),
  purged_at timestamptz,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (household_id, document_id) references documents (household_id, id),
  unique (document_id, version_no),
  unique (storage_key),
  unique (household_id, document_id, id),
  check ((state = 'purged') = (purged_at is not null))
);
create index document_versions_sha_idx on document_versions (household_id, sha256);

create table document_attachments (
  id uuid primary key,
  household_id uuid not null references households (id),
  document_id uuid not null,
  document_version_id uuid not null,
  target_type text not null check (target_type in ('bill', 'visit', 'bill_adjustment', 'hsa_receipt', 'hsa_eligibility_decision')),
  bill_id uuid,
  visit_id uuid,
  adjustment_bill_id uuid,
  adjustment_id uuid,
  hsa_receipt_id uuid,
  hsa_decision_id uuid,
  target_id uuid generated always as (coalesce(bill_id, visit_id, adjustment_id, hsa_receipt_id, hsa_decision_id)) stored,
  note text not null default '' check (char_length(note) <= 300),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  detached_at timestamptz,
  detached_by uuid references users (id),
  detach_reason text check (detach_reason is null or char_length(detach_reason) between 1 and 300),
  foreign key (household_id, document_id) references documents (household_id, id),
  foreign key (household_id, document_id, document_version_id) references document_versions (household_id, document_id, id),
  foreign key (household_id, bill_id) references bills (household_id, id),
  foreign key (household_id, visit_id) references visits (household_id, id),
  foreign key (household_id, adjustment_bill_id, adjustment_id) references bill_adjustments (household_id, bill_id, id),
  foreign key (household_id, hsa_receipt_id) references hsa_receipts (household_id, id),
  foreign key (household_id, hsa_decision_id) references hsa_eligibility_decisions (household_id, id),
  unique (household_id, id),
  -- Exactly the columns of the named target type are set.
  check (case target_type
    when 'bill' then bill_id is not null and num_nonnulls(visit_id, adjustment_bill_id, adjustment_id, hsa_receipt_id, hsa_decision_id) = 0
    when 'visit' then visit_id is not null and num_nonnulls(bill_id, adjustment_bill_id, adjustment_id, hsa_receipt_id, hsa_decision_id) = 0
    when 'bill_adjustment' then adjustment_id is not null and adjustment_bill_id is not null and num_nonnulls(bill_id, visit_id, hsa_receipt_id, hsa_decision_id) = 0
    when 'hsa_receipt' then hsa_receipt_id is not null and num_nonnulls(bill_id, visit_id, adjustment_bill_id, adjustment_id, hsa_decision_id) = 0
    when 'hsa_eligibility_decision' then hsa_decision_id is not null and num_nonnulls(bill_id, visit_id, adjustment_bill_id, adjustment_id, hsa_receipt_id) = 0
  end),
  check ((detached_at is null) = (detached_by is null) and (detached_at is null) = (detach_reason is null))
);
create index document_attachments_target_idx on document_attachments (household_id, target_type, target_id, created_at);
create index document_attachments_document_idx on document_attachments (household_id, document_id, created_at);
create index document_attachments_active_idx on document_attachments (document_id) where detached_at is null;
-- A document is attached to one target at most once at a time, even under concurrent requests.
create unique index document_attachments_one_active on document_attachments (document_id, target_type, target_id) where detached_at is null;

-- Immutability ------------------------------------------------------------------------------------------------------------

create function documents_guard_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'documents cannot be deleted; remove them (tombstone) instead' using errcode = 'check_violation';
  end if;
  if new.id <> old.id or new.household_id <> old.household_id or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'document identity cannot change' using errcode = 'check_violation';
  end if;
  if old.removed_at is not null and (new.removed_at is distinct from old.removed_at or new.removed_by is distinct from old.removed_by
      or new.removal_reason is distinct from old.removal_reason) then
    raise exception 'a removed document stays removed' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger documents_guard_change before update or delete on documents for each row execute function documents_guard_change();

create function document_versions_guard_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document versions are immutable' using errcode = 'check_violation';
  end if;
  if (new.id, new.household_id, new.document_id, new.version_no, new.storage_key, new.sha256, new.size_bytes, new.media_type, new.original_name, new.created_by, new.created_at)
     is distinct from (old.id, old.household_id, old.document_id, old.version_no, old.storage_key, old.sha256, old.size_bytes, old.media_type, old.original_name, old.created_by, old.created_at)
     or (old.state = 'purged' and new.state <> 'purged') or (old.state = 'purged' and new.purged_at is distinct from old.purged_at) then
    raise exception 'document versions are immutable; only available -> purged is allowed' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_versions_guard_change before update or delete on document_versions for each row execute function document_versions_guard_change();

create function document_attachments_guard_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attachment history is append-only; detach instead' using errcode = 'check_violation';
  end if;
  if old.detached_at is not null or new.detached_at is null
     or (new.id, new.household_id, new.document_id, new.document_version_id, new.target_type, new.bill_id, new.visit_id, new.adjustment_bill_id, new.adjustment_id,
         new.hsa_receipt_id, new.hsa_decision_id, new.note, new.created_by, new.created_at)
        is distinct from (old.id, old.household_id, old.document_id, old.document_version_id, old.target_type, old.bill_id, old.visit_id, old.adjustment_bill_id, old.adjustment_id,
         old.hsa_receipt_id, old.hsa_decision_id, old.note, old.created_by, old.created_at) then
    raise exception 'an attachment can only be detached, once' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_attachments_guard_change before update or delete on document_attachments for each row execute function document_attachments_guard_change();

create function document_tables_no_truncate() returns trigger language plpgsql as $$
begin
  raise exception '% cannot be truncated', tg_table_name using errcode = 'check_violation';
end $$;
create trigger documents_no_truncate before truncate on documents for each statement execute function document_tables_no_truncate();
create trigger document_versions_no_truncate before truncate on document_versions for each statement execute function document_tables_no_truncate();
create trigger document_attachments_no_truncate before truncate on document_attachments for each statement execute function document_tables_no_truncate();

-- A new attachment names a version that still has its bytes.
create function document_attachments_validate() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from document_versions where id = new.document_version_id and state = 'available') then
    raise exception 'an attachment must point at an available document version' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_attachments_validate before insert on document_attachments for each row execute function document_attachments_validate();

-- Commit-time guard ---------------------------------------------------------------------------------------------------------
-- Lock the document row in its own statement first (the service takes the same lock), so after waiting for a concurrent writer
-- the check below sees that writer's committed rows. Removing a document that gains an attachment at the same moment, or
-- attaching to a document being removed, fails one side at commit instead of leaving a removed document with live links.
create function document_removed_guard() returns trigger language plpgsql as $$
declare
  did uuid;
  gone boolean;
  live boolean;
begin
  if tg_table_name = 'documents' then
    did := new.id;
  else
    did := new.document_id;
  end if;
  perform 1 from documents where id = did for no key update;
  select removed_at is not null into gone from documents where id = did;
  select exists (select 1 from document_attachments where document_id = did and detached_at is null) into live;
  if gone and live then
    raise exception 'a removed document cannot have active attachments (document %)', did using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger documents_removed_guard after update of removed_at on documents
  deferrable initially deferred for each row execute function document_removed_guard();
create constraint trigger document_attachments_removed_guard after insert on document_attachments
  deferrable initially deferred for each row execute function document_removed_guard();
