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
