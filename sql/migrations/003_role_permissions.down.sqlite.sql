-- 003 (SQLite) down — back to the original three roles.
create table if not exists organization_members_old (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references profiles(id) on delete cascade,
  role text not null default 'member',
  created_at text not null,
  unique (organization_id, user_id),
  constraint organization_members_role_check check (role in ('owner','admin','member'))
);
insert into organization_members_old (id, organization_id, user_id, role, created_at)
  select id, organization_id, user_id,
         case when role in ('owner','admin') then role else 'member' end,
         created_at
    from organization_members;
drop table organization_members;
alter table organization_members_old rename to organization_members;
create index if not exists organization_members_org_idx on organization_members (organization_id);
create index if not exists organization_members_user_idx on organization_members (user_id);
