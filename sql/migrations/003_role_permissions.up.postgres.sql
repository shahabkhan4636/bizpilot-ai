-- 003 (Postgres) — widen organization_members.role to include manager and viewer.
-- Postgres can alter the constraint in place; no table rebuild (and therefore no
-- conflict with the RLS policies that reference this table).
alter table organization_members drop constraint if exists organization_members_role_check;
alter table organization_members add constraint organization_members_role_check
  check (role in ('owner','admin','manager','member','viewer'));
