-- BizPilot AI — consolidated schema snapshot (GENERATED FILE)
-- Source of truth: sql/migrations/*.up.sql. Regenerate with: npm run db:schema
-- 11 migration(s): 001_initial.up.sql, 002_roles_crm_notifications.up.sql, 003_role_permissions.up.sqlite.sql, 004_widen_invite_roles.up.sqlite.sql, 005_row_level_security.up.sqlite.sql, 006_scheduled_automations.up.sql, 007_proposal_responses.up.sql, 008_local_payments.up.sql, 009_payment_gateway_and_refunds.up.sql, 010_email_outbox.up.sql, 011_platform_payments.up.sql
--
-- Portable SQL: this exact file is applied to SQLite and to PostgreSQL, so the
-- two deployments cannot diverge. Tenant isolation is enforced in application
-- queries (organization_id) and, on Postgres, by sql/rls.postgres.sql.

-- ===== 001_initial.up.sql =====
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

-- ===== 002_roles_crm_notifications.up.sql =====
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

-- ===== 003_role_permissions.up.sqlite.sql =====
-- 003 (SQLite) — widen organization_members.role to include manager and viewer.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.
create table if not exists organization_members_new (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  role text not null default 'member',
  created_at text not null,
  unique (organization_id, user_id),
  -- named explicitly so a rebuilt table matches the constraint name that
  -- `alter table` produces in the Postgres variant
  constraint organization_members_role_check check (role in ('owner','admin','manager','member','viewer'))
);
insert into organization_members_new (id, organization_id, user_id, role, created_at)
  select id, organization_id, user_id, role, created_at from organization_members;
drop table organization_members;
alter table organization_members_new rename to organization_members;
create index if not exists organization_members_org_idx on organization_members (organization_id);
create index if not exists organization_members_user_idx on organization_members (user_id);

-- ===== 004_widen_invite_roles.up.sqlite.sql =====
-- 004 (SQLite) — org_invites.role must accept the same roles as membership.
-- Found by the viewer-invitation test: the constraint rejected 'viewer'.
create table if not exists org_invites_new (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  token_hash text not null unique,
  invited_by text references profiles(id) on delete set null,
  expires_at text not null,
  accepted_at text,
  created_at text not null,
  constraint org_invites_role_check check (role in ('owner','admin','manager','member','viewer'))
);
insert into org_invites_new (id, organization_id, email, role, token_hash, invited_by, expires_at, accepted_at, created_at)
  select id, organization_id, email, role, token_hash, invited_by, expires_at, accepted_at, created_at from org_invites;
drop table org_invites;
alter table org_invites_new rename to org_invites;
create index if not exists org_invites_org_idx on org_invites (organization_id);
create index if not exists org_invites_email_idx on org_invites (email);

-- ===== 005_row_level_security.up.sqlite.sql =====
-- 005 — Row Level Security: SQLite has no policies.
--
-- Isolation on SQLite comes from the query layer (every statement is scoped by
-- organization_id), which the test suite asserts. The Postgres variant of this
-- migration creates the same 83 policies the production database runs on.
select 1;

-- ===== 006_scheduled_automations.up.sql =====
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

-- ===== 007_proposal_responses.up.sql =====
-- 007 — Record *who* accepted or declined a public proposal.
--
-- Acceptance used to write only a status and a timestamp: the client's name went
-- into the activity log and nowhere else, so a proposal page could not show who
-- signed off. Declines had the same problem with the reason the client typed.
-- Both are needed for a real audit trail, so store them on the row.

alter table proposals add column accepted_by_name text;
alter table proposals add column rejected_reason text;

-- ===== 008_local_payments.up.sql =====
-- 008 — Local payments for Pakistan: SadaPay / JazzCash / EasyPaisa / bank transfer.
--
-- Stripe does not onboard Pakistani businesses, and SadaPay/JazzCash/EasyPaisa
-- merchant APIs need a SadaBiz/merchant approval nobody has on day one. What a
-- Pakistani SMB actually does is receive a transfer into their own wallet and
-- reconcile it by hand. That workflow needs two tables: where to send the money,
-- and what was claimed to have been sent.
--
-- Nothing here fakes a gateway: a request is 'pending' until a human approves it,
-- and only approval activates the plan.

create table if not exists local_payment_methods (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('sadapay','jazzcash','easypaisa','bank','other')),
  label text,
  account_title text not null,
  account_number text not null,
  payment_link text,
  instructions text,
  is_active integer not null default 1,
  created_by text references profiles(id) on delete set null,
  created_at text not null,
  updated_at text not null
);
create index if not exists local_payment_methods_org_idx on local_payment_methods (organization_id, is_active);

create table if not exists local_payment_requests (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  method_id text references local_payment_methods(id) on delete set null,
  plan_code text not null references plans(code),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly','annual')),
  amount_cents integer not null,
  currency text not null default 'PKR',
  reference text,
  payer_note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  submitted_by text references profiles(id) on delete set null,
  submitted_at text not null,
  reviewed_by text references profiles(id) on delete set null,
  reviewed_at text,
  review_note text
);
create index if not exists local_payment_requests_org_status_idx
  on local_payment_requests (organization_id, status, submitted_at desc);

-- ===== 009_payment_gateway_and_refunds.up.sql =====
-- 009 — Real gateway support on the local-payment rails, plus refunds.
--
-- 008 shipped the manual flow that works on day one (customer transfers, owner
-- approves). This migration adds the two things needed to make that same flow run
-- automatically the day a merchant account exists, and to correct a payment that
-- was approved by mistake:
--
--   * gateway_provider / gateway_payment_id / paid_at on the request, so a verified
--     webhook can be tied to exactly one claim (and replayed webhooks are no-ops).
--   * payment_refunds, so money going back to the customer is a recorded fact with
--     a reason and an author — never a silent status edit.

alter table local_payment_requests add column gateway_provider text;
alter table local_payment_requests add column gateway_payment_id text;
alter table local_payment_requests add column paid_at text;

create index if not exists local_payment_requests_gateway_idx
  on local_payment_requests (gateway_provider, gateway_payment_id);

create table if not exists payment_refunds (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  request_id text not null references local_payment_requests(id) on delete cascade,
  amount_cents integer not null,
  currency text not null default 'PKR',
  reason text,
  created_by text references profiles(id) on delete set null,
  created_at text not null
);
create index if not exists payment_refunds_org_idx on payment_refunds (organization_id, created_at desc);

-- ===== 010_email_outbox.up.sql =====
-- 010 — Email outbox.
--
-- Until now an email that could not be sent was reported to the UI and then
-- forgotten. In practice that loses a password-reset link the moment
-- RESEND_API_KEY is missing or Resend has a bad minute — the user is told
-- "not configured" and has no way back in.
--
-- Every transactional email is now written here first and only then dispatched:
--
--   queued  → written, waiting for an attempt (also the state when the provider
--             key is missing — the row survives until the key exists)
--   sent    → provider accepted it; provider id stored for support
--   failed  → every retry is spent; shown on /admin/email for a human decision
--
-- `attempts` and `next_attempt_at` implement the retry schedule (5 min, 30 min,
-- 2 hours). A provider error burns an attempt; a missing key deliberately does
-- NOT, because "not configured" is a deployment state, not a delivery failure.

create table if not exists email_outbox (
  id text primary key,
  organization_id text references organizations(id) on delete set null,
  to_email text not null,
  subject text not null,
  body_text text not null,
  kind text not null default 'other',
  status text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at text,
  last_error text,
  provider_message_id text,
  created_at text not null,
  updated_at text not null,
  sent_at text
);
create index if not exists email_outbox_status_idx on email_outbox (status, next_attempt_at);
create index if not exists email_outbox_created_idx on email_outbox (created_at desc);

-- ===== 011_platform_payments.up.sql =====
-- 011 — Platform payments: customers paying BizPilot, not customers' clients.
--
-- Migration 008 modelled the *workspace* side: an organisation stores its own
-- SadaPay/JazzCash/EasyPaisa/IBAN so its clients can pay it. That is a different
-- question from "how does a customer pay ME for a BizPilot subscription".
--
-- Three tables keep the two worlds apart on purpose:
--
--   platform_settings       one row: the platform owner's payout details, the
--                           demo-mode switch, and the Founding Member offer
--   platform_payment_claims a customer's claim that they transferred money to the
--                           PLATFORM; only a super-admin approves these
--   founding_memberships    a locked price for the first N customers, so "Rs 1,500
--                           forever" is a stored fact and not marketing copy
--
-- Nothing here fakes a gateway: a claim is 'pending' until a human approves it, and
-- only that approval moves a subscription.

create table if not exists platform_settings (
  id text primary key,
  sadapay_number text,
  jazzcash_number text,
  easypaisa_number text,
  bank_iban text,
  bank_name text,
  account_holder_name text,
  default_method text not null default 'sadapay' check (default_method in ('sadapay','jazzcash','easypaisa','bank','other')),
  instructions text,
  -- Owner testing: with this on, the platform owner's own claims are approved
  -- immediately (and flagged), so the flow can be exercised without a second person.
  demo_mode integer not null default 0,
  -- Founding Member offer: price in paisa (Rs 1,500 = 150000), how many, and the
  -- member limit they get (Starter limits with 3 seats, decided in PHASE-0).
  founding_member_price_cents integer not null default 150000,
  founding_member_slots integer not null default 10,
  founding_member_member_limit integer not null default 3,
  updated_at text not null,
  updated_by text references profiles(id) on delete set null
);

create table if not exists platform_payment_claims (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  plan_code text not null references plans(code),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly','annual')),
  amount_cents integer not null,
  currency text not null default 'PKR',
  method_kind text not null check (method_kind in ('sadapay','jazzcash','easypaisa','bank','other')),
  reference text not null,
  payer_note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  submitted_by text references profiles(id) on delete set null,
  submitted_at text not null,
  reviewed_by text references profiles(id) on delete set null,
  reviewed_at text,
  review_note text,
  -- True when the approver was the person who submitted (documented, not forbidden:
  -- at single-owner scale blocking it would lock the owner out of their own product).
  self_approved integer not null default 0,
  -- True when this claim granted/used the Founding Member price.
  founding_member integer not null default 0
);
create index if not exists platform_payment_claims_status_idx
  on platform_payment_claims (status, submitted_at desc);
create index if not exists platform_payment_claims_org_idx
  on platform_payment_claims (organization_id, submitted_at desc);

create table if not exists founding_memberships (
  id text primary key,
  organization_id text not null unique references organizations(id) on delete cascade,
  locked_price_cents integer not null,
  member_limit integer not null default 3,
  source text not null default 'auto' check (source in ('auto','manual')),
  note text,
  granted_by text references profiles(id) on delete set null,
  granted_at text not null
);
create index if not exists founding_memberships_granted_idx on founding_memberships (granted_at desc);
