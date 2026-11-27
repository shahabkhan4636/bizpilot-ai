-- 006 — Scheduled automations and per-workspace integration credentials.
--
-- Until now every trigger was an event (lead created, proposal accepted…). A
-- "run every N minutes" automation needs two columns to know when it is next due,
-- and the Dropbox connect flow needs somewhere to keep a workspace's token.

alter table automations add column schedule_interval_minutes integer;
alter table automations add column next_run_at text;

create index if not exists automations_due_idx on automations (trigger_type, is_active, next_run_at);

create table if not exists integration_credentials (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  provider text not null,
  access_token text,
  refresh_token text,
  expires_at text,
  account_label text,
  scopes text,
  created_by text references profiles(id) on delete set null,
  created_at text not null,
  updated_at text not null,
  constraint integration_credentials_unique unique (organization_id, provider)
);
create index if not exists integration_credentials_org_idx on integration_credentials (organization_id);
