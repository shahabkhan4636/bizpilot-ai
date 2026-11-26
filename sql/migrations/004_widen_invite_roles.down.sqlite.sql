-- 004 (SQLite) down — back to the original invite roles.
create table if not exists org_invites_old (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  token_hash text not null unique,
  invited_by text references profiles(id) on delete set null,
  expires_at text not null,
  accepted_at text,
  created_at text not null,
  constraint org_invites_role_check check (role in ('owner','admin','member'))
);
insert into org_invites_old (id, organization_id, email, role, token_hash, invited_by, expires_at, accepted_at, created_at)
  select id, organization_id, email,
         case when role in ('owner','admin') then role else 'member' end,
         token_hash, invited_by, expires_at, accepted_at, created_at
    from org_invites;
drop table org_invites;
alter table org_invites_old rename to org_invites;
create index if not exists org_invites_org_idx on org_invites (organization_id);
create index if not exists org_invites_email_idx on org_invites (email);
