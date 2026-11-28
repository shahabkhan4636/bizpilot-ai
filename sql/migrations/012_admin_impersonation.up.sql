-- 012 — admin operations: suspension with a reason, and audited impersonation.
--
-- Suspending a workspace already existed (`organizations.suspended_at`) but it was a
-- bare timestamp: nobody could say afterwards *why* a customer lost access. A support
-- action without a recorded reason is indistinguishable from an accident, so the
-- reason and the actor are stored next to the timestamp.
--
-- Impersonation gets a table rather than a swapped session cookie. Replacing the
-- admin's own session with the customer's would mean "exit" depends on putting the
-- original session back — a bug there strands the owner inside someone else's
-- workspace. Instead the admin keeps their own session and an extra cookie points at
-- a row here: revocable, expiring, and the admin's identity is never lost.

alter table organizations add column suspension_reason text;
alter table organizations add column suspended_by text references profiles(id) on delete set null;

create table if not exists impersonation_sessions (
  id text primary key,
  admin_id text not null references profiles(id) on delete cascade,
  target_user_id text not null references profiles(id) on delete cascade,
  organization_id text not null references organizations(id) on delete cascade,
  -- read_only by default: viewing is the common case, writing is the exception.
  mode text not null default 'read_only' check (mode in ('read_only','write')),
  -- Set when the admin typed the confirmation word to unlock writes.
  write_acknowledged_at text,
  -- How many write actions were performed while impersonating (audit cross-check).
  write_count integer not null default 0,
  started_at text not null,
  expires_at text not null,
  ended_at text,
  end_reason text
);
create index if not exists impersonation_sessions_admin_idx on impersonation_sessions (admin_id, ended_at);
create index if not exists impersonation_sessions_org_idx on impersonation_sessions (organization_id, started_at desc);
