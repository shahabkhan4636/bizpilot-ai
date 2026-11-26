-- ---------------------------------------------------------------------------
-- BizPilot AI — Row Level Security for the portable schema (sql/schema.sqlite.sql)
--
-- The application connects with a role that owns these tables, so its own
-- queries bypass RLS (exactly like Supabase's service role). These policies
-- protect *every other* connection: an anon key, a read-only analytics user, a
-- support engineer with psql, or anything a browser can reach.
--
-- Apply AFTER the schema:
--   psql "$DATABASE_URL" -f sql/schema.sqlite.sql
--   psql "$DATABASE_URL" -f sql/seed_plans.sql
--   psql "$DATABASE_URL" -f sql/rls.postgres.sql
--
-- Set the caller per connection/transaction:
--   select set_config('request.jwt.claim.sub', '<profile id>', true);
-- ---------------------------------------------------------------------------

create schema if not exists auth;

create or replace function auth.uid()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')
$$;

/** Every workspace id the caller belongs to. */
create or replace function auth_user_org_ids()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(organization_id), array[]::text[])
    from organization_members
   where user_id = auth.uid()
$$;

create or replace function is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_super_admin = 1 from profiles p where p.id = auth.uid()),
    false
  )
$$;

-- ---------------------------------------------------------------------------
-- Tenant tables: rows are visible and writable only inside the caller's
-- workspaces. A super admin sees everything.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'subscriptions','customers','leads','lead_notes','activities','tasks','proposals',
    'proposal_items','automations','automation_steps','automation_executions',
    'documents','messages','notifications','support_tickets','usage_records',
    'audit_logs','org_invites'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_read', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_write', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_update', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_delete', t);

    execute format(
      'create policy %I on %I for select using (organization_id = any(auth_user_org_ids()) or is_super_admin())',
      t || '_tenant_read', t);
    execute format(
      'create policy %I on %I for insert with check (organization_id = any(auth_user_org_ids()))',
      t || '_tenant_write', t);
    execute format(
      'create policy %I on %I for update using (organization_id = any(auth_user_org_ids()))',
      t || '_tenant_update', t);
    execute format(
      'create policy %I on %I for delete using (organization_id = any(auth_user_org_ids()) or is_super_admin())',
      t || '_tenant_delete', t);
  end loop;
end $$;

-- organizations: a member may read their own workspace; only a super admin writes.
alter table organizations enable row level security;
drop policy if exists organizations_member_read on organizations;
create policy organizations_member_read on organizations for select
  using (id = any(auth_user_org_ids()) or is_super_admin());
drop policy if exists organizations_admin_write on organizations;
create policy organizations_admin_write on organizations for update using (is_super_admin());

-- organization_members: visible to fellow members of the same workspace.
alter table organization_members enable row level security;
drop policy if exists organization_members_read on organization_members;
create policy organization_members_read on organization_members for select
  using (organization_id = any(auth_user_org_ids()) or user_id = auth.uid() or is_super_admin());
drop policy if exists organization_members_manage on organization_members;
create policy organization_members_manage on organization_members for update using (is_super_admin());

-- profiles: yourself, people in your workspaces, or a super admin.
alter table profiles enable row level security;
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select
  using (
    id = auth.uid()
    or is_super_admin()
    or id in (select user_id from organization_members where organization_id = any(auth_user_org_ids()))
  );
drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update using (id = auth.uid() or is_super_admin());

-- plans are public pricing: readable by everyone, writable by nobody but the owner role.
alter table plans enable row level security;
drop policy if exists plans_public_read on plans;
create policy plans_public_read on plans for select using (true);

-- sessions and password resets are per-user.
alter table sessions enable row level security;
drop policy if exists sessions_owner on sessions;
create policy sessions_owner on sessions for all using (user_id = auth.uid() or is_super_admin());

alter table password_resets enable row level security;
drop policy if exists password_resets_owner on password_resets;
create policy password_resets_owner on password_resets for all using (user_id = auth.uid() or is_super_admin());

-- Provider plumbing: never exposed to a normal caller.
alter table webhook_events enable row level security;
drop policy if exists webhook_events_admin on webhook_events;
create policy webhook_events_admin on webhook_events for select using (is_super_admin());

alter table rate_limits enable row level security;
drop policy if exists rate_limits_admin on rate_limits;
create policy rate_limits_admin on rate_limits for select using (is_super_admin());
