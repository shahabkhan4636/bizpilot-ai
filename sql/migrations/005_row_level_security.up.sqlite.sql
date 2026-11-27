-- 005 — Row Level Security: SQLite has no policies.
--
-- Isolation on SQLite comes from the query layer (every statement is scoped by
-- organization_id), which the test suite asserts. The Postgres variant of this
-- migration creates the same 83 policies the production database runs on.
select 1;
