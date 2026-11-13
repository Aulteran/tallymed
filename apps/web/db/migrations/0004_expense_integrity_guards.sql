-- Database backstops for the money invariants that the services enforce under the bill row lock. They make the rules
-- hold for direct SQL, future writers and scripts as well: confirmed amounts are immutable, and household
-- responsibility (base + signed adjustments) is never negative or above the supported maximum.

-- Confirmed amounts change only through adjustments. Once confirmed, a bill cannot go back to an estimate, change its
-- billed or base amounts, or lose its confirmation record, and cannot be deleted.
create function bills_confirmed_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.amount_status = 'confirmed' then
      raise exception 'a confirmed bill cannot be deleted' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.amount_status = 'confirmed' and (
       new.amount_status <> 'confirmed'
    or new.original_cents <> old.original_cents
    or new.base_responsibility_cents <> old.base_responsibility_cents
    or new.confirmed_at is distinct from old.confirmed_at
    or new.confirmed_by is distinct from old.confirmed_by) then
    raise exception 'confirmed amounts change only through adjustments' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger bills_confirmed_amounts before update or delete on bills
  for each row execute function bills_confirmed_guard();

-- Responsibility must stay between zero and the supported maximum. The check runs at commit, so a transaction may pass
-- through intermediate states. It locks the bill row first, so concurrent transactions are checked one after the other
-- against each other's committed rows (the services already hold a stronger lock, so for them this takes no extra wait).
create function bill_responsibility_guard() returns trigger language plpgsql as $$
declare
  target uuid;
  total bigint;
begin
  if tg_table_name = 'bills' then target := new.id; else target := new.bill_id; end if;
  -- Lock in its own statement: after waiting for another writer, the next statement takes a fresh snapshot and sees its rows.
  -- FOR NO KEY UPDATE serializes the checks without conflicting with the key-share locks that foreign-key inserts take.
  perform 1 from bills where id = target for no key update;
  select b.base_responsibility_cents + coalesce((select sum(a.amount_cents) from bill_adjustments a where a.bill_id = b.id), 0)
    into total from bills b where b.id = target;
  if total is not null and (total < 0 or total > 10000000000000) then
    raise exception 'household responsibility must stay between zero and the supported maximum (bill %, would be % cents)', target, total
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger bill_adjustments_responsibility after insert on bill_adjustments
  deferrable initially deferred for each row execute function bill_responsibility_guard();
create constraint trigger bills_responsibility after update of base_responsibility_cents on bills
  deferrable initially deferred for each row execute function bill_responsibility_guard();
