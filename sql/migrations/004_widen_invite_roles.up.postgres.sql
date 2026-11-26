-- 004 (Postgres) — org_invites.role must accept the same roles as membership.
alter table org_invites drop constraint if exists org_invites_role_check;
update org_invites set role = 'member' where role not in ('owner','admin','manager','member','viewer');
alter table org_invites add constraint org_invites_role_check
  check (role in ('owner','admin','manager','member','viewer'));
