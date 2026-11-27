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
