insert into plans (code, name, price_monthly_cents, price_annual_cents, lead_limit, member_limit,
                   ai_generation_limit, automation_limit, document_limit, features, is_active, sort_order)
values
  ('starter','Starter',2900,29000,100,1,50,0,10,
   '{"crm":true,"proposals":true,"ai_assistant":true,"automations":false,"documents":true,"analytics":"basic","multi_workspace":false}',1,1),
  ('professional','Professional',7900,79000,1000,3,500,10,100,
   '{"crm":true,"proposals":true,"ai_assistant":true,"automations":true,"documents":true,"analytics":"standard","multi_workspace":false}',1,2),
  ('business','Business',14900,149000,5000,10,2000,50,1000,
   '{"crm":true,"proposals":true,"ai_assistant":true,"automations":true,"documents":true,"analytics":"advanced","multi_workspace":false}',1,3),
  ('agency','Agency',29900,299000,25000,50,10000,200,5000,
   '{"crm":true,"proposals":true,"ai_assistant":true,"automations":true,"documents":true,"analytics":"advanced","multi_workspace":true,"white_label":true}',1,4)
on conflict (code) do update set
  name = excluded.name,
  price_monthly_cents = excluded.price_monthly_cents,
  price_annual_cents = excluded.price_annual_cents,
  lead_limit = excluded.lead_limit,
  member_limit = excluded.member_limit,
  ai_generation_limit = excluded.ai_generation_limit,
  automation_limit = excluded.automation_limit,
  document_limit = excluded.document_limit,
  features = excluded.features,
  sort_order = excluded.sort_order;
