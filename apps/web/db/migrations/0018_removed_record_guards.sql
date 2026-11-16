-- Two gaps left by 0017. Synthetic data only in tests.
--
--   1. A removed or voided payment could still gain an HSA eligibility decision (or a new claim reservation or external reimbursement)
--      through a direct write. Decisions are immutable, so the payment could then never be removed. New HSA exposure on such a payment is
--      now refused at commit, with the payment row lock taken first (the carried lock order), like hsa_refuse_direct_payment (0016, 0017).
--      Resolving what already exists stays possible: a receipt, rejection, cancellation or receipt reversal on an earlier claim is not
--      new exposure, so a voided payment that carried a claim before this migration can still be settled.
--   2. Cash matched to a removed plan counted as matched forever, so a removed cancelled plan kept that cash from every new plan and could
--      not be unmatched (it is hidden). A removed plan no longer counts as matched cash. Its match rows stay as history; restoring the plan
--      (undo) counts them again and the service releases whatever the cash no longer backs.
-- A restore of a backup loads rows with the tables' own triggers off, exactly as for the guards of 0016 and 0017, so history written before
-- this migration still restores.

-- HSA exposure on a removed or voided payment -----------------------------------------------------------------------------

create function hsa_refuse_removed_payment() returns trigger language plpgsql as $$
declare pid uuid;
begin
  if tg_table_name = 'hsa_entries' then
    -- Only new exposure (a claim reservation, an external reimbursement) is refused; settling an existing claim is not.
    if new.kind not in ('reserve', 'external_receipt') then
      return null;
    end if;
    pid := new.payment_id;
  else
    select a.payment_id into pid from payment_entries a where a.id = new.allocation_id;
  end if;
  perform 1 from payments where id = pid for no key update;
  if payment_is_removed(pid) then
    raise exception 'a removed payment takes no claims, reimbursements or eligibility decisions (payment %)', pid using errcode = 'check_violation';
  end if;
  if exists (select 1 from payment_voids v where v.payment_id = pid) then
    raise exception 'a voided payment takes no claims, reimbursements or eligibility decisions (payment %)', pid using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger hsa_entries_refuse_removed after insert on hsa_entries
  deferrable initially deferred for each row execute function hsa_refuse_removed_payment();
create constraint trigger hsa_decisions_refuse_removed after insert on hsa_eligibility_decisions
  deferrable initially deferred for each row execute function hsa_refuse_removed_payment();

-- Matches of a removed plan -----------------------------------------------------------------------------------------------

-- 0005's definition; the only change is that matches of a removed plan are not counted.
create or replace function allocation_match_check(pid uuid, alloc uuid) returns void language plpgsql as $$
declare
  remaining bigint;
  matched bigint;
begin
  perform 1 from payments where id = pid for no key update;
  select coalesce(sum(amount_cents), 0) into remaining from payment_entries where payment_id = pid and allocation_id = alloc;
  -- Across every plan that is not removed, so one allocation cannot be counted twice by two schedules.
  select coalesce(sum(m.amount_cents), 0) into matched from installment_matches m
    join plan_revisions r on r.id = m.revision_id
    join payment_plans p on p.id = m.plan_id
    where m.allocation_id = alloc and p.removed_at is null
      and r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = m.plan_id);
  if matched > remaining then
    raise exception 'plan matches would exceed what the allocation still holds (allocation %, remaining % cents)', alloc, remaining
      using errcode = 'check_violation';
  end if;
end $$;

-- Showing a removed plan again counts its matches again. Checked at commit for every allocation the plan matched, so a restore can never
-- leave an allocation matched above its net cash (the service releases the excess in the same transaction).
create function payment_plan_restore_guard() returns trigger language plpgsql as $$
declare m record;
begin
  for m in select distinct payment_id, allocation_id from installment_matches where plan_id = new.id order by payment_id, allocation_id loop
    perform allocation_match_check(m.payment_id, m.allocation_id);
  end loop;
  return null;
end $$;
create constraint trigger payment_plans_restore_guard after update of removed_at on payment_plans
  deferrable initially deferred for each row when (old.removed_at is not null and new.removed_at is null) execute function payment_plan_restore_guard();
