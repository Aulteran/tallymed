-- A payment plan can say when it began, separately from when it was recorded.
--
-- `started_on` is the household's own date (UTC calendar date) for a plan that may have started in the past. It is a label and a
-- cut-off for matching earlier payments; it never changes a payment, an allocation or a balance. `created_at` and the audit trail
-- keep the real moment the record was entered. Existing plans take the UTC date they were recorded.
alter table payment_plans add column started_on date;
update payment_plans set started_on = (created_at at time zone 'UTC')::date;
alter table payment_plans alter column started_on set not null;
alter table payment_plans add check (started_on between date '1900-01-01' and date '2100-01-01');
