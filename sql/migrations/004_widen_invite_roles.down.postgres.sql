-- 004 (Postgres) down.
alter table org_invites drop constraint if exists org_invites_role_check;
update org_invites set role = 'member' where role in ('manager','viewer');
alter table org_invites add constraint org_invites_role_check check (role in ('owner','admin','member'));
