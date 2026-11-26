-- ===========================================================================
-- BizPilot AI — Production schema for Supabase / PostgreSQL
-- Run with:  supabase db push   OR   psql "$DATABASE_URL" -f sql/schema.postgres.sql
-- Every table is tenant-scoped through organizations and protected by RLS.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type member_role as enum ('owner','admin','member');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lead_status as enum ('new','contacted','qualified','proposal_sent','negotiation','won','lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type proposal_status as enum ('draft','sent','accepted','rejected','expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type subscription_status as enum ('trialing','active','past_due','canceled','incomplete','unpaid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type automation_run_status as enum ('queued','running','succeeded','failed','skipped');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- profiles  (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  is_super_admin boolean not null default false,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_email_idx on profiles (lower(email));

-- ---------------------------------------------------------------------------
-- organizations (tenant root)
-- ---------------------------------------------------------------------------
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  business_type text,
  country text default 'US',
  website text,
  phone text,
  timezone text not null default 'UTC',
  currency text not null default 'USD',
  logo_url text,
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role member_role not null default 'member',
  invited_email text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists org_members_user_idx on organization_members (user_id);
create index if not exists org_members_org_idx on organization_members (organization_id);

-- ---------------------------------------------------------------------------
-- plans + subscriptions
-- ---------------------------------------------------------------------------
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,               -- starter | professional | business | agency
  name text not null,
  price_monthly_cents integer not null default 0,
  price_annual_cents integer not null default 0,
  lead_limit integer not null default 100,
  member_limit integer not null default 1,
  ai_generation_limit integer not null default 20,
  automation_limit integer not null default 0,
  document_limit integer not null default 10,
  features jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  plan_code text not null references plans(code),
  status subscription_status not null default 'trialing',
  stripe_customer_id text,
  stripe_subscription_id text unique,
  stripe_price_id text,
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly','annual')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);
create index if not exists subscriptions_stripe_customer_idx on subscriptions (stripe_customer_id);

-- ---------------------------------------------------------------------------
-- CRM: customers + leads
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  company text,
  address text,
  notes text,
  lifetime_value_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists customers_org_idx on customers (organization_id) where deleted_at is null;
create index if not exists customers_email_idx on customers (organization_id, lower(email));

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  assigned_to uuid references profiles(id) on delete set null,
  name text not null,
  email text,
  phone text,
  company text,
  source text not null default 'manual',
  status lead_status not null default 'new',
  value_cents integer not null default 0,
  notes text,
  ai_score integer,
  ai_score_reason text,
  ai_next_action text,
  ai_scored_at timestamptz,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists leads_org_status_idx on leads (organization_id, status) where deleted_at is null;
create index if not exists leads_org_created_idx on leads (organization_id, created_at desc) where deleted_at is null;
create index if not exists leads_assigned_idx on leads (assigned_to);
create index if not exists leads_email_idx on leads (organization_id, lower(email));

create table if not exists lead_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  author_id uuid references profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists lead_notes_lead_idx on lead_notes (lead_id, created_at desc);

create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_id uuid references profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activities_org_created_idx on activities (organization_id, created_at desc);
create index if not exists activities_entity_idx on activities (entity_type, entity_id);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  assigned_to uuid references profiles(id) on delete set null,
  lead_id uuid references leads(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  title text not null,
  details text,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tasks_org_due_idx on tasks (organization_id, due_at);
create index if not exists tasks_open_idx on tasks (organization_id) where completed_at is null;

-- ---------------------------------------------------------------------------
-- Proposals
-- ---------------------------------------------------------------------------
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  title text not null,
  client_name text not null,
  client_email text,
  summary text,
  scope text,
  terms text,
  currency text not null default 'USD',
  subtotal_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  status proposal_status not null default 'draft',
  share_token text unique,
  version integer not null default 1,
  accepted_at timestamptz,
  rejected_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proposals_org_created_idx on proposals (organization_id, created_at desc);
create index if not exists proposals_share_token_idx on proposals (share_token);

create table if not exists proposal_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  proposal_id uuid not null references proposals(id) on delete cascade,
  description text not null,
  quantity numeric(12,2) not null default 1,
  unit_price_cents integer not null default 0,
  amount_cents integer not null default 0,
  sort_order integer not null default 0
);
create index if not exists proposal_items_proposal_idx on proposal_items (proposal_id, sort_order);

-- ---------------------------------------------------------------------------
-- Automation engine
-- ---------------------------------------------------------------------------
create table if not exists automations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  trigger_type text not null,
  conditions jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  run_limit_per_day integer not null default 100,
  last_run_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists automations_org_trigger_idx on automations (organization_id, trigger_type) where is_active;

create table if not exists automation_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  automation_id uuid not null references automations(id) on delete cascade,
  step_order integer not null default 0,
  action_type text not null,
  config jsonb not null default '{}'::jsonb,
  requires_approval boolean not null default false
);
create index if not exists automation_steps_auto_idx on automation_steps (automation_id, step_order);

create table if not exists automation_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  automation_id uuid not null references automations(id) on delete cascade,
  trigger_entity_type text,
  trigger_entity_id uuid,
  idempotency_key text not null,
  status automation_run_status not null default 'queued',
  attempts integer not null default 0,
  log jsonb not null default '[]'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (automation_id, idempotency_key)
);
create index if not exists automation_exec_org_idx on automation_executions (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Documents, messages, notifications
-- ---------------------------------------------------------------------------
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  uploaded_by uuid references profiles(id) on delete set null,
  file_name text not null,
  mime_type text,
  size_bytes bigint not null default 0,
  storage_provider text not null default 'local' check (storage_provider in ('local','dropbox')),
  storage_path text not null,
  status text not null default 'ready',
  created_at timestamptz not null default now()
);
create index if not exists documents_org_idx on documents (organization_id, created_at desc);
create index if not exists documents_customer_idx on documents (customer_id);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  direction text not null check (direction in ('outbound','inbound')),
  channel text not null default 'email',
  subject text,
  body text not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','queued','sent','failed')),
  provider_message_id text,
  approved_by uuid references profiles(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists messages_org_idx on messages (organization_id, created_at desc);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  title text not null,
  body text,
  level text not null default 'info',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, read_at);

