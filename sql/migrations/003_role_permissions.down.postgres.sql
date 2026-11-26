-- 003 (Postgres) down — back to the original three roles.
alter table organization_members drop constraint if exists organization_members_role_check;
update organization_members set role = 'member' where role in ('manager','viewer');
alter table organization_members add constraint organization_members_role_check
  check (role in ('owner','admin','member'));
