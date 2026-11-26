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
