-- 006 down.
drop index if exists integration_credentials_org_idx;
drop table if exists integration_credentials;
drop index if exists automations_due_idx;
alter table automations drop column next_run_at;
alter table automations drop column schedule_interval_minutes;
