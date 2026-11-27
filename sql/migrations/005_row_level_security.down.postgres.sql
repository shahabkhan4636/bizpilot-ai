-- 005 down — drop every tenant policy and the helper functions they depend on.
do $$
declare r record;
begin
  for r in select policyname, schemaname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

drop schema if exists auth cascade;