create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  email text not null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open','pending','closed')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Metering, audit, webhooks
-- ---------------------------------------------------------------------------
create table if not exists usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  metric text not null,
  quantity integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_org_metric_idx on usage_records (organization_id, metric, created_at desc);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  actor_id uuid references profiles(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  ip text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_org_idx on audit_logs (organization_id, created_at desc);

create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (provider, external_id)          -- duplicate webhook protection
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','organizations','plans','subscriptions','customers','leads','proposals','automations']
  loop
    execute format('drop trigger if exists trg_%s_updated on %s;', t, t);
    execute format('create trigger trg_%s_updated before update on %s for each row execute function set_updated_at();', t, t);
  end loop;
end $$;

-- ===========================================================================
-- ROW LEVEL SECURITY
-- ===========================================================================
alter table profiles              enable row level security;
alter table organizations         enable row level security;
alter table organization_members  enable row level security;
alter table plans                 enable row level security;
alter table subscriptions         enable row level security;
alter table leads                 enable row level security;
alter table lead_notes            enable row level security;
alter table customers             enable row level security;
alter table activities            enable row level security;
alter table tasks                 enable row level security;
alter table proposals             enable row level security;
alter table proposal_items        enable row level security;
alter table automations           enable row level security;
alter table automation_steps      enable row level security;
alter table automation_executions enable row level security;
alter table documents             enable row level security;
alter table messages              enable row level security;
alter table notifications         enable row level security;
alter table usage_records         enable row level security;
alter table audit_logs            enable row level security;
alter table webhook_events        enable row level security;
alter table support_tickets       enable row level security;

-- helper: organizations the current user belongs to (SECURITY DEFINER avoids RLS recursion)
create or replace function auth_user_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select organization_id from organization_members where user_id = auth.uid()
$$;

create or replace function is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_super_admin from profiles where id = auth.uid()), false)
$$;

-- profiles
drop policy if exists profiles_self_select on profiles;
create policy profiles_self_select on profiles for select using (id = auth.uid() or is_super_admin());
drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_self_insert on profiles;
create policy profiles_self_insert on profiles for insert with check (id = auth.uid());

-- plans are world-readable, only super-admin may modify
drop policy if exists plans_read on plans;
create policy plans_read on plans for select using (true);
drop policy if exists plans_admin_write on plans;
create policy plans_admin_write on plans for all using (is_super_admin()) with check (is_super_admin());

-- organizations
drop policy if exists orgs_member_select on organizations;
create policy orgs_member_select on organizations for select
  using (id in (select auth_user_org_ids()) or is_super_admin());
drop policy if exists orgs_owner_update on organizations;
create policy orgs_owner_update on organizations for update
  using (id in (select organization_id from organization_members where user_id = auth.uid() and role in ('owner','admin')) or is_super_admin());
drop policy if exists orgs_insert on organizations;
create policy orgs_insert on organizations for insert with check (true);

-- organization_members
drop policy if exists members_select on organization_members;
create policy members_select on organization_members for select
  using (organization_id in (select auth_user_org_ids()) or is_super_admin());
drop policy if exists members_admin_write on organization_members;
create policy members_admin_write on organization_members for all
  using (organization_id in (select organization_id from organization_members m where m.user_id = auth.uid() and m.role in ('owner','admin')) or is_super_admin())
  with check (organization_id in (select organization_id from organization_members m where m.user_id = auth.uid() and m.role in ('owner','admin')) or is_super_admin());

-- Tenant-scoped tables: one policy template each
do $$
declare t text;
begin
  foreach t in array array[
    'subscriptions','leads','lead_notes','customers','activities','tasks','proposals',
    'proposal_items','automations','automation_steps','automation_executions',
    'documents','messages','notifications','usage_records','audit_logs','support_tickets'
  ]
  loop
    execute format('drop policy if exists %I_tenant_select on %I;', t, t);
    execute format('create policy %I_tenant_select on %I for select using (organization_id in (select auth_user_org_ids()) or is_super_admin());', t, t);
    execute format('drop policy if exists %I_tenant_insert on %I;', t, t);
    execute format('create policy %I_tenant_insert on %I for insert with check (organization_id in (select auth_user_org_ids()));', t, t);
    execute format('drop policy if exists %I_tenant_update on %I;', t, t);
    execute format('create policy %I_tenant_update on %I for update using (organization_id in (select auth_user_org_ids())) with check (organization_id in (select auth_user_org_ids()));', t, t);
    execute format('drop policy if exists %I_tenant_delete on %I;', t, t);
    execute format('create policy %I_tenant_delete on %I for delete using (organization_id in (select auth_user_org_ids()) or is_super_admin());', t, t);
  end loop;
end $$;

-- public proposal read by share_token happens through the service role on the server,
-- never directly from the browser, so no anon policy is granted here.

-- webhook_events: service-role only
drop policy if exists webhook_admin on webhook_events;
create policy webhook_admin on webhook_events for select using (is_super_admin());
