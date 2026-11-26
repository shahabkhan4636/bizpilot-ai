-- ---------------------------------------------------------------------------
-- Local Postgres shim (development / CI only — NOT for production)
--
-- The production schema targets Supabase, where the `auth` schema, `auth.users`
-- and `auth.uid()` are provided by the platform. When you run the schema against
-- a plain PostgreSQL (or the PGlite engine used by `npm test`), those objects do
-- not exist. This file creates the minimum needed so RLS can be exercised for
-- real instead of being assumed to work.
--
-- `auth.uid()` reads the `request.jwt.claim.sub` setting, mirroring how Supabase
-- exposes the end-user id to Postgres.
-- ---------------------------------------------------------------------------

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')
$$;
