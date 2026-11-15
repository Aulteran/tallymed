-- A payment plan can cover confirmed bills from several providers.
--
-- Why: one hospital often bills the same visit under different provider names (facility, physician, radiology). A plan is the
-- household's agreement about what it owes and when, so its scope is the set of bills it covers, not a single provider.
--
-- Data model: `payment_plans.provider_id` is dropped. The providers of a plan are derived from its bills
-- (payment_plan_bills -> bills.provider_id), so there is no second copy that could disagree. The plan's display label is its
-- name plus its payee, built by the application from the providers' names ("A", or "A and N more" in the list).
--
-- Trigger: a plan still covers only bills with confirmed amounts of its own household (the composite foreign key keeps the
-- household); the "same provider" rule is the only rule removed. Plan bills stay append-only and bills still cannot be added
-- after creation, so matches (which reference allocations on the plan's bills) keep working unchanged: the foreign key from
-- installment_matches to payment_plan_bills already limits matches to the plan's bills, whatever their provider.
--
-- Backfill: none is needed. Every existing plan already has bills of exactly one provider (the old trigger guaranteed it), and
-- that provider is exactly what the derived label shows. The migration asserts this before dropping the column, so a database
-- that somehow violates it fails loudly instead of losing the link.
--
-- Rollback (manual, only valid while no plan has bills of several providers):
--   alter table payment_plans add column provider_id uuid;
--   update payment_plans p set provider_id = (select min(b.provider_id::text)::uuid from payment_plan_bills pb
--     join bills b on b.household_id = pb.household_id and b.id = pb.bill_id where pb.plan_id = p.id);
--   alter table payment_plans alter column provider_id set not null,
--     add foreign key (household_id, provider_id) references providers (household_id, id);
--   create index payment_plans_provider_idx on payment_plans (household_id, provider_id);
--   then re-create payment_plan_bills_validate() as in 0005 (join on b.provider_id = p.provider_id).
-- Nothing in the ledger (payments, allocations, matches, installments) changes in either direction.

do $$
declare
  bad uuid;
begin
  select p.id into bad from payment_plans p
    where exists (select 1 from payment_plan_bills pb join bills b on b.household_id = pb.household_id and b.id = pb.bill_id
                  where pb.plan_id = p.id and b.provider_id <> p.provider_id)
    limit 1;
  if bad is not null then
    raise exception 'plan % has a bill from another provider; refusing to drop payment_plans.provider_id', bad;
  end if;
end $$;

drop index payment_plans_provider_idx;
alter table payment_plans drop column provider_id;

create or replace function payment_plan_bills_validate() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from payment_plans p join bills b on b.household_id = p.household_id
                 where p.id = new.plan_id and b.id = new.bill_id and b.amount_status = 'confirmed') then
    raise exception 'a plan covers only confirmed bills' using errcode = 'check_violation';
  end if;
  return new;
end $$;
