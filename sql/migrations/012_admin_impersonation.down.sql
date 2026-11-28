drop index if exists impersonation_sessions_org_idx;
drop index if exists impersonation_sessions_admin_idx;
drop table if exists impersonation_sessions;
alter table organizations drop column suspended_by;
alter table organizations drop column suspension_reason;
