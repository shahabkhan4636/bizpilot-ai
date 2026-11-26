-- BizPilot AI — local development / demo schema (SQLite).
-- Mirrors sql/schema.postgres.sql closely enough that the same query layer works.
-- Tenant isolation is enforced in src/lib/db.ts (every query filters organization_id)
-- and by Postgres RLS in production.

create table if not exists profiles (
  id text primary key,
  email text not null unique,
  password_hash text,                      -- dev-mode credential auth only
  full_name text,
  is_super_admin integer not null default 0,
  onboarded_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists sessions (
  id text primary key,
  user_id text not null references profiles(id) on delete cascade,
  expires_at text not null,
  created_at text not null
);
create index if not exists sessions_user_idx on sessions(user_id);

create table if not exists password_resets (
  id text primary key,
  user_id text not null references profiles(id) on delete cascade,
  token_hash text not null,
  expires_at text not null,
  used_at text,
  created_at text not null
);
create index if not exists password_resets_token_idx on password_resets(token_hash);

create table if not exists organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  business_type text,
  country text default 'US',
  website text,
  phone text,
  timezone text not null default 'UTC',
  currency text not null default 'USD',
  suspended_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists org_invites (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner','admin','member')),
  token_hash text not null unique,
  invited_by text references profiles(id) on delete set null,
  expires_at text not null,
  accepted_at text,
  created_at text not null
);
create index if not exists org_invites_org_idx on org_invites(organization_id);
create index if not exists org_invites_email_idx on org_invites(email);

create table if not exists organization_members (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at text not null,
  unique (organization_id, user_id)
);
create index if not exists org_members_user_idx on organization_members(user_id);

create table if not exists plans (
  code text primary key,
  name text not null,
  price_monthly_cents integer not null default 0,
  price_annual_cents integer not null default 0,
  lead_limit integer not null default 100,
  member_limit integer not null default 1,
  ai_generation_limit integer not null default 20,
  automation_limit integer not null default 0,
  document_limit integer not null default 10,
  features text not null default '{}',
  is_active integer not null default 1,
  sort_order integer not null default 0
);

create table if not exists subscriptions (
  id text primary key,
  organization_id text not null unique references organizations(id) on delete cascade,
  plan_code text not null references plans(code),
  status text not null default 'trialing',
  stripe_customer_id text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  billing_cycle text not null default 'monthly',
  current_period_end text,
  cancel_at_period_end integer not null default 0,
  trial_ends_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists customers (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  name text not null,
  email text, phone text, company text, address text, notes text,
  lifetime_value_cents integer not null default 0,
  created_at text not null, updated_at text not null, deleted_at text
);
create index if not exists customers_org_idx on customers(organization_id);

create table if not exists leads (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  customer_id text references customers(id) on delete set null,
  assigned_to text references profiles(id) on delete set null,
  name text not null,
  email text, phone text, company text,
  source text not null default 'manual',
  status text not null default 'new'
    check (status in ('new','contacted','qualified','proposal_sent','negotiation','won','lost')),
  value_cents integer not null default 0,
  notes text,
  ai_score integer, ai_score_reason text, ai_next_action text, ai_scored_at text,
  last_contacted_at text, next_follow_up_at text,
  created_at text not null, updated_at text not null, deleted_at text
);
create index if not exists leads_org_status_idx on leads(organization_id, status);
create index if not exists leads_org_created_idx on leads(organization_id, created_at desc);

create table if not exists lead_notes (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  lead_id text not null references leads(id) on delete cascade,
  author_id text references profiles(id) on delete set null,
  body text not null,
  created_at text not null
);

create table if not exists activities (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  actor_id text references profiles(id) on delete set null,
  entity_type text not null, entity_id text,
  action text not null, summary text, metadata text not null default '{}',
  created_at text not null
);
create index if not exists activities_org_idx on activities(organization_id, created_at desc);

create table if not exists tasks (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  assigned_to text references profiles(id) on delete set null,
  lead_id text references leads(id) on delete cascade,
  customer_id text references customers(id) on delete cascade,
  title text not null, details text, due_at text, completed_at text,
  created_at text not null
);

create table if not exists proposals (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  customer_id text references customers(id) on delete set null,
  lead_id text references leads(id) on delete set null,
  created_by text references profiles(id) on delete set null,
  title text not null, client_name text not null, client_email text,
  summary text, scope text, terms text,
  currency text not null default 'USD',
  subtotal_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  status text not null default 'draft' check (status in ('draft','sent','accepted','rejected','expired')),
  share_token text unique, version integer not null default 1,
  accepted_at text, rejected_at text, expires_at text,
  created_at text not null, updated_at text not null
);

create table if not exists proposal_items (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  proposal_id text not null references proposals(id) on delete cascade,
  description text not null,
  quantity real not null default 1,
  unit_price_cents integer not null default 0,
  amount_cents integer not null default 0,
  sort_order integer not null default 0
);

create table if not exists automations (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  name text not null, description text,
  trigger_type text not null,
  conditions text not null default '[]',
  is_active integer not null default 1,
  run_limit_per_day integer not null default 100,
  last_run_at text,
  created_by text references profiles(id) on delete set null,
  created_at text not null, updated_at text not null
);

create table if not exists automation_steps (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  automation_id text not null references automations(id) on delete cascade,
  step_order integer not null default 0,
  action_type text not null,
  config text not null default '{}',
  requires_approval integer not null default 0
);

create table if not exists automation_executions (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  automation_id text not null references automations(id) on delete cascade,
  trigger_entity_type text, trigger_entity_id text,
  idempotency_key text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  log text not null default '[]', error text,
  started_at text, finished_at text, created_at text not null,
  unique (automation_id, idempotency_key)
);

create table if not exists documents (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  customer_id text references customers(id) on delete set null,
  uploaded_by text references profiles(id) on delete set null,
  file_name text not null, mime_type text, size_bytes integer not null default 0,
  storage_provider text not null default 'local',
  storage_path text not null,
  status text not null default 'ready',
  created_at text not null
);

create table if not exists messages (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  lead_id text references leads(id) on delete cascade,
  customer_id text references customers(id) on delete cascade,
  direction text not null default 'outbound',
  channel text not null default 'email',
  subject text, body text not null,
  status text not null default 'draft',
  provider_message_id text, approved_by text, sent_at text,
  created_at text not null
);

create table if not exists notifications (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id text references profiles(id) on delete cascade,
  title text not null, body text, level text not null default 'info',
  read_at text, created_at text not null
);

create table if not exists support_tickets (
  id text primary key,
  organization_id text references organizations(id) on delete set null,
  created_by text references profiles(id) on delete set null,
  email text not null, subject text not null, body text not null,
  status text not null default 'open', created_at text not null
);

create table if not exists usage_records (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  metric text not null, quantity integer not null default 1,
  metadata text not null default '{}', created_at text not null
);
create index if not exists usage_org_metric_idx on usage_records(organization_id, metric, created_at desc);

create table if not exists audit_logs (
  id text primary key,
  organization_id text references organizations(id) on delete set null,
  actor_id text references profiles(id) on delete set null,
  action text not null, target_type text, target_id text,
  ip text, user_agent text, metadata text not null default '{}',
  created_at text not null
);

create table if not exists webhook_events (
  id text primary key,
  provider text not null, external_id text not null,
  event_type text not null, payload text not null default '{}',
  processed_at text, error text, created_at text not null,
  unique (provider, external_id)
);

create table if not exists rate_limits (
  key text primary key,
  count integer not null default 0,
  window_start text not null
);
