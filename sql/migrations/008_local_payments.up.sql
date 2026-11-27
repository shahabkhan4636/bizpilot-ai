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
