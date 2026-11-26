-- 002 — roles, email verification, notifications, CRM tags, proposal financials.
-- Portable SQL: runs unchanged on SQLite and PostgreSQL.

-- NOTE: widening the role CHECK constraint cannot be done in portable SQL
-- (SQLite needs a table rebuild, Postgres can alter the constraint in place),
-- so it lives in migration 003 with engine-specific files.

-- ---------------------------------------------------------------------------
-- 2. Email verification
-- ---------------------------------------------------------------------------
alter table profiles add column email_verified_at text;

create table if not exists email_verifications (
  id text primary key,
  user_id text not null references profiles(id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  expires_at text not null,
  used_at text,
  created_at text not null
);
create index if not exists email_verifications_user_idx on email_verifications (user_id);

-- ---------------------------------------------------------------------------
-- 3. Notifications: type, deep link, read state
-- ---------------------------------------------------------------------------
-- (level and read_at already exist from 001; these add the machine-readable
--  kind and a deep link so a notification can take the reader to the record.)
alter table notifications add column type text not null default 'info';
alter table notifications add column href text;

-- ---------------------------------------------------------------------------
-- 4. CRM: lead tags
-- ---------------------------------------------------------------------------
alter table leads add column tags text not null default '';

-- ---------------------------------------------------------------------------
-- 5. Proposals: discount, currency, expiring share links, client comment
-- ---------------------------------------------------------------------------
alter table proposals add column discount_cents integer not null default 0;
alter table proposals add column discount_percent integer not null default 0;
alter table proposals add column share_expires_at text;
alter table proposals add column client_comment text;

-- ---------------------------------------------------------------------------
-- 6. Indexes for the queries the app actually runs (org + time ordering,
--    lookups by token / email, unread notification counts).
-- ---------------------------------------------------------------------------
create index if not exists leads_org_created_idx on leads (organization_id, created_at);
create index if not exists leads_org_status_idx on leads (organization_id, status);
create index if not exists leads_email_idx on leads (email);
create index if not exists customers_org_created_idx on customers (organization_id, created_at);
create index if not exists proposals_org_created_idx on proposals (organization_id, created_at);
create index if not exists proposals_share_token_idx on proposals (share_token);
create index if not exists documents_org_created_idx on documents (organization_id, created_at);
create index if not exists messages_org_status_idx on messages (organization_id, status);
create index if not exists notifications_user_read_idx on notifications (user_id, read_at);
create index if not exists automation_executions_org_created_idx on automation_executions (organization_id, created_at);
create index if not exists audit_logs_org_created_idx on audit_logs (organization_id, created_at);
create index if not exists sessions_expires_idx on sessions (expires_at);
create index if not exists tasks_org_due_idx on tasks (organization_id, due_at);
