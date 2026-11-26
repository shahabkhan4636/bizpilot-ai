-- Reverses 002. Column drops work on SQLite 3.35+ and PostgreSQL.
drop index if exists tasks_org_due_idx;
drop index if exists sessions_expires_idx;
drop index if exists audit_logs_org_created_idx;
drop index if exists automation_executions_org_created_idx;
drop index if exists notifications_user_read_idx;
drop index if exists messages_org_status_idx;
drop index if exists documents_org_created_idx;
drop index if exists proposals_share_token_idx;
drop index if exists proposals_org_created_idx;
drop index if exists customers_org_created_idx;
drop index if exists leads_email_idx;
drop index if exists leads_org_status_idx;
drop index if exists leads_org_created_idx;

alter table proposals drop column client_comment;
alter table proposals drop column share_expires_at;
alter table proposals drop column discount_percent;
alter table proposals drop column discount_cents;

alter table leads drop column tags;

alter table notifications drop column href;
alter table notifications drop column type;

drop table if exists email_verifications;
alter table profiles drop column email_verified_at;
