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
